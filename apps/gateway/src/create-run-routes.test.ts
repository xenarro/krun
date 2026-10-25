import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { type SqliteTables, Store, toRun } from "@krun/shared/dist/store/index.js";
import { StoreLive, StorePostgres } from "@krun/shared/dist/store/live.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DateTime, Deferred, Effect, Fiber, Layer, Metric, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Wait } from "testcontainers";
import { makePublicApp } from "./app.js";
import { createRunRoutes } from "./create-run-routes.js";

const resource = (name: string, spec: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: "krun-test-p3-3", uid: name, generation: 1, resourceVersion: "1" },
  spec: {
    image: `example.invalid/job@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
    ...spec,
  },
});
const createFixture = (
  options: {
    env?: Record<string, string>;
    items?: unknown[];
    synced?: boolean;
    noPriority?: boolean;
    inserted?: Deferred.Deferred<void>;
    waiting?: Deferred.Deferred<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const token = randomBytes(32).toString("hex"),
      priority = randomBytes(32).toString("hex"),
      limited = randomBytes(32).toString("hex"),
      wrong = randomBytes(32).toString("hex");
    const file = yield* Ref.make({
      keys: [
        { name: "creator", key: token, scopes: ["runs:write"], functions: ["echo", "f-*"] },
        {
          name: "privileged",
          key: priority,
          scopes: options.noPriority ? ["runs:write"] : ["runs:write", "runs:priority"],
          functions: ["*"],
        },
        { name: "limited", key: limited, scopes: ["runs:write"], functions: ["*"], maxQueued: 1 },
        { name: "wrong", key: wrong, scopes: ["runs:read"], functions: ["*"] },
      ],
    });
    const keys = yield* makeKeys({
      path: "krun-test-p3-3-keys",
      read: Ref.get(file).pipe(Effect.map((x) => Buffer.from(JSON.stringify(x)))),
    });
    const config = yield* parseGatewayConfig({
      KRUN_NAMESPACE: "krun-test-p3-3",
      KRUN_API_KEYS_PATH: "krun-test-p3-3-keys",
      KRUN_DB_MODE: "embedded",
      KRUN_RATE_LIMIT_RPS: "1000",
      KRUN_RATE_LIMIT_BURST: "1000",
      KRUN_WEBHOOK_ALLOWED_HOSTS: "*",
      ...options.env,
    });
    const documents = yield* Ref.make(
      options.items ?? [
        resource("echo"),
        resource("f-full", { maxQueued: 0 }),
        resource("f-default", { callback: { url: "https://8.8.8.8/default" } }),
        resource("broken", { image: "tag:latest" }),
      ],
    );
    const functions = yield* makeFunctions({
      namespace: config.KRUN_NAMESPACE,
      ceilings: {
        maxActiveDeadline: config.KRUN_MAX_ACTIVE_DEADLINE,
        maxQueued: config.KRUN_MAX_QUEUED,
        allowedRegistries: [],
        allowedServiceAccounts: ["krun-job-default"],
        webhookAllowedHosts: ["*"],
      },
    }).pipe(
      Effect.provideService(FunctionSource, {
        watch: () =>
          options.synced === false
            ? Stream.never
            : Stream.fromEffect(Ref.get(documents)).pipe(
                Stream.map((items) => ({ type: "sync" as const, items })),
                Stream.concat(Stream.never),
              ),
      }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    if (options.synced !== false) yield* functions.synced;
    // Observation only: all reads/writes still delegate to the actual dialect Store.
    const actual = yield* Store;
    const store = {
      ...actual,
      createRun: (value: Parameters<typeof actual.createRun>[0]) =>
        actual
          .createRun(value)
          .pipe(
            Effect.tap(() =>
              options.inserted ? Deferred.succeed(options.inserted, undefined) : Effect.void,
            ),
          ),
      getRun: (id: string) =>
        actual
          .getRun(id)
          .pipe(
            Effect.tap(() =>
              options.waiting ? Deferred.succeed(options.waiting, undefined) : Effect.void,
            ),
          ),
    };
    yield* store.migrate();
    const routes = yield* createRunRoutes(config).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(DnsLookup, {
        lookup: () => Effect.succeed([{ address: "8.8.8.8", family: 4 }]),
      }),
    );
    const app = yield* makePublicApp({
      routes: async (scope) => {
        await scope.register(routes);
        // Explicit test-owned readback, not the future P3.4 public GetRun handler.
        scope.get<{ Params: { id: string } }>(
          "/krun-test/persisted/:id",
          { config: { krun: { scope: "runs:write" } } },
          async (request, reply) =>
            scope.runEffect(
              request,
              reply,
              store.getRun(request.params.id).pipe(Effect.map(toRun)),
            ),
        );
      },
    }).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(Keys, keys),
      Effect.provideService(Functions, functions),
      Effect.provideService(LogDestination, { write() {} }),
    );
    const call = (
      query = "",
      body: unknown = { input: { n: 1 } },
      credential = token,
      fn = "echo",
    ) =>
      Effect.promise(() =>
        app.inject({
          method: "POST",
          url: `/v1/functions/${fn}/runs${query}`,
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          payload: typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
    return { app, store, call, token, priority, limited, wrong, file, config };
  });
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")))),
  );
const reason = (response: { json: () => { error: { details: { reason: string }[] } } }) =>
  response.json().error.details[0]?.reason;
it.effect(
  "creates a real queued FULL Run with Clock UUIDv7, Location and durable actor history",
  () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(1792886400000);
        const f = yield* createFixture();
        const response = yield* f.call();
        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.state).toBe("QUEUED");
        expect(body.createdBy).toBe("creator");
        expect(body.input).toEqual({ n: 1 });
        expect(body.createTime).toBe(DateTime.formatIso(yield* DateTime.now));
        expect(response.headers.location).toBe("/v1/" + body.name);
        expect(body.name).toMatch(/\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-7/);
        expect(yield* f.store.countQueued("echo")).toBe(1);
        const { db } = yield* Database;
        const events = yield* Effect.promise(() =>
          db
            .withTables<SqliteTables>()
            .selectFrom("run_events")
            .select("payload")
            .where("run_id", "=", body.name.split("/").at(-1))
            .execute(),
        );
        expect(events).toHaveLength(1);
        const payload = events[0]?.payload;
        expect(typeof payload === "string" ? JSON.parse(payload) : payload).toMatchObject({
          actor: "creator",
        });
        expect(JSON.stringify(body)).not.toContain('"callback":null');
      }),
    ),
);
it.effect(
  "replays current state before schema/callback/quota, ignores output fields and normalizes defaults",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const first = yield* f.call(
          "?requestId=same",
          {
            input: { n: 1 },
            state: 42,
            result: { ignored: true },
          },
          f.priority,
        );
        expect(first.statusCode).toBe(201);
        const id = first.json().name.split("/").at(-1);
        yield* f.store.transition(id, "queued", "cancelling", null, {});
        const second = yield* f.call(
          "?requestId=same",
          { input: { n: 1 }, priority: 0 },
          f.priority,
        );
        expect(second.statusCode).toBe(201);
        expect(second.headers["idempotent-replay"]).toBe("true");
        expect(second.json().state).toBe("CANCELLING");
        expect(second.json().name).toBe(first.json().name);
        expect(yield* f.store.countQueued("echo")).toBe(0);
        const conflict = yield* f.call(
          "?requestId=same",
          { input: { n: 1 }, priority: 1 },
          f.priority,
        );
        expect(conflict.statusCode).toBe(409);
        expect(reason(conflict)).toBe("IDEMPOTENCY_CONFLICT");
      }),
    ),
);
it.effect(
  "copies the default callback after hashing, but explicit callbacks participate in the fingerprint",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const a = yield* f.call("?requestId=default", { input: { n: 1 } }, f.token, "f-default");
        expect(a.statusCode).toBe(201);
        expect(a.json().callback).toEqual({ url: "https://8.8.8.8/default" });
        const b = yield* f.call(
          "?requestId=default",
          { input: { n: 1 }, callback: { url: "https://8.8.8.8/default" } },
          f.token,
          "f-default",
        );
        expect(reason(b)).toBe("IDEMPOTENCY_CONFLICT");
      }),
    ),
);
it.effect("rejects schema violations with BadRequest fields and no inserted row", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      const response = yield* f.call("", { input: { n: "wrong" } });
      expect(reason(response)).toBe("INPUT_SCHEMA_VIOLATION");
      expect(response.json().error.details[1]["@type"]).toBe(
        "type.googleapis.com/google.rpc.BadRequest",
      );
      expect(response.json().error.details[1].fieldViolations[0].field).toBe("input.n");
      expect(yield* f.store.countQueued("echo")).toBe(0);
    }),
  ),
);
it.effect("enforces method and priority scopes and generic function visibility", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      expect(reason(yield* f.call("", { input: { n: 1 } }, f.wrong))).toBe("SCOPE_MISSING");
      const r = yield* f.call("", { input: { n: 1 }, priority: 1 });
      expect(reason(r)).toBe("SCOPE_MISSING");
      expect(r.json().error.details[0].metadata.scope).toBe("runs:priority");
      expect((yield* f.call("", { input: { n: 1 }, priority: 9 }, f.priority)).statusCode).toBe(
        201,
      );
      for (const fn of ["missing", "hidden", "broken"])
        expect(reason(yield* f.call("", "{", f.priority, fn))).toBe("FUNCTION_NOT_FOUND");
    }),
  ),
);
it.effect("rejects private callbacks, exposes callback.url and never inserts", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      const r = yield* f.call("", {
        input: { n: 1 },
        callback: { url: "http://127.0.0.1/private" },
      });
      expect(reason(r)).toBe("CALLBACK_NOT_ALLOWED");
      expect(r.json().error.details[1].fieldViolations[0].field).toBe("callback.url");
      expect(yield* f.store.countQueued("echo")).toBe(0);
    }),
  ),
);
it.effect("enforces both function and per-key queued caps with Retry-After", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      expect((yield* f.call("", { input: { n: 1 } }, f.limited)).statusCode).toBe(201);
      for (const [token, fn, limit] of [
        [f.token, "f-full", "function"],
        [f.limited, "echo", "key"],
      ]) {
        const r = yield* f.call("", { input: { n: 1 } }, token, fn);
        expect(reason(r)).toBe("QUEUE_FULL");
        expect(r.json().error.details[0].metadata.limit).toBe(limit);
        expect(r.headers["retry-after"]).toBe("1");
      }
    }),
  ),
);
it.effect(
  "rate limits before function resolution and parsing, refills from TestClock per key",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture({
          env: { KRUN_RATE_LIMIT_RPS: "1", KRUN_RATE_LIMIT_BURST: "1" },
        });
        expect((yield* f.call()).statusCode).toBe(201);
        const r = yield* f.call("", "{", f.token, "missing");
        expect(reason(r)).toBe("RATE_LIMITED");
        expect(r.headers["retry-after"]).toBe("1");
        expect((yield* f.call("", { input: { n: 1 } }, f.priority)).statusCode).toBe(201);
        yield* TestClock.adjust("1 second");
        expect((yield* f.call()).statusCode).toBe(201);
      }),
    ),
);
it.effect(
  "caps the complete body before parsing malformed JSON, including a valid zero configuration",
  () =>
    run(
      Effect.gen(function* () {
        for (const cap of ["0", "8"]) {
          const f = yield* createFixture({ env: { KRUN_MAX_INPUT_BYTES: cap } });
          const r = yield* f.call("", cap === "0" ? "x" : "{".repeat(20));
          expect(r.statusCode).toBe(413);
          expect(reason(r)).toBe("INPUT_TOO_LARGE");
          expect(yield* f.store.countQueued("echo")).toBe(0);
        }
      }),
    ),
);
it.effect(
  "rejects all applicable malformed request rows, method/content/auth errors canonically",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        for (const [q, b] of [
          ["?unknown=1", { input: { n: 1 } }],
          ["?wait=no", { input: { n: 1 } }],
          ["?wait=999999999999999999h", { input: { n: 1 } }],
          ["", { input: null }],
          ["", { input: { n: 1 }, extra: true }],
          ["", { input: { n: 1 }, priority: 10 }],
          ["", "{"],
        ] as const)
          expect(reason(yield* f.call(q, b))).toBe("REQUEST_INVALID");
        const no = yield* Effect.promise(() =>
          f.app.inject({ method: "POST", url: "/v1/functions/echo/runs", payload: "{" }),
        );
        expect(reason(no)).toBe("KEY_MISSING");
        expect(
          reason(yield* f.call("", { input: { n: 1 } }, randomBytes(32).toString("hex"))),
        ).toBe("KEY_INVALID");
        const type = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/v1/functions/echo/runs",
            headers: { authorization: `Bearer ${f.token}`, "content-type": "text/plain" },
            payload: "abc",
          }),
        );
        expect(reason(type)).toBe("CONTENT_TYPE_UNSUPPORTED");
        expect(reason(yield* Effect.promise(() => f.app.inject({ url: "/v1/not-a-route" })))).toBe(
          "ROUTE_NOT_FOUND",
        );
      }),
    ),
);
it.effect("returns retryable startup unavailability for an unsynced real Function cache", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture({ synced: false });
      const r = yield* f.call();
      expect(reason(r)).toBe("NOT_READY");
      expect(r.headers["retry-after"]).toBe("1");
    }),
  ),
);
it.effect("serializes same-replica quota admission and concurrent duplicate creates", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture({ items: [resource("echo", { maxQueued: 1 })] });
      const results = yield* Effect.all([f.call("?requestId=same"), f.call("?requestId=same")], {
        concurrency: 2,
      });
      expect(results.map((x) => x.statusCode)).toEqual([201, 201]);
      expect(results[0]?.json().name).toBe(results[1]?.json().name);
      expect(yield* f.store.countQueued("echo")).toBe(1);
      expect(reason(yield* f.call("?requestId=different"))).toBe("QUEUE_FULL");
    }),
  ),
);
it.effect("keeps opaque own JSON members and ignores output-only input without pollution", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      const r = yield* f.call(
        "",
        JSON.parse(
          '{"input":{"n":1,"__proto__":{"krunTestPolluted":true},"constructor":{"a":2}},"name":false,"createdBy":"ignored"}',
        ),
      );
      expect(r.statusCode).toBe(201);
      expect(Object.hasOwn(r.json().input, "__proto__")).toBe(true);
      expect(Reflect.get({}, "krunTestPolluted")).toBeUndefined();
      expect(r.json().createdBy).toBe("creator");
    }),
  ),
);

it.effect("honors wait=0 and capped nonterminal wait using owning Effect Clock", () =>
  run(
    Effect.gen(function* () {
      const inserted = yield* Deferred.make<void>(),
        waiting = yield* Deferred.make<void>();
      const f = yield* createFixture({ env: { KRUN_MAX_WAIT: "1s" }, inserted, waiting });
      const done = yield* Deferred.make<void>();
      const response = yield* f.call("?wait=999h").pipe(
        Effect.tap(() => Deferred.succeed(done, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(inserted);
      yield* Deferred.await(waiting);
      expect(yield* Deferred.isDone(done)).toBe(false);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(response);
      expect(result.statusCode).toBe(201);
      expect(result.json().state).toBe("QUEUED");
      expect((yield* f.call("?wait=0ms")).statusCode).toBe(201);
    }),
  ),
);
it.effect(
  "re-reads terminal state through a live Store hint/fallback and honors wait on replay",
  () =>
    run(
      Effect.gen(function* () {
        const inserted = yield* Deferred.make<void>(),
          waiting = yield* Deferred.make<void>();
        const f = yield* createFixture({ inserted, waiting });
        const response = yield* f.call("?requestId=wait&wait=10s").pipe(Effect.forkScoped);
        yield* Deferred.await(inserted);
        yield* Deferred.await(waiting);
        const page = yield* f.store.listByState(["queued"], 2);
        const id = page[0]?.id;
        expect(id).toBeDefined();
        if (!id) throw new Error("Missing inserted row");
        expect(yield* f.store.transition(id, "queued", "cancelling", null, {})).toBe(true);
        expect(yield* f.store.transition(id, "cancelling", "cancelled", null, {})).toBe(true);
        yield* TestClock.adjust("1 second");
        const r = yield* Fiber.join(response);
        expect(r.json().state).toBe("CANCELLED");
        const replay = yield* f.call("?requestId=wait&wait=10s");
        expect(replay.headers["idempotent-replay"]).toBe("true");
        expect(replay.json().state).toBe("CANCELLED");
      }),
    ),
);
it.effect("authorized replay precedes changed schema, callback policy and full queues", () =>
  run(
    Effect.gen(function* () {
      const first = yield* createFixture();
      const body = { input: { n: 1 }, priority: 2, callback: { url: "https://8.8.8.8/cb" } };
      const created = yield* first.call("?requestId=across-reload", body, first.priority);
      expect(created.statusCode).toBe(201);
      const second = yield* createFixture({
        noPriority: false,
        env: { KRUN_WEBHOOK_ALLOWED_HOSTS: "" },
        items: [
          resource("echo", {
            maxQueued: 0,
            inputSchema: {
              type: "object",
              properties: { different: { type: "string" } },
              required: ["different"],
            },
          }),
        ],
      });
      const replay = yield* second.call("?requestId=across-reload", body, second.priority);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotent-replay"]).toBe("true");
      expect(replay.json().name).toBe(created.json().name);
    }),
  ),
);
it.effect("unexpected real database failure is canonical and carries no internals", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture();
      const { db } = yield* Database;
      yield* Effect.promise(() => db.schema.dropTable("runs").execute());
      const r = yield* f.call();
      expect(r.statusCode).toBe(500);
      expect(reason(r)).toBe("INTERNAL");
      expect(r.body).not.toMatch(/sqlite|select|table|stack|connection/i);
    }),
  ),
);
it.live(
  "real CreateRun POST then test-owned durable GET and replay use PostgreSQL18",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const container = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              new PostgreSqlContainer(
                "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
              )
                .withName(`krun-test-p3-3-postgres-${process.pid}`)
                .withDatabase("krun_test_p3_3")
                .withPassword(randomBytes(32).toString("hex"))
                .withWaitStrategy(
                  Wait.forLogMessage(/database system is ready to accept connections/, 2),
                )
                .start(),
            catch: () => new Error("Disposable P3.3 PostgreSQL fixture failed to start"),
          }),
          (c) => Effect.promise(() => c.stop()),
        );
        yield* Effect.gen(function* () {
          const f = yield* createFixture();
          const results = yield* Effect.all(
            [f.call("?requestId=postgres"), f.call("?requestId=postgres")],
            { concurrency: 2 },
          );
          for (const r of results) expect(r.statusCode).toBe(201);
          expect(results[0]?.json().name).toBe(results[1]?.json().name);
          const id = results[0]?.json().name.split("/").at(-1);
          const read = yield* Effect.promise(() =>
            f.app.inject({
              url: `/krun-test/persisted/${id}`,
              headers: { authorization: `Bearer ${f.token}` },
            }),
          );
          expect(read.json()).toEqual(results[0]?.json());
          expect(yield* f.store.countQueued("echo")).toBe(1);
          expect(reason(yield* f.call("?requestId=postgres", { input: { n: 2 } }))).toBe(
            "IDEMPOTENCY_CONFLICT",
          );
        }).pipe(Effect.provide(StorePostgres(container.getConnectionUri())));
      }),
    ),
  120000,
);

it.effect("exports only bounded admission rejection reasons, never key/function labels", () =>
  run(
    Effect.gen(function* () {
      const f = yield* createFixture({
        env: { KRUN_MAX_INPUT_BYTES: "128", KRUN_RATE_LIMIT_RPS: "0", KRUN_RATE_LIMIT_BURST: "3" },
      });
      const counter = Metric.counter("krun_admission_rejections_total", { incremental: true });
      const before = yield* Effect.all(
        ["schema", "max_queued", "input_size", "rate_limit"].map((reason) =>
          Metric.value(Metric.withAttributes(counter, { reason })),
        ),
      );
      yield* f.call("", { input: { n: "invalid" } });
      yield* f.call("", { input: { n: 1 } }, f.token, "f-full");
      yield* f.call("", "{".repeat(129));
      yield* f.call();
      const after = yield* Effect.all(
        ["schema", "max_queued", "input_size", "rate_limit"].map((reason) =>
          Metric.value(Metric.withAttributes(counter, { reason })),
        ),
      );
      expect(after.map((x, i) => x.count - (before[i]?.count ?? 0))).toEqual([1, 1, 1, 1]);
      const snapshot = yield* Metric.snapshot;
      const selected = snapshot.filter((x) => x.id === "krun_admission_rejections_total");
      expect(selected).toHaveLength(4);
      for (const metric of selected)
        expect(Object.keys(metric.attributes ?? {})).toEqual(["reason"]);
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  ),
);

// Every CreateRun-applicable ErrorInfo row has an independently named HTTP case.
for (const [reasonName, status] of [
  ["REQUEST_INVALID", 400],
  ["INPUT_SCHEMA_VIOLATION", 400],
  ["CALLBACK_NOT_ALLOWED", 400],
  ["KEY_MISSING", 401],
  ["KEY_INVALID", 401],
  ["SCOPE_MISSING", 403],
  ["ROUTE_NOT_FOUND", 404],
  ["FUNCTION_NOT_FOUND", 404],
  ["IDEMPOTENCY_CONFLICT", 409],
  ["INPUT_TOO_LARGE", 413],
  ["CONTENT_TYPE_UNSUPPORTED", 415],
  ["RATE_LIMITED", 429],
  ["QUEUE_FULL", 429],
  ["INTERNAL", 500],
  ["NOT_READY", 503],
] as const)
  it.effect(`CreateRun error table: ${status} ${reasonName}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture({
          synced: reasonName !== "NOT_READY",
          env: {
            KRUN_RATE_LIMIT_RPS: "1",
            KRUN_RATE_LIMIT_BURST: reasonName === "RATE_LIMITED" ? "1" : "1000",
            KRUN_MAX_INPUT_BYTES: reasonName === "INPUT_TOO_LARGE" ? "8" : "1048576",
          },
        });
        let query = "",
          fn = "echo",
          credential = f.token,
          body: unknown = { input: { n: 1 } };
        if (reasonName === "REQUEST_INVALID") query = "?unknown=1";
        if (reasonName === "INPUT_SCHEMA_VIOLATION") body = { input: { n: "bad" } };
        if (reasonName === "CALLBACK_NOT_ALLOWED")
          body = { input: { n: 1 }, callback: { url: "http://127.0.0.1/private" } };
        if (reasonName === "KEY_INVALID") credential = randomBytes(32).toString("hex");
        if (reasonName === "SCOPE_MISSING") body = { input: { n: 1 }, priority: 1 };
        if (reasonName === "FUNCTION_NOT_FOUND") fn = "missing";
        if (reasonName === "IDEMPOTENCY_CONFLICT") {
          credential = f.priority;
          expect(
            (yield* f.call("?requestId=table", { input: { n: 1 } }, credential)).statusCode,
          ).toBe(201);
          query = "?requestId=table";
          body = { input: { n: 1 }, priority: 1 };
        }
        if (reasonName === "INPUT_TOO_LARGE") body = "{".repeat(20);
        if (reasonName === "RATE_LIMITED") expect((yield* f.call()).statusCode).toBe(201);
        if (reasonName === "QUEUE_FULL") {
          credential = f.limited;
          expect((yield* f.call("", body, credential)).statusCode).toBe(201);
        }
        if (reasonName === "INTERNAL") {
          const { db } = yield* Database;
          yield* Effect.promise(() => db.schema.dropTable("runs").execute());
        }
        const response =
          reasonName === "ROUTE_NOT_FOUND"
            ? yield* Effect.promise(() =>
                f.app.inject({
                  method: "POST",
                  url: "/v1/not-a-route",
                  headers: { "content-type": "text/plain" },
                  payload: "x",
                }),
              )
            : reasonName === "KEY_MISSING"
              ? yield* Effect.promise(() =>
                  f.app.inject({ method: "POST", url: "/v1/functions/echo/runs", payload: "{" }),
                )
              : reasonName === "CONTENT_TYPE_UNSUPPORTED"
                ? yield* Effect.promise(() =>
                    f.app.inject({
                      method: "POST",
                      url: "/v1/functions/echo/runs",
                      headers: {
                        authorization: `Bearer ${credential}`,
                        "content-type": "text/plain",
                      },
                      payload: "x",
                    }),
                  )
                : yield* f.call(query, body, credential, fn);
        expect(response.statusCode).toBe(status);
        expect(reason(response)).toBe(reasonName);
        expect(response.json().error.details[0]["@type"]).toBe(
          "type.googleapis.com/google.rpc.ErrorInfo",
        );
        expect(response.json().error.details[0].domain).toBe("krun.io");
        expect(response.headers["x-request-id"]).toBeTruthy();
        if (status === 429 || status === 503) expect(response.headers["retry-after"]).toBe("1");
        if (reasonName === "QUEUE_FULL")
          expect(response.json().error.details[0].metadata.limit).toBe("key");
      }),
    ),
  );
