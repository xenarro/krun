import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabasePostgres, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { type SqliteTables, Store, toRun } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Effect, Layer, Stream } from "effect";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { makePublicApp } from "./app.js";
import { cancelRunRoutes } from "./cancel-run-routes.js";
import { createRunRoutes } from "./create-run-routes.js";
import { runReadRoutes } from "./run-read-routes.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer(
    "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
  )
    .withName(`krun-test-p35-native-${randomBytes(6).toString("hex")}`)
    .withDatabase("krun_test_p35_native")
    .withPassword(randomBytes(32).toString("hex"))
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}, 120000);
afterAll(async () => {
  await postgres?.stop();
}, 120000);
for (const dialect of ["sqlite", "postgres"] as const)
  it.live(
    `native CreateRun/GetRun/CancelRun all states and concurrent actor CAS on real ${dialect}`,
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
            path: "krun-test-p35-native-keys",
            read: Effect.succeed(
              Buffer.from(
                JSON.stringify({
                  keys: [
                    {
                      name: "owner",
                      key: credentials.owner,
                      scopes: ["runs:read", "runs:write"],
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
            KRUN_NAMESPACE: "krun-test-p35-native",
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
          const logs: string[] = [];
          const app = yield* makePublicApp({
            routes: async (server) => {
              server.register(create);
              server.register(runReadRoutes);
              server.register(cancelRunRoutes);
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
          const call = async (path: string, who = "owner", body?: unknown) => {
            const r = await fetch(address + path, {
              method: body === undefined ? "GET" : "POST",
              headers: {
                authorization: `Bearer ${credentials[who]}`,
                "x-request-id": "krun-test-p35-native",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
              code: r.status,
              body: await r.json(),
              requestId: r.headers.get("x-request-id"),
            };
          };
          const events = (runId: string) =>
            Effect.tryPromise({
              try: () =>
                database.db
                  .withTables<SqliteTables>()
                  .selectFrom("run_events")
                  .select(["from_state", "to_state", "payload"])
                  .where("run_id", "=", runId)
                  .execute(),
              catch: () => new Error("Owned native event query failed"),
            });
          const payload = (value: unknown) =>
            typeof value === "string" ? JSON.parse(value) : value;
          let serial = 0;
          const createOwned = () =>
            Effect.gen(function* () {
              const input = JSON.parse(
                `{"n":${++serial},"nul":"\\u0000","__proto__":{"opaque":true}}`,
              );
              const response = yield* Effect.promise(() =>
                call("/v1/functions/alpha/runs", "owner", { input }),
              );
              expect(response.code).toBe(201);
              expect(response.body.input).toEqual(input);
              return {
                runId: response.body.name.split("/").at(-1) as string,
                path: `/v1/${response.body.name}`,
              };
            });
          for (const state of [
            "queued",
            "scheduled",
            "running",
            "cancelling",
            "cancelled",
            "succeeded",
            "failed",
          ] as const) {
            const target = yield* createOwned();
            if (state !== "queued") {
              yield* store.setJobToken(target.runId, "krun-test-p35-native-job", "b".repeat(64));
              yield* store.markScheduled(target.runId);
              if (state !== "scheduled") {
                yield* store.transition(target.runId, "scheduled", "running", null, {});
                yield* store.setResult(target.runId, false);
                if (state === "cancelling" || state === "cancelled")
                  yield* store.transition(
                    target.runId,
                    "running",
                    "cancelling",
                    null,
                    {},
                    { actor: "prior-actor" },
                  );
                if (state === "cancelled")
                  yield* store.transition(target.runId, "cancelling", "cancelled", null, {});
                if (state === "succeeded")
                  yield* store.transition(target.runId, "running", "succeeded", null, {});
                if (state === "failed")
                  yield* store.transition(target.runId, "running", "failed", "exit_code", {});
              }
            }
            const before = yield* events(target.runId);
            const response = yield* Effect.promise(() =>
              call(`${target.path}:cancel`, "owner", {}),
            );
            if (state === "succeeded" || state === "failed") {
              expect(response.code).toBe(400);
              expect(response.body.error.status).toBe("FAILED_PRECONDITION");
              expect(response.body.error.details[0]).toMatchObject({
                reason: "RUN_TERMINAL",
                metadata: { state: state.toUpperCase() },
              });
              expect(yield* events(target.runId)).toEqual(before);
            } else {
              expect(response.code).toBe(200);
              expect(response.body).toEqual(toRun(yield* store.getRun(target.runId)));
              expect(response.body.state).toBe(state === "cancelled" ? "CANCELLED" : "CANCELLING");
              expect(response.body.input.nul).toBe("\0");
              expect(Object.hasOwn(response.body.input, "__proto__")).toBe(true);
              expect(response.requestId).toBe("krun-test-p35-native");
              const after = yield* events(target.runId);
              expect(after.length - before.length).toBe(
                ["queued", "scheduled", "running"].includes(state) ? 1 : 0,
              );
              if (["queued", "scheduled", "running"].includes(state)) {
                const event = after.find((e) => e.to_state === "cancelling");
                expect(event?.from_state).toBe(state);
                expect(payload(event?.payload)).toEqual({ actor: "owner" });
              }
              const repeated = yield* Effect.promise(() =>
                call(`${target.path}:cancel`, "owner", {}),
              );
              expect(repeated.code).toBe(200);
              expect(repeated.body).toEqual(response.body);
              expect(yield* events(target.runId)).toEqual(after);
              const get = yield* Effect.promise(() => call(target.path));
              expect(get.code).toBe(200);
              expect(get.body).toEqual(response.body);
            }
          }
          const concurrent = yield* createOwned();
          const responses = yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: 20 }, () => call(`${concurrent.path}:cancel`, "owner", {})),
            ),
          );
          expect(responses.every((r) => r.code === 200 && r.body.state === "CANCELLING")).toBe(
            true,
          );
          expect(
            (yield* events(concurrent.runId)).filter((e) => e.to_state === "cancelling"),
          ).toHaveLength(1);
          const foreign = yield* createOwned();
          const denied = yield* Effect.promise(() =>
            call(`/v1/functions/-/runs/${foreign.runId}:cancel`, "other", {}),
          );
          expect(denied.code).toBe(404);
          expect(denied.body.error.details[0].reason).toBe("RUN_NOT_FOUND");
          expect((yield* store.getRun(foreign.runId)).state).toBe("queued");
          const scope = yield* Effect.promise(() => call(`${foreign.path}:cancel`, "reader", {}));
          expect(scope.code).toBe(403);
          const admin = yield* Effect.promise(() =>
            call(`/v1/functions/-/runs/${foreign.runId}:cancel`, "admin", {}),
          );
          expect(admin.code).toBe(200);
          expect(
            payload(
              (yield* events(foreign.runId)).find((e) => e.to_state === "cancelling")?.payload,
            ),
          ).toEqual({ actor: "admin" });
          expect(
            logs
              .map((line) => JSON.parse(line))
              .find(
                (line) =>
                  line.event === "http_request" &&
                  line.run_id === foreign.runId &&
                  line.key === "admin",
              ),
          ).toMatchObject({ function: "alpha", code: 200 });
          expect(Object.values(credentials).some((value) => logs.join("").includes(value))).toBe(
            false,
          );
          expect(logs.join("")).not.toContain('"nul"');
          yield* Effect.promise(() => app.close());
          expect(app.server.listening).toBe(false);
          expect((yield* store.getRun(foreign.runId)).state).toBe("cancelling");
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
