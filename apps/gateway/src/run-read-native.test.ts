import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StorePostgres, StoreSqlite } from "@krun/shared/dist/store/live.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Effect, Stream } from "effect";
import { Wait } from "testcontainers";
import { afterAll, beforeAll } from "vitest";
import { makePublicApp } from "./app.js";
import { createRunRoutes } from "./create-run-routes.js";
import { runReadRoutes } from "./run-read-routes.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer(
    "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
  )
    .withDatabase("krun_test_p34_native")
    .withPassword(randomBytes(32).toString("hex"))
    .withName(`krun-test-p34-native-${randomBytes(6).toString("hex")}`)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}, 120000);
afterAll(async () => {
  await postgres?.stop();
}, 120000);
for (const dialect of ["sqlite", "postgres"] as const)
  it.live(
    `native POST/GetRun FULL/BASIC/wildcard/ListRuns with real ${dialect}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const container = dialect === "postgres" ? postgres : null;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const token = randomBytes(32).toString("hex"),
                other = randomBytes(32).toString("hex");
              const keys = yield* makeKeys({
                path: "krun-test-p34-native-keys",
                read: Effect.succeed(
                  Buffer.from(
                    JSON.stringify({
                      keys: [
                        {
                          name: "reader",
                          key: token,
                          scopes: ["runs:read", "runs:write"],
                          functions: ["alpha"],
                        },
                        { name: "other", key: other, scopes: ["runs:read"], functions: ["*"] },
                      ],
                    }),
                  ),
                ),
              });
              const config = yield* parseGatewayConfig({
                KRUN_NAMESPACE: "krun-test-p34-native",
                KRUN_DB_MODE: "embedded",
              });
              const functions = yield* makeFunctions({
                namespace: config.KRUN_NAMESPACE,
                ceilings: {
                  maxActiveDeadline: config.KRUN_MAX_ACTIVE_DEADLINE,
                  maxQueued: config.KRUN_MAX_QUEUED,
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
              const create = yield* createRunRoutes(config).pipe(
                Effect.provideService(Keys, keys),
                Effect.provideService(Functions, functions),
                Effect.provideService(DnsLookup, {
                  lookup: () => Effect.succeed([{ address: "203.0.113.1", family: 4 }]),
                }),
              );
              const app = yield* makePublicApp({
                routes: async (server) => {
                  server.register(create);
                  server.register(runReadRoutes);
                },
              }).pipe(
                Effect.provideService(Keys, keys),
                Effect.provideService(Functions, functions),
                Effect.provideService(LogDestination, { write() {} }),
              );
              const address = yield* Effect.promise(() =>
                app.listen({ host: "127.0.0.1", port: 0 }),
              );
              const call = (path: string, bearer = token, body?: unknown) =>
                fetch(address + path, {
                  method: body === undefined ? "GET" : "POST",
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                  },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
              const created: { name: string; createTime: string }[] = [];
              for (let n = 1; n <= 3; n++) {
                const input = JSON.parse(`{"n":${n},"nul":"\\u0000","__proto__":{"opaque":true}}`);
                const response = yield* Effect.promise(() =>
                  call("/v1/functions/alpha/runs", token, { input }),
                );
                expect(response.status).toBe(201);
                const row = yield* Effect.promise(() => response.json());
                created.push(row);
                const location = response.headers.get("location");
                expect(location).toBeTruthy();
                const full = yield* Effect.promise(async () => {
                  const r = await call(location ?? "");
                  expect(r.status).toBe(200);
                  return r.json();
                });
                expect(full.input).toEqual(input);
                expect(full.name).toBe(row.name);
                const basic = yield* Effect.promise(async () => {
                  const r = await call(`${location ?? ""}?view=BASIC`);
                  expect(r.status).toBe(200);
                  return r.json();
                });
                expect(basic).not.toHaveProperty("input");
                expect(basic.name).toBe(row.name);
                const wild = `/v1/functions/-/runs/${row.name.split("/").at(-1)}`;
                expect((yield* Effect.promise(() => call(wild))).status).toBe(200);
                expect((yield* Effect.promise(() => call(wild, other))).status).toBe(404);
              }
              const at = yield* DateTime.now;
              for (const [n, fn, owner] of [
                [1, "beta", "reader"],
                [2, "alpha", "other"],
              ] as const)
                yield* store.createRun({
                  id: `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`,
                  idempotency_key: null,
                  request_hash: "b".repeat(64),
                  function_name: fn,
                  created_by: owner,
                  input: { private: "hidden" },
                  priority: 0,
                  callback_url: null,
                  created_at: at,
                });
              const first = yield* Effect.promise(async () => {
                const r = await call("/v1/functions/-/runs?pageSize=2");
                expect(r.status).toBe(200);
                return r.json();
              });
              expect(first.runs).toHaveLength(2);
              expect(first.nextPageToken).not.toBe("");
              const second = yield* Effect.promise(async () => {
                const r = await call(
                  `/v1/functions/-/runs?pageSize=1&pageToken=${first.nextPageToken}`,
                );
                expect(r.status).toBe(200);
                return r.json();
              });
              expect(second.runs).toHaveLength(1);
              expect(second.nextPageToken).toBe("");
              const expected = created
                .toSorted(
                  (a, b) =>
                    b.createTime.localeCompare(a.createTime) || b.name.localeCompare(a.name),
                )
                .map((r) => r.name);
              expect([...first.runs, ...second.runs].map((r: { name: string }) => r.name)).toEqual(
                expected,
              );
              const filtered = yield* Effect.promise(async () => {
                const r = await call("/v1/functions/alpha/runs?filter=state%20%3D%20QUEUED");
                expect(r.status).toBe(200);
                return r.json();
              });
              expect(filtered.runs.map((r: { name: string }) => r.name)).toEqual(expected);
              for (const row of filtered.runs) expect(row).not.toHaveProperty("input");
            }),
          ).pipe(
            Effect.provide(
              container ? StorePostgres(container.getConnectionUri()) : StoreSqlite(":memory:"),
            ),
          );
        }),
      ),
    30000,
  );