it.effect(
  "rejects a JSON number outside JCS binary64 representation as REQUEST_INVALID, not a defect",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const r = yield* f.call("", '{"input":{"n":1e9999}}');
        expect(r.statusCode).toBe(400);
        expect(reason(r)).toBe("REQUEST_INVALID");
        expect(yield* f.store.countQueued("echo")).toBe(0);
      }),
    ),
);

it.live(
  "a complete native POST body is not a disconnected client",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const response = yield* Effect.promise(
          () =>
            new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
              const request = httpRequest(
                address,
                {
                  method: "POST",
                  path: "/v1/functions/echo/runs?requestId=native-regression",
                  headers: {
                    authorization: `Bearer ${f.token}`,
                    "content-type": "application/json",
                  },
                },
                (response) => {
                  let body = "";
                  response.setEncoding("utf8");
                  response.on("data", (chunk) => {
                    body += chunk;
                  });
                  response.once("end", () => resolve({ status: response.statusCode, body }));
                },
              );
              request.once("error", reject);
              request.end(JSON.stringify({ input: { n: 1 } }));
            }),
        );
        expect(response.status).toBe(201);
        expect(JSON.parse(response.body).state).toBe("QUEUED");
        expect(yield* f.store.countQueued("echo")).toBe(1);
      }),
    ),
  10000,
);

