import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StorePostgres, StoreSqlite } from "@krun/shared/dist/store/live.js";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Clock, DateTime, Deferred, Effect, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { Wait } from "testcontainers";
import { z } from "zod";
import { makePublicApp, PublicAppError } from "./app.js";
import { ApiError } from "./errors.js";

// Test-owned routes exercise the foundation, not the unimplemented public methods.
const fixture = (extraRoutes?: FastifyPluginAsync) =>
  Effect.gen(function* () {
    const token = randomBytes(32).toString("hex");
    const narrow = randomBytes(32).toString("hex");
    const admin = randomBytes(32).toString("hex");
    const file = yield* Ref.make({
      keys: [
        {
          name: "reader",
          key: token,
          scopes: ["functions:read", "runs:write", "runs:read"],
          functions: ["echo"],
        },
        { name: "narrow", key: narrow, scopes: ["runs:read"], functions: ["echo"] },
        { name: "admin", key: admin, scopes: ["admin"] },
      ],
    });
    const keys = yield* makeKeys({
      path: "krun-test-p3-1a-keys",
      read: Ref.get(file).pipe(Effect.map((value) => Buffer.from(JSON.stringify(value)))),
    });
    const functions = yield* makeFunctions({
      namespace: "krun-test-p3-1a",
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
          Stream.concat(
            Stream.make({
              type: "sync" as const,
              items: [
                {
                  metadata: {
                    name: "echo",
                    namespace: "krun-test-p3-1a",
                    uid: "test-uid",
                    generation: 1,
                    resourceVersion: "1",
                  },
                  spec: {
                    image: `ghcr.io/acme/worker@sha256:${"a".repeat(64)}`,
                    inputSchema: { type: "object" },
                  },
                },
              ],
            }),
            Stream.never,
          ),
      }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    yield* functions.synced;
    const store = yield* Store;
    yield* store.migrate();
    const app = yield* makePublicApp({
      routes: async (scope) => {
        expect(scope.store).toBe(store);
        expect(scope.functions).toBe(functions);
        expect(scope.keys).toBe(keys);
        const typed = scope.withTypeProvider<import("fastify-type-provider-zod").ZodTypeProvider>();
        typed.get(
          "/_test/functions/:function",
          {
            config: { krun: { scope: "functions:read", functionParam: "function" } },
            schema: { params: z.strictObject({ function: z.string().min(1) }) },
          },
          async (request, reply) =>
            scope.runEffect(
              request,
              reply,
              Effect.gen(function* () {
                const entry = yield* scope.functions.get(request.params.function);
                if (!entry) return yield* new ApiError({ reason: "FUNCTION_NOT_FOUND" });
                return {
                  name: entry.name,
                  key: request.principal?.name,
                  time: yield* Clock.currentTimeMillis,
                };
              }),
            ),
        );
        typed.post(
          "/_test/body",
          {
            config: { krun: { scope: "runs:write" } },
            schema: {
              body: z.strictObject({
                input: z.strictObject({ value: z.string() }),
                priority: z.int().optional(),
              }),
              response: { 200: z.strictObject({ value: z.string() }) },
            },
          },
          async (request) => ({ value: request.body.input.value }),
        );
        typed.get(
          "/_test/fail/:reason",
          { config: { krun: { scope: "functions:read" } } },
          async (request, reply) => {
            const reason = z
              .object({
                reason: z.enum([
                  "RUN_NOT_FOUND",
                  "QUEUE_FULL",
                  "NOT_READY",
                  "SCOPE_MISSING",
                  "INTERNAL",
                ]),
              })
              .parse(request.params).reason;
            return scope.runEffect(request, reply, Effect.fail(new ApiError({ reason })));
          },
        );
        typed.get(
          "/_test/defect",
          { config: { krun: { scope: "functions:read" } } },
          async (request, reply) =>
            scope.runEffect(request, reply, Effect.die(new Error("krun-test-private-diagnostic"))),
        );
        typed.get(
          "/_test/compound",
          { config: { krun: { scope: "functions:read" } } },
          async (request, reply) =>
            scope.runEffect(
              request,
              reply,
              Effect.fail(new ApiError({ reason: "RUN_NOT_FOUND" })).pipe(
                Effect.ensuring(Effect.die("krun-test-private-finalizer")),
              ),
            ),
        );
        typed.get(
          "/_test/query",
          {
            config: { krun: { scope: "functions:read" } },
            schema: { querystring: z.object({ value: z.string().optional() }) },
          },
          async () => ({ ok: true }),
        );
        typed.post("/_test/empty", { config: { krun: { scope: "runs:write" } } }, async () => ({
          ok: true,
        }));
        if (extraRoutes) scope.register(extraRoutes);
        typed.get(
          "/_test/serialization",
          {
            config: { krun: { scope: "functions:read" } },
            schema: { response: { 200: z.strictObject({ value: z.string() }) } },
          },
          async () => ({ value: 42 as unknown as string }),
        );
      },
    }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
    return { app, token, narrow, admin, file, store, functions };
  });
const run = <A, E>(program: Effect.Effect<A, E, Store | import("effect").Scope.Scope>) =>
  Effect.scoped(program).pipe(Effect.provide(StoreSqlite(":memory:")));
const get = (app: FastifyInstance, url: string, token?: string) =>
  Effect.promise(() =>
    app.inject({
      method: "GET",
      url,
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    }),
  );
const reason = (response: { json: () => { error: { details: { reason: string }[] } } }) =>
  response.json().error.details[0]?.reason;

it.effect("authenticates onRequest before parsing; scopes and function globs fail closed", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const [header, expected] of [
        [undefined, "KEY_MISSING"],
        ["", "KEY_INVALID"],
        ["Basic invalid", "KEY_INVALID"],
        ["Bearer invalid", "KEY_INVALID"],
        [`Bearer ${f.token}, Bearer invalid`, "KEY_INVALID"],
      ] as const) {
        const response = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/_test/body",
            headers: {
              "content-type": "application/json",
              ...(header === undefined ? {} : { authorization: header }),
            },
            payload: "{",
          }),
        );
        expect(response.statusCode).toBe(401);
        expect(reason(response)).toBe(expected);
        expect(response.json().error.status).toBe("UNAUTHENTICATED");
        expect(response.body).not.toContain(f.token);
      }
      const missingScope = yield* get(f.app, "/_test/functions/echo", f.narrow);
      expect(missingScope.statusCode).toBe(403);
      expect(reason(missingScope)).toBe("SCOPE_MISSING");
      expect(missingScope.json().error.details[0].metadata).toEqual({ scope: "functions:read" });
      const hidden = yield* get(f.app, "/_test/functions/hidden", f.token);
      const absent = yield* get(f.app, "/_test/functions/hidden", f.admin);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual(absent.json());
      expect(reason(hidden)).toBe("FUNCTION_NOT_FOUND");
      const response = yield* get(f.app, "/_test/functions/echo", f.token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ name: "echo", key: "reader", time: 0 });
      expect((yield* get(f.app, "/_test/functions/echo", f.admin)).statusCode).toBe(200);
    }),
  ),
);

