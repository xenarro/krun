import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabasePostgres, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { type State, Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import type { JsonValue } from "@krun/shared/dist/store/model.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, Stream } from "effect";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { makePublicApp } from "./app.js";
import { createRunRoutes } from "./create-run-routes.js";
import { functionReadRoutes } from "./function-routes.js";
import { runReadRoutes } from "./run-read-routes.js";
import { runResultRoutes } from "./run-result-routes.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer(
    "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
  )
    .withName(`krun-test-p36-native-${randomBytes(6).toString("hex")}`)
    .withDatabase("krun_test_p36_native")
    .withPassword(randomBytes(32).toString("hex"))
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}, 120000);
afterAll(async () => {
  await postgres?.stop();
}, 120000);
for (const dialect of ["sqlite", "postgres"] as const)
  it.live(
    `native CreateRun/GetRun/GetRunResult raw JSON and manual object-store redirect on real ${dialect}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const credentials = Object.fromEntries(
            ["owner", "other", "admin", "reader"].map((name) => [
              name,
              randomBytes(32).toString("hex"),
            ]),
          );
          const keys = yield* makeKeys({
            path: "krun-test-p36-native-keys",
            read: Effect.succeed(
              Buffer.from(
                JSON.stringify({
                  keys: [
                    {
                      name: "owner",
                      key: credentials.owner,
                      scopes: ["functions:read", "runs:read", "runs:write"],
                      functions: ["alpha"],
                    },
                    {
                      name: "other",
                      key: credentials.other,
                      scopes: ["runs:read", "runs:write"],
                      functions: ["*"],
                    },
                    { name: "admin", key: credentials.admin, scopes: ["admin"] },
                    {
                      name: "reader",
                      key: credentials.reader,
                      scopes: ["runs:read"],
                      functions: ["*"],
                    },
                  ],
                }),
              ),
            ),
          });
          const config = yield* parseGatewayConfig({
            KRUN_DB_MODE: "embedded",
            KRUN_NAMESPACE: "krun-test-p36-native",
          });
          const functions = yield* makeFunctions({
            namespace: config.KRUN_NAMESPACE,
            ceilings: {
              maxActiveDeadline: 86400,
              maxQueued: 1000,
              allowedRegistries: [],
              allowedServiceAccounts: ["krun-job-default"],
              webhookAllowedHosts: [],
            },
          }).pipe(
            Effect.provideService(FunctionSource, {
              watch: () =>
                Stream.succeed({
                  type: "sync" as const,
                  items: [
                    {
                      metadata: {
                        name: "alpha",
                        namespace: config.KRUN_NAMESPACE,
                        uid: "alpha",
                        generation: 1,
                        resourceVersion: "1",
                      },
                      spec: {
                        image: `example.invalid/job@sha256:${"a".repeat(64)}`,
                        inputSchema: {
                          type: "object",
                          properties: { n: { type: "integer" } },
                          required: ["n"],
                        },
                      },
                    },
                  ],
                }).pipe(Stream.concat(Stream.never)),
            }),
            Effect.provide(ReadinessLive(Effect.void)),
          );
          yield* functions.synced;
          const store = yield* Store;
          yield* store.migrate();
          const database = yield* Database;
          expect(database.dialect).toBe(dialect);
          const create = yield* createRunRoutes(config).pipe(
            Effect.provideService(DnsLookup, {
              lookup: () => Effect.succeed([{ address: "8.8.8.8", family: 4 }]),
            }),
          );
          const downloads: import("node:http").IncomingHttpHeaders[] = [];
          const objectServer = yield* Effect.acquireRelease(
            Effect.sync(() =>
              createServer((request, response) => {
                downloads.push({ ...request.headers });
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ downloaded: true, nested: [null, false] }));
              }),
            ),
            (server) =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          yield* Effect.promise(
            () => new Promise<void>((resolve) => objectServer.listen(0, "127.0.0.1", resolve)),
          );
          const endpoint = objectServer.address();
          if (!endpoint || typeof endpoint === "string")
            throw new Error("Owned object-store listener unavailable");
          const signed: { ref: string; ttl: number }[] = [];
          let signingTarget: string | undefined;
          const objectStore = {
            presignGet: (ref: string, ttl: 300) =>
              Effect.sync(() => {
                signed.push({ ref, ttl });
                return (
                  signingTarget ??
                  `http://127.0.0.1:${endpoint.port}/result.json?ttl=${ttl}&sequence=${signed.length}&canary=krun-test-p36-url-canary`
                );
              }),
          };
          const logs: string[] = [];
          const app = yield* makePublicApp({
            routes: async (server) => {
              server.register(create);
              server.register(functionReadRoutes(config));
              server.register(runReadRoutes);
              server.register(runResultRoutes(objectStore));
            },
          }).pipe(
            Effect.provideService(Keys, keys),
            Effect.provideService(Functions, functions),
            Effect.provideService(LogDestination, {
              write(line) {
                logs.push(line);
              },
            }),
          );
          const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
          const call = async (
            path: string,
            who = "owner",
            body?: unknown,
            redirect: "manual" | "follow" = "manual",
          ) => {
            const r = await fetch(address + path, {
              redirect,
              method: body === undefined ? "GET" : "POST",
              headers: {
                authorization: `Bearer ${credentials[who]}`,
                "x-request-id": "krun-test-p36-native",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await r.text();
            return {
              code: r.status,
              body: text.length ? JSON.parse(text) : undefined,
              text,
              location: r.headers.get("location"),
              cache: r.headers.get("cache-control"),
              contentType: r.headers.get("content-type"),
              requestId: r.headers.get("x-request-id"),
            };
          };
          // Use node:http rather than fetch: fetch prohibits GET payloads and
          // inject alone cannot prove native Content-Length/chunked parsing.
          const rawGet = (
            path: string,
            options: {
              body?: string;
              chunked?: boolean;
              zeroLength?: boolean;
              contentType?: string | false;
              who?: string | null;
            } = {},
          ) =>
            new Promise<{
              code: number | undefined;
              body: unknown;
              headers: import("node:http").IncomingHttpHeaders;
            }>((resolve, reject) => {
              const request = httpRequest(
                address + path,
                {
                  method: "GET",
                  headers: {
                    ...(options.who === null
                      ? {}
                      : { authorization: `Bearer ${credentials[options.who ?? "owner"]}` }),
                    ...(options.contentType === false
                      ? {}
                      : { "content-type": options.contentType ?? "application/json" }),
                    ...(options.chunked
                      ? { "transfer-encoding": "chunked" }
                      : options.body !== undefined || options.zeroLength
                        ? { "content-length": Buffer.byteLength(options.body ?? "") }
                        : {}),
                  },
                },
                (response) => {
                  let text = "";
                  response.setEncoding("utf8");
                  response.on("data", (chunk) => {
                    text += chunk;
                  });
                  response.once("error", reject);
                  response.once("end", () =>
                    resolve({
                      code: response.statusCode,
                      body: text ? JSON.parse(text) : undefined,
                      headers: response.headers,
                    }),
                  );
                },
              );
              request.once("error", reject);
              request.setTimeout(10000, () =>
                request.destroy(new Error("Owned native GET deadline")),
              );
              request.end(options.body);
            });
          let serial = 0;
          const createOwned = () =>
            Effect.gen(function* () {
              const input = { n: ++serial };
              const response = yield* Effect.promise(() =>
                call("/v1/functions/alpha/runs", "owner", { input }),
              );
              expect(response.code).toBe(201);
              return {
                runId: response.body.name.split("/").at(-1) as string,
                path: `/v1/${response.body.name}`,
              };
            });
          const move = (target: { runId: string }, state: State, value?: JsonValue, ref?: string) =>
            Effect.gen(function* () {
              if (state === "queued") return;
              yield* store.setJobToken(target.runId, "krun-test-p36-native-job", "b".repeat(64));
              yield* store.markScheduled(target.runId);
              if (state === "scheduled") return;
              yield* store.transition(target.runId, "scheduled", "running", null, {});
              if (value !== undefined) yield* store.setResult(target.runId, value);
              if (state === "running") return;
              if (state === "cancelling" || state === "cancelled") {
                yield* store.transition(target.runId, "running", "cancelling", null, {});
                if (state === "cancelled")
                  yield* store.transition(target.runId, "cancelling", "cancelled", null, {});
                return;
              }
              yield* store.transition(
                target.runId,
                "running",
                state,
                state === "failed" ? "exit_code" : null,
                ref === undefined ? {} : { result_ref: ref },
              );
            });
          for (const state of [
            "queued",
            "scheduled",
            "running",
            "cancelling",
            "succeeded",
            "failed",
            "cancelled",
          ] as const) {
            const target = yield* createOwned();
            const value =
              state === "succeeded" ? 0 : state === "cancelled" ? 'native "JSON"\0🧪' : false;
            yield* move(target, state, value);
            const before = yield* store.getRun(target.runId);
            const response = yield* Effect.promise(() => call(`${target.path}:getResult`));
            if (state === "succeeded" || state === "failed" || state === "cancelled") {
              expect(response.code).toBe(200);
              expect(response.body).toEqual(value);
              expect(response.text).toBe(JSON.stringify(value));
              expect(response.contentType).toMatch(/^application\/json/);
            } else {
              expect(response.code).toBe(400);
              expect(response.body.error.details[0].reason).toBe("RUN_NOT_TERMINAL");
            }
            expect(yield* store.getRun(target.runId)).toEqual(before);
            const get = yield* Effect.promise(() => call(target.path));
            expect(get.code).toBe(200);
            expect(get.body.name).toBe(target.path.slice(4));
          }
          expect(signed).toHaveLength(0);
          for (const state of ["succeeded", "failed", "cancelled"] as const) {
            const target = yield* createOwned();
            yield* move(target, state);
            const response = yield* Effect.promise(() => call(`${target.path}:getResult`));
            expect(response.code).toBe(404);
            expect(response.body.error.details[0].reason).toBe("RESULT_MISSING");
          }
          const target = yield* createOwned();
          const ref = `s3://krun-test-p36-native/runs/${target.runId}/result.json`;
          yield* move(target, "succeeded", undefined, ref);
          const redirected = yield* Effect.promise(() => call(`${target.path}:getResult`));
          expect(redirected.code).toBe(307);
          expect(redirected.text).toBe("");
          expect(redirected.cache).toBe("no-store");
          expect(redirected.requestId).toBe("krun-test-p36-native");
          expect(signed).toEqual([{ ref, ttl: 300 }]);
          expect(downloads).toHaveLength(0);
          if (!redirected.location) throw new Error("Owned redirect missing Location");
          const objectResponse = yield* Effect.promise(async () => {
            const response = await fetch(redirected.location ?? "", { redirect: "error" });
            return { code: response.status, body: await response.json() };
          });
          expect(objectResponse.code).toBe(200);
          expect(objectResponse.body).toEqual({ downloaded: true, nested: [null, false] });
          expect(downloads).toHaveLength(1);
          expect(downloads[0]?.authorization).toBeUndefined();
          expect(
            Object.keys(downloads[0] ?? {}).some(
              (k) => k.startsWith("x-krun") || k === "x-request-id",
            ),
          ).toBe(false);
          const repeated = yield* Effect.promise(() => call(`${target.path}:getResult`));
          expect(repeated.code).toBe(307);
          expect(signed).toHaveLength(2);
          expect(signed.every((v) => v.ref === ref && v.ttl === 300)).toBe(true);
          expect(repeated.location).not.toBe(redirected.location);
          const hidden = yield* Effect.promise(() =>
            call(`/v1/functions/-/runs/${target.runId}:getResult`, "other"),
          );
          expect(hidden.code).toBe(404);
          expect(hidden.body.error.details[0].reason).toBe("RUN_NOT_FOUND");
          expect(signed).toHaveLength(2);
          const invalid = yield* Effect.promise(() => call(`${target.path}:getResult?view=FULL`));
          expect(invalid.code).toBe(400);
          expect(signed).toHaveLength(2);
          const admin = yield* Effect.promise(() =>
            call(`/v1/functions/-/runs/${target.runId}:getResult`, "admin"),
          );
          expect(admin.code).toBe(307);
          expect(signed).toHaveLength(3);
          const inline = yield* createOwned();
          yield* move(inline, "succeeded", false);
          const beforeInline = yield* store.getRun(inline.runId);
          const beforeOffload = yield* store.getRun(target.runId);
          for (const [path, code] of [
            ["/v1/functions", 200],
            ["/v1/functions/alpha", 200],
            ["/v1/functions/alpha/runs", 200],
            [inline.path, 200],
            [`${inline.path}:getResult`, 200],
            [`${target.path}:getResult`, 307],
          ] as const) {
            // Omission remains omission with or without JSON headers/zero CL.
            for (const options of [{ contentType: false as const }, {}, { zeroLength: true }]) {
              const response = yield* Effect.promise(() => rawGet(path, options));
              expect(response.code).toBe(code);
            }
            for (const chunked of [false, true]) {
              expect(
                (yield* Effect.promise(() => rawGet(path, { body: "{}", chunked }))).code,
              ).toBe(code);
              for (const body of ['{"input":"krun-test-p36-private-body"}', "null", "{"]) {
                const count = signed.length;
                const response = yield* Effect.promise(() => rawGet(path, { body, chunked }));
                expect(response.code).toBe(400);
                expect(response.body).toMatchObject({
                  error: { status: "INVALID_ARGUMENT", details: [{ reason: "REQUEST_INVALID" }] },
                });
                expect(response.headers.location).toBeUndefined();
                expect(signed).toHaveLength(count);
              }
            }
          }
          for (const chunked of [false, true]) {
            const count = signed.length;
            const oversized = " ".repeat(app.initialConfig.bodyLimit ?? 1048576) + "{}";
            const response = yield* Effect.promise(() =>
              rawGet(`${target.path}:getResult`, { body: oversized, chunked }),
            );
            expect(response.code).toBe(413);
            expect(response.body).toMatchObject({
              error: { details: [{ reason: "INPUT_TOO_LARGE" }] },
            });
            expect(signed).toHaveLength(count);
          }
          for (const [who, path, code, reason] of [
            [null, `${target.path}:getResult`, 401, "KEY_MISSING"],
            ["invalid", `${target.path}:getResult`, 401, "KEY_INVALID"],
            ["reader", "/v1/functions/alpha", 403, "SCOPE_MISSING"],
          ] as const) {
            const count = signed.length;
            const response = yield* Effect.promise(() => rawGet(path, { body: "{", who }));
            expect(response.code).toBe(code);
            expect(response.body).toMatchObject({ error: { details: [{ reason }] } });
            expect(signed).toHaveLength(count);
          }
          const unsupported = yield* Effect.promise(() =>
            rawGet(`${target.path}:getResult`, { body: "{}", contentType: "text/plain" }),
          );
          expect(unsupported.code).toBe(415);
          expect(unsupported.body).toMatchObject({
            error: { details: [{ reason: "CONTENT_TYPE_UNSUPPORTED" }] },
          });
          expect(yield* store.getRun(inline.runId)).toEqual(beforeInline);
          expect(yield* store.getRun(target.runId)).toEqual(beforeOffload);
          // Client Location resolution must agree with standalone parsing. Both
          // manual and automatic follow stay on the original generic500, never
          // reinterpret an authority-less/backslash URL as a gateway path.
          for (const location of [
            `http:127.0.0.1:${endpoint.port}/result.json`,
            String.raw`http:\127.0.0.1:${endpoint.port}/result.json`,
          ]) {
            signingTarget = location;
            expect(new URL(location).origin).not.toBe(new URL(address).origin);
            expect(new URL(location, `${address}${target.path}:getResult`).origin).toBe(
              new URL(address).origin,
            );
            for (const redirect of ["manual", "follow"] as const) {
              const count = signed.length;
              const response = yield* Effect.promise(() =>
                call(`${target.path}:getResult`, "owner", undefined, redirect),
              );
              expect(response.code).toBe(500);
              expect(response.body.error.details[0].reason).toBe("INTERNAL");
              expect(response.location).toBeNull();
              expect(signed).toHaveLength(count + 1);
            }
          }
          signingTarget = undefined;
          expect(downloads).toHaveLength(1);
          expect(logs.join("")).not.toContain("krun-test-p36-private-body");
          expect(
            logs
              .map((s) => JSON.parse(s))
              .find((l) => l.event === "http_request" && l.key === "admin" && l.code === 307),
          ).toMatchObject({ function: "alpha", run_id: target.runId });
          expect(logs.join("")).not.toContain("krun-test-p36-url-canary");
          expect(Object.values(credentials).some((value) => logs.join("").includes(value))).toBe(
            false,
          );
          yield* Effect.promise(() => app.close());
          expect(app.server.listening).toBe(false);
          expect((yield* store.getRun(target.runId)).state).toBe("succeeded");
        }),
      ).pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provideMerge(
              dialect === "sqlite"
                ? DatabaseSqlite(":memory:")
                : DatabasePostgres(postgres.getConnectionUri()),
            ),
          ),
        ),
      ),
    30000,
  );