it.live(
  "native client disconnect never cancels an already inserted Run",
  () =>
    run(
      Effect.gen(function* () {
        const inserted = yield* Deferred.make<void>();
        const f = yield* createFixture({ inserted });
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const request = httpRequest(
          address,
          {
            method: "POST",
            path: "/v1/functions/echo/runs?requestId=disconnect&wait=60s",
            headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
          },
          (response) => response.resume(),
        );
        request.on("error", () => {});
        const closed = new Promise<void>((resolve) => request.once("close", resolve));
        request.end(JSON.stringify({ input: { n: 1 } }));
        yield* Deferred.await(inserted);
        request.destroy();
        yield* Effect.promise(() => closed);
        const rows = yield* f.store.listByState(["queued"], 1);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.idempotency_key).toBe("disconnect");
        if (!rows[0]) throw new Error("Missing accepted Run");
        expect((yield* f.store.getRun(rows[0].id)).state).toBe("queued");
        yield* Effect.promise(() => f.app.close());
        expect(f.app.server.listening).toBe(false);
      }),
    ),
  10000,
);

// Independent review assertions; original tests above are filtered out by name.
it.effect(
  "repair regression: positive-priority replay still requires the current priority grant",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const body = { input: { n: 1 }, priority: 2 };
        expect((yield* f.call("?requestId=review-revoke", body, f.priority)).statusCode).toBe(201);
        yield* Ref.update(f.file, (file) => ({
          keys: file.keys.map((key) =>
            key.name === "privileged" ? { ...key, scopes: ["runs:write"] } : key,
          ),
        }));
        yield* TestClock.adjust("30 seconds");
        const cold = yield* f.call("?requestId=review-cold", body, f.priority);
        expect(cold.statusCode).toBe(403);
        expect(reason(cold)).toBe("SCOPE_MISSING");
        const replay = yield* f.call("?requestId=review-revoke", body, f.priority);
        expect(yield* f.store.countQueued("echo")).toBe(1);
        expect(replay.statusCode).toBe(403);
      }),
    ),
);
it.effect(
  "repair regression: embedded mode preserves escaped Unicode NUL in opaque input and request IDs",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        // Build actual U+0000 scalars, not six printable escape characters.
        const nul = String.fromCharCode(0);
        const input = {
          n: 1,
          text: "nul" + nul + "value",
          nested: { ["key" + nul + "name"]: true },
        };
        const requestId = "review" + String.fromCharCode(0) + "id";
        const response = yield* f.call("?requestId=" + encodeURIComponent(requestId), { input });
        expect(response.statusCode).toBe(201);
        expect(response.json().input).toEqual(input);
        expect(
          (yield* f.call("?requestId=" + encodeURIComponent(requestId), { input })).headers[
            "idempotent-replay"
          ],
        ).toBe("true");
      }),
    ),
);
for (const location of ["input", "requestId"] as const) {
  it.live(
    `repair regression: PostgreSQL accepts the same otherwise valid Unicode NUL ${location}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const container = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                new PostgreSqlContainer(
                  "postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6",
                )
                  .withName(`krun-test-p33-repair-unicode-${process.pid}-${location}`)
                  .withDatabase("krun_review_p33")
                  .withPassword(randomBytes(32).toString("hex"))
                  .withWaitStrategy(
                    Wait.forLogMessage(/database system is ready to accept connections/, 2),
                  )
                  .start(),
              catch: () => new Error("Owned review PostgreSQL fixture failed"),
            }),
            (c) => Effect.promise(() => c.stop()),
          );
          yield* Effect.gen(function* () {
            const f = yield* createFixture();
            const control = yield* f.call("?requestId=review-emoji", {
              input: { n: 1, text: "🧪" },
            });
            expect(control.statusCode).toBe(201);
            const nul = String.fromCharCode(0);
            const response = yield* f.call(
              "?requestId=" +
                encodeURIComponent("review-" + location + (location === "requestId" ? nul : "")),
              {
                input: {
                  n: 1,
                  ...(location === "input" ? { text: "before" + nul + "after" } : {}),
                },
              },
            );
            expect(response.statusCode).toBe(201);
          }).pipe(Effect.provide(StorePostgres(container.getConnectionUri())));
        }),
      ),
    120000,
  );
}
it.effect(
  "repair regression: malformed JCS Unicode and private callback rejection remain fail-closed",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* createFixture();
        const malformed = yield* f.call("", '{"input":{"n":1,"text":"\\ud800"}}');
        expect(malformed.statusCode).toBe(400);
        expect(reason(malformed)).toBe("REQUEST_INVALID");
        const privateCallback = yield* f.call("", {
          input: { n: 1 },
          callback: { url: "http://127.0.0.1/private" },
        });
        expect(reason(privateCallback)).toBe("CALLBACK_NOT_ALLOWED");
        expect(yield* f.store.countQueued("echo")).toBe(0);
      }),
    ),
);