it.effect(
  "rejects unknown query, unknown/nested fields, null, malformed/empty JSON and non-JSON",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(reason(yield* get(f.app, "/_test/functions/echo?unexpected=private", f.token))).toBe(
          "REQUEST_INVALID",
        );
        for (const payload of [
          "{",
          "",
          "null",
          '{"input":null}',
          '{"input":{"value":null}}',
          '{"input":{"value":"ok","secret":"private"}}',
          '{"input":{"value":"ok"},"unknown":"private"}',
          '{"input":{"value":"ok"},"priority":null}',
        ]) {
          const response = yield* Effect.promise(() =>
            f.app.inject({
              method: "POST",
              url: "/_test/body",
              headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
              payload,
            }),
          );
          expect(response.statusCode).toBe(400);
          expect(reason(response)).toBe("REQUEST_INVALID");
          expect(response.body).not.toContain("private");
          expect(response.body).not.toContain(f.token);
        }
        for (const contentType of [
          "text/plain",
          "application/x-www-form-urlencoded",
          "application/vendor+json",
        ]) {
          const response = yield* Effect.promise(() =>
            f.app.inject({
              method: "POST",
              url: "/_test/body",
              headers: { authorization: `Bearer ${f.token}`, "content-type": contentType },
              payload: '{"input":{"value":"ok"}}',
            }),
          );
          expect(response.statusCode).toBe(415);
          expect(reason(response)).toBe("CONTENT_TYPE_UNSUPPORTED");
        }
        for (const payload of ["null", '{"unknown":"private"}']) {
          const empty = yield* Effect.promise(() =>
            f.app.inject({
              method: "POST",
              url: "/_test/empty",
              headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
              payload,
            }),
          );
          expect(empty.statusCode).toBe(400);
          expect(reason(empty)).toBe("REQUEST_INVALID");
        }
        const absent = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/_test/empty",
            headers: { authorization: `Bearer ${f.token}` },
          }),
        );
        expect(absent.statusCode).toBe(200);
        const valid = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/_test/body",
            headers: {
              authorization: `Bearer ${f.token}`,
              "content-type": "application/json; charset=utf-8",
            },
            payload: { input: { value: "ok" }, priority: 0 },
          }),
        );
        expect(valid.statusCode).toBe(200);
        expect(valid.json()).toEqual({ value: "ok" });
      }),
    ),
);

it.effect(
  "canonical envelope covers 404, expected tagged failures, defects and response validation",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const [path, code, expected, status] of [
          ["/missing", 404, "ROUTE_NOT_FOUND", "NOT_FOUND"],
          ["/_test/fail/RUN_NOT_FOUND", 404, "RUN_NOT_FOUND", "NOT_FOUND"],
          ["/_test/fail/QUEUE_FULL", 429, "QUEUE_FULL", "RESOURCE_EXHAUSTED"],
          ["/_test/fail/NOT_READY", 503, "NOT_READY", "UNAVAILABLE"],
          ["/_test/defect", 500, "INTERNAL", "INTERNAL"],
          ["/_test/serialization", 500, "INTERNAL", "INTERNAL"],
        ] as const) {
          const response = yield* get(f.app, path, f.token);
          expect(response.statusCode).toBe(code);
          expect(reason(response)).toBe(expected);
          expect(response.json().error.status).toBe(status);
          expect(response.json().error.code).toBe(code);
          expect(response.json().error.details[0]["@type"]).toBe(
            "type.googleapis.com/google.rpc.ErrorInfo",
          );
          expect(response.json().error.details[0].domain).toBe("krun.io");
          expect(response.body).not.toMatch(/krun-test-private|stack|ZodError/);
          if (code === 429 || code === 503) expect(response.headers["retry-after"]).toBe("1");
        }
        expect(reason(yield* get(f.app, "/readyz"))).toBe("ROUTE_NOT_FOUND");
        expect(f.app.server.listening).toBe(false);
        const compound = yield* get(f.app, "/_test/compound", f.token);
        expect(compound.statusCode).toBe(500);
        expect(reason(compound)).toBe("INTERNAL");
        const unknownBody = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/missing",
            headers: { "content-type": "application/json" },
            payload: "{",
          }),
        );
        expect(unknownBody.statusCode).toBe(404);
        expect(reason(unknownBody)).toBe("ROUTE_NOT_FOUND");
        const looseQuery = yield* get(f.app, "/_test/query?unknown=private", f.token);
        expect(looseQuery.statusCode).toBe(400);
        expect(reason(looseQuery)).toBe("REQUEST_INVALID");
      }),
    ),
);

it.effect("lookup happens on every request and retains the owning TestClock on reload", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* get(f.app, "/_test/functions/echo", f.token)).statusCode).toBe(200);
      yield* Ref.update(f.file, (file) => ({
        keys: file.keys.filter((key) => key.name !== "reader"),
      }));
      yield* TestClock.adjust("30 seconds");
      // The keys layer publishes atomically; lookup the same captured service after the scheduled reload.
      expect((yield* get(f.app, "/_test/functions/echo", f.token)).statusCode).toBe(401);
      expect((yield* get(f.app, "/_test/functions/echo", f.admin)).json().time).toBe(30000);
    }),
  ),
);

const storeRoutes: FastifyPluginAsync = async (scope) => {
  const typed = scope.withTypeProvider<import("fastify-type-provider-zod").ZodTypeProvider>();
  typed.post(
    "/_test/runs",
    {
      config: { krun: { scope: "runs:write" } },
      schema: { body: z.strictObject({ value: z.string() }) },
    },
    async (request, reply) =>
      scope.runEffect(
        request,
        reply,
        Effect.gen(function* () {
          const result = yield* scope.store.createRun({
            id: randomUUID(),
            idempotency_key: null,
            request_hash: "a".repeat(64),
            function_name: "echo",
            input: { value: request.body.value },
            priority: 0,
            callback_url: null,
            created_by: request.principal?.name ?? "",
            created_at: yield* DateTime.now,
          });
          reply.code(201);
          return { id: result.run.id, state: result.run.state };
        }),
      ),
  );
  typed.get(
    "/_test/runs/:id",
    {
      config: { krun: { scope: "runs:read" } },
      schema: { params: z.strictObject({ id: z.uuid() }) },
    },
    async (request, reply) =>
      scope.runEffect(
        request,
        reply,
        Effect.map(scope.store.getRun(request.params.id), (row) => ({
          id: row.id,
          state: row.state,
          input: row.input,
          createdBy: row.created_by,
        })),
      ),
  );
};
const roundTrip = Effect.gen(function* () {
  const f = yield* fixture(storeRoutes);
  const created = yield* Effect.promise(() =>
    f.app.inject({
      method: "POST",
      url: "/_test/runs",
      headers: { authorization: `Bearer ${f.token}` },
      payload: { value: "stored" },
    }),
  );
  expect(created.statusCode).toBe(201);
  const id = z.object({ id: z.uuid() }).parse(created.json()).id;
  const found = yield* get(f.app, `/_test/runs/${id}`, f.token);
  expect(found.statusCode).toBe(200);
  expect(found.json()).toEqual({
    id,
    state: "queued",
    input: { value: "stored" },
    createdBy: "reader",
  });
  expect((yield* f.store.getRun(id)).input).toEqual({ value: "stored" });
  expect(yield* f.store.countQueued("echo")).toBe(1);
});
it.effect("test-owned HTTP POST then GET uses the actual shared SQLite Store", () =>
  run(roundTrip),
);
it.live(
  "test-owned HTTP POST then GET uses actual Postgres18 via Testcontainers",
  () =>
    Effect.gen(function* () {
      const container = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new PostgreSqlContainer(
              "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
            )
              .withName(`krun-test-p3-1a-postgres-${process.pid}`)
              .withDatabase("krun_test_p3_1a")
              .withPassword(randomBytes(32).toString("hex"))
              .withWaitStrategy(
                Wait.forLogMessage(/database system is ready to accept connections/, 2),
              )
              .start(),
          catch: () => new Error("Disposable gateway Postgres fixture failed to start"),
        }),
        (container) => Effect.promise(() => container.stop()),
      );
      yield* roundTrip.pipe(Effect.provide(StorePostgres(container.getConnectionUri())));
    }),
  120000,
);

it.effect(
  "rejects missing route authorization metadata at registration instead of silently exposing it",
  () =>
    run(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          fixture(async (scope) => {
            scope.get("/_test/unsecured", async () => ({ unsecured: true }));
          }),
        );
        expect(failure).toBeInstanceOf(PublicAppError);
      }),
    ),
);

it.effect("explicit app close interrupts and settles active request finalizers", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finalized = false;
      const f = yield* fixture(async (scope) => {
        scope.get(
          "/_test/block",
          { config: { krun: { scope: "functions:read" } } },
          async (request, reply) =>
            scope.runEffect(
              request,
              reply,
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized = true;
                  }),
                ),
              ),
            ),
        );
      });
      const pending = f.app.inject({
        method: "GET",
        url: "/_test/block",
        headers: { authorization: `Bearer ${f.token}` },
      });
      yield* Deferred.await(started);
      yield* Effect.promise(() => f.app.close());
      yield* Effect.promise(() => pending);
      expect(finalized).toBe(true);
      // App closure never closes an externally owned dependency early.
      expect(yield* f.store.countQueued("echo")).toBe(0);
    }),
  ),
);

it.live(
  "a real client disconnect interrupts its Effect and releases the request scope",
  () =>
    run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const f = yield* fixture(async (scope) => {
          scope.get(
            "/_test/block",
            { config: { krun: { scope: "functions:read" } } },
            async (request, reply) =>
              scope.runEffect(
                request,
                reply,
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(finalized, undefined)),
                ),
              ),
          );
        });
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const request = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const request = httpRequest(`${address}/_test/block`, {
              headers: { authorization: `Bearer ${f.token}` },
            });
            request.on("error", () => {});
            request.end();
            return request;
          }),
          (request) => Effect.sync(() => request.destroy()),
        );
        yield* Deferred.await(started);
        request.destroy();
        yield* Deferred.await(finalized);
      }),
    ),
  10000,
);

it.live(
  "duplicate Authorization fields are rejected on the real HTTP adapter",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const code = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const request = httpRequest(
                `${address}/_test/functions/echo`,
                {
                  headers: [
                    "Host",
                    new URL(address).host,
                    "Authorization",
                    `Bearer ${f.token}`,
                    "authorization",
                    "Bearer invalid",
                  ],
                },
                (response) => {
                  response.resume();
                  response.once("end", () => resolve(response.statusCode ?? 0));
                },
              );
              request.once("error", reject);
              request.end();
            }),
        );
        expect(code).toBe(401);
      }),
    ),
  10000,
);
