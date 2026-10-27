import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import {
  DatabaseError,
  NotFoundError,
  type Run,
  Store,
  toRunSummary,
} from "@krun/shared/dist/store/index.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { DateTime, Deferred, Effect, Fiber, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { createRunRoutes } from "./create-run-routes.js";
import { publicSchemas } from "./public-contracts.js";
import { GatewayShutdown, GatewayShutdownLive } from "./shutdown.js";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (n: number, patch: Partial<Run> = {}): Run => ({
  id: id(n),
  idempotency_key: null,
  request_hash: "a".repeat(64),
  function_name: "echo",
  input: { opaque: "private-input" },
  state: "queued",
  priority: 0,
  attempt: 0,
  lease_owner: null,
  lease_until: null,
  job_name: null,
  job_token_hash: null,
  result: null,
  result_ref: null,
  error: null,
  log_tail: null,
  failure_reason: null,
  runtime_status: null,
  job_status: null,
  callback_url: null,
  created_by: "owner",
  created_at: DateTime.makeUnsafe(0),
  scheduled_at: null,
  started_at: null,
  finished_at: null,
  ...patch,
});
type Hint = { id: string; kind: "state" | "status" | "job_status" };
const fixture = (
  options: {
    cap?: string;
    terminalAtInsert?: boolean;
    deletedFunction?: boolean;
    transport?: (reply: import("fastify").FastifyReply) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const tokens = Object.fromEntries(
      ["owner", "other", "admin", "wrong", "hidden"].map((n) => [
        n,
        randomBytes(32).toString("hex"),
      ]),
    );
    const keys = yield* makeKeys({
      path: "krun-test-p51-keys",
      read: Effect.succeed(
        Buffer.from(
          JSON.stringify({
            keys: [
              {
                name: "owner",
                key: tokens.owner,
                scopes: ["runs:read", "runs:write"],
                functions: ["echo"],
              },
              { name: "other", key: tokens.other, scopes: ["runs:read"], functions: ["*"] },
              { name: "admin", key: tokens.admin, scopes: ["admin"] },
              { name: "wrong", key: tokens.wrong, scopes: ["runs:write"], functions: ["*"] },
              { name: "hidden", key: tokens.hidden, scopes: ["runs:read"], functions: ["nothing"] },
            ],
          }),
        ),
      ),
    });
    const config = yield* parseGatewayConfig({
      KRUN_NAMESPACE: "krun-test-p51",
      KRUN_API_KEYS_PATH: "krun-test-p51-keys",
      KRUN_DB_MODE: "embedded",
      KRUN_MAX_WAIT: options.cap ?? "60s",
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
          Stream.make({
            type: "sync" as const,
            items: options.deletedFunction
              ? []
              : [
                  {
                    metadata: {
                      name: "echo",
                      namespace: config.KRUN_NAMESPACE,
                      uid: "echo",
                      generation: 1,
                      resourceVersion: "1",
                    },
                    spec: {
                      image: `example.invalid/job@sha256:${"a".repeat(64)}`,
                      inputSchema: { type: "object" },
                    },
                  },
                ],
          }).pipe(Stream.concat(Stream.never)),
      }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    yield* functions.synced;
    const rows = new Map<string, Run>();
    let readBarrier: Effect.Effect<void> = Effect.void;
    const reads = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<Hint | DatabaseError>();
    const subscriptions = yield* Queue.unbounded<void>();
    const active = yield* Ref.make(0);
    let attempts = 0;
    const inserted = yield* Deferred.make<string>();
    const unused = () => Effect.die("Unexpected fake Store operation");
    const store = Store.of({
      createRun: (input) =>
        Effect.gen(function* () {
          const value: Run = {
            ...row(1),
            ...input,
            ...(options.terminalAtInsert
              ? {
                  state: "succeeded" as const,
                  finished_at: input.created_at,
                  result: { roundTrip: true },
                }
              : {}),
          };
          rows.set(input.id, value);
          yield* Queue.offer(events, { id: input.id, kind: "state" });
          yield* Deferred.succeed(inserted, input.id);
          return { run: value, created: true };
        }),
      getRun: (key) =>
        Effect.gen(function* () {
          const value = rows.get(key);
          yield* Queue.offer(reads, key);
          yield* readBarrier;
          return value ?? (yield* new NotFoundError({ id: key }));
        }),
      findRunByRequestId: () => Effect.succeed(undefined),
      countQueued: () => Effect.succeed(0),
      countQueuedBy: () => Effect.succeed(0),
      subscribe: () =>
        Stream.unwrap(
          Effect.acquireRelease(
            Ref.update(active, (n) => n + 1).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  attempts++;
                }),
              ),
              Effect.andThen(Queue.offer(subscriptions, undefined)),
              Effect.as(
                Stream.fromQueue(events).pipe(
                  Stream.mapEffect((event) =>
                    event instanceof DatabaseError ? Effect.fail(event) : Effect.succeed(event),
                  ),
                ),
              ),
            ),
            () => Ref.update(active, (n) => n - 1),
          ),
        ),
      listRuns: unused,
      listByState: unused,
      countByState: unused,
      claimQueued: unused,
      releaseLease: unused,
      setJobToken: unused,
      markScheduled: unused,
      transition: unused,
      setRuntimeStatus: unused,
      setResult: unused,
      setError: unused,
      setJobStatus: unused,
      expireQueued: unused,
      listStale: unused,
      claimDeliveries: unused,
      updateDelivery: unused,
      sweep: unused,
      migrate: unused,
    });
    const shutdown = yield* GatewayShutdown;
    const routes = yield* createRunRoutes(config).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(DnsLookup, { lookup: () => Effect.succeed([]) }),
    );
    const logs: string[] = [];
    const app = yield* makePublicApp({
      routes: async (server) => {
        server.addHook("preHandler", async (request, reply) => {
          if (request.routeOptions.schema?.operationId === "WatchRun") options.transport?.(reply);
        });
        server.register(routes);
      },
    }).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(Keys, keys),
      Effect.provideService(Functions, functions),
      Effect.provideService(LogDestination, {
        write: (line) => {
          logs.push(line);
        },
      }),
    );
    yield* Queue.take(subscriptions);
    const call = (n: number, body: unknown = {}, who = "owner", fn = "echo") =>
      Effect.promise(() =>
        app.inject({
          method: "POST",
          url: `/v1/functions/${fn}/runs/${id(n)}:wait`,
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}),
          },
        }),
      );
    const complete = (n: number, hint = true) =>
      Effect.gen(function* () {
        const current = rows.get(id(n));
        if (!current) return yield* Effect.die("Missing fake Run");
        rows.set(current.id, {
          ...current,
          state: "succeeded",
          finished_at: yield* DateTime.now,
          result: { done: true },
        });
        if (hint) yield* Queue.offer(events, { id: current.id, kind: "state" });
      });
    return {
      app,
      call,
      rows,
      reads,
      events,
      subscriptions,
      active,
      attempts: () => attempts,
      complete,
      shutdown,
      inserted,
      tokens,
      logs,
      blockReads: () => {
        readBarrier = Effect.never;
      },
    };
  });
const run = <A, E>(program: Effect.Effect<A, E, import("effect").Scope.Scope | GatewayShutdown>) =>
  program.pipe(Effect.provide(GatewayShutdownLive));

// Native bytes are consumed incrementally while the handler keeps the Effect
// test clock. No real-time delay or mock timer is needed for fallback/keepalive.
const connect = (
  f: { app: import("fastify").FastifyInstance; tokens: Record<string, string> },
  n = 1,
  who = "owner",
  fn = "echo",
) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<string>();
    const emit = Effect.runSyncWith(yield* Effect.context());
    const address = f.app.server.listening
      ? `http://127.0.0.1:${(f.app.server.address() as import("node:net").AddressInfo).port}`
      : yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
    let pending = "";
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    let resolveResponse!: (response: import("node:http").IncomingMessage) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const client = httpRequest(
          `${address}/v1/functions/${fn}/runs/${id(n)}:watch`,
          {
            headers: {
              authorization: `Bearer ${f.tokens[who] ?? who}`,
              "last-event-id": "ignored",
              "x-request-id": "krun-test-watch-request",
            },
          },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              pending += chunk;
              let boundary = pending.indexOf("\n\n");
              while (boundary !== -1) {
                emit(Queue.offer(frames, pending.slice(0, boundary)));
                pending = pending.slice(boundary + 2);
                boundary = pending.indexOf("\n\n");
              }
            });
            res.once("end", resolveEnd);
            res.once("close", resolveEnd);
            res.on("error", () => {});
            resolveResponse(res);
          },
        );
        client.on("error", rejectResponse);
        client.end();
        return client;
      }),
      (client) => Effect.sync(() => client.destroy()),
    );
    const res = yield* Effect.promise(() => response);
    return {
      client,
      response: res,
      frames,
      next: Queue.take(frames),
      ended: Effect.promise(() => ended),
    };
  });
const event = (frame: string) => ({
  kind: /^event: (.+)$/m.exec(frame)?.[1],
  id: /^id: (.+)$/m.exec(frame)?.[1],
  data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "null"),
});

it.effect("WatchRun terminal-at-connect emits exactly one BASIC state then EOF", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(
        id(1),
        row(1, {
          state: "succeeded",
          finished_at: DateTime.makeUnsafe(4000),
          input: { private: true },
          result: { private: true },
          log_tail: "private",
          error: { source: "function", message: "safe", details: { private: true } },
        }),
      );
      const c = yield* connect(f);
      expect(c.response.statusCode).toBe(200);
      expect(c.response.headers["content-type"]).toBe("text/event-stream");
      expect(c.response.headers["cache-control"]).toBe("no-store");
      expect(c.response.headers["x-request-id"]).toBe("krun-test-watch-request");
      const first = event(yield* c.next);
      expect(first.kind).toBe("state");
      expect(first.id).toBe("1970-01-01T00:00:04.000Z");
      expect(first.data.state).toBe("SUCCEEDED");
      expect(first.data).not.toHaveProperty("input");
      expect(first.data).not.toHaveProperty("result");
      expect(first.data).not.toHaveProperty("logTail");
      expect(first.data.error).not.toHaveProperty("details");
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
    }),
  ),
);

it.effect("WatchRun reads state, status, job_status and terminal state then EOF", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      expect(c.response.statusCode).toBe(200);
      expect(event(yield* c.next)).toMatchObject({
        kind: "state",
        id: "1970-01-01T00:00:00.000Z",
        data: { state: "QUEUED" },
      });
      f.rows.set(
        id(1),
        row(1, { runtime_status: { message: "working", at: DateTime.makeUnsafe(1000) } }),
      );
      yield* Queue.offer(f.events, { id: id(1), kind: "status" });
      const status = event(yield* c.next);
      expect(status.kind).toBe("status");
      expect(status.id).toBe("1970-01-01T00:00:01.000Z");
      expect(status.data.runtimeStatus.message).toBe("working");
      expect(status.data).not.toHaveProperty("input");
      const previous = f.rows.get(id(1));
      if (!previous) return yield* Effect.die("Missing test row");
      f.rows.set(id(1), {
        ...previous,
        job_status: { phase: "Running", observedAt: DateTime.makeUnsafe(2000) },
      });
      yield* Queue.offer(f.events, { id: id(1), kind: "job_status" });
      expect(event(yield* c.next)).toMatchObject({
        kind: "job_status",
        id: "1970-01-01T00:00:02.000Z",
      });
      yield* f.complete(1);
      expect(event(yield* c.next)).toMatchObject({ kind: "state", data: { state: "SUCCEEDED" } });
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
      expect(f.attempts()).toBe(1);
    }),
  ),
);

it.effect(
  "WatchRun fallback reads lost hints and keepalive is every15seconds independent of hints",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1));
        const c = yield* connect(f);
        expect(event(yield* c.next).kind).toBe("state");
        f.rows.set(
          id(1),
          row(1, { runtime_status: { message: "lost hint", at: DateTime.makeUnsafe(1) } }),
        );
        yield* TestClock.adjust("1 second");
        expect(event(yield* c.next).kind).toBe("status");
        yield* TestClock.adjust("13 seconds");
        expect(yield* Queue.size(c.frames)).toBe(0);
        yield* TestClock.adjust("1 second");
        expect(yield* c.next).toBe(": keepalive");
        yield* f.shutdown.finish;
        yield* c.ended;
      }),
    ),
);

it.effect("WatchRun coalesces unchanged groups including job observation-only timestamps", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(
        id(1),
        row(1, { job_status: { phase: "Pending", observedAt: DateTime.makeUnsafe(1000) } }),
      );
      const c = yield* connect(f);
      yield* c.next;
      f.rows.set(
        id(1),
        row(1, { job_status: { phase: "Pending", observedAt: DateTime.makeUnsafe(2000) } }),
      );
      yield* Queue.offer(f.events, { id: id(1), kind: "job_status" });
      yield* TestClock.adjust("1 second");
      yield* f.shutdown.finish;
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
    }),
  ),
);

it.effect("WatchRun fan-out shares one subscription and disconnect preserves sibling and Run", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const a = yield* connect(f),
        b = yield* connect(f);
      yield* a.next;
      yield* b.next;
      a.client.destroy();
      a.response.destroy();
      yield* a.ended;
      expect(f.rows.get(id(1))?.state).toBe("queued");
      yield* f.complete(1);
      expect(event(yield* b.next).data.state).toBe("SUCCEEDED");
      yield* b.ended;
      expect(f.attempts()).toBe(1);
      expect(yield* Ref.get(f.active)).toBe(1);
    }),
  ),
);

it.effect("WatchRun validates auth and stored history before opening SSE", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ deletedFunction: true });
      f.rows.set(id(1), row(1, { state: "cancelled", finished_at: DateTime.makeUnsafe(0) }));
      for (const [who, fn, code] of [
        ["other", "echo", 404],
        ["hidden", "-", 404],
        ["wrong", "echo", 403],
        ["owner", "wrong", 404],
      ] as const) {
        const r = yield* Effect.promise(() =>
          f.app.inject({
            method: "GET",
            url: `/v1/functions/${fn}/runs/${id(1)}:watch`,
            headers: { authorization: `Bearer ${f.tokens[who]}` },
          }),
        );
        expect(r.statusCode).toBe(code);
        expect(r.headers["content-type"]).toContain("application/json");
        expect(r.body.includes("private-input")).toBe(false);
      }
      const c = yield* connect(f, 1, "owner", "-");
      expect(c.response.statusCode).toBe(200);
      expect(event(yield* c.next).data.state).toBe("CANCELLED");
      yield* c.ended;
    }),
  ),
);

it.effect("WatchRun closes without an error envelope if a later read loses authorization", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      yield* c.next;
      f.rows.set(
        id(1),
        row(1, {
          created_by: "other",
          runtime_status: { message: "hidden", at: DateTime.makeUnsafe(1000) },
        }),
      );
      yield* Queue.offer(f.events, { id: id(1), kind: "status" });
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
      expect(f.logs.join("\n")).not.toContain("private-input");
    }),
  ),
);

for (const [state, field, timestamp] of [
  ["queued", "created_at", 0],
  ["scheduled", "scheduled_at", 1000],
  ["running", "started_at", 2000],
  ["cancelling", "created_at", 3000],
  ["failed", "finished_at", 4000],
  ["cancelled", "finished_at", 5000],
] as const)
  it.effect(`WatchRun ${state} event uses its own field time`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1, { state, [field]: DateTime.makeUnsafe(timestamp) }));
        yield* TestClock.adjust("7 seconds");
        const c = yield* connect(f);
        const first = event(yield* c.next);
        expect(first.id).toBe(
          DateTime.formatIso(DateTime.makeUnsafe(state === "cancelling" ? 7000 : timestamp)),
        );
        expect(first.data.state).toBe(state.toUpperCase());
        yield* f.shutdown.finish;
        yield* c.ended;
      }),
    ),
  );

it.effect("WatchRun sends all observed groups before the terminal state closes the stream", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      yield* c.next;
      f.rows.set(
        id(1),
        row(1, {
          state: "failed",
          finished_at: DateTime.makeUnsafe(9000),
          runtime_status: { message: "final", at: DateTime.makeUnsafe(7000) },
          job_status: { phase: "Failed", exitCode: 1, observedAt: DateTime.makeUnsafe(8000) },
        }),
      );
      yield* Queue.offer(f.events, { id: id(1), kind: "state" });
      expect(event(yield* c.next)).toMatchObject({
        kind: "status",
        id: "1970-01-01T00:00:07.000Z",
      });
      expect(event(yield* c.next)).toMatchObject({
        kind: "job_status",
        id: "1970-01-01T00:00:08.000Z",
      });
      expect(event(yield* c.next)).toMatchObject({ kind: "state", id: "1970-01-01T00:00:09.000Z" });
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
    }),
  ),
);

for (const mode of ["deadline", "shutdown"] as const)
  it.effect(`a genuinely paused native SSE reader is bounded by ${mode}`, () =>
    run(
      Effect.gen(function* () {
        let writes = 0;
        let raw: import("node:http").ServerResponse | undefined;
        const wrote = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const observe = Effect.runSyncWith(yield* Effect.context());
        const f = yield* fixture({
          transport: (reply) => {
            raw = reply.raw;
            const original = reply.raw.write.bind(reply.raw);
            reply.raw.write = (frame: string) => {
              writes++;
              const accepted = original(frame);
              if (!accepted) observe(Deferred.succeed(wrote, undefined));
              return accepted;
            };
            reply.raw.once("close", () => observe(Deferred.succeed(stopped, undefined)));
          },
        });
        // Larger than loopback socket buffers: the client below really stops
        // consuming, not a stub that labels every write as backpressured.
        f.rows.set(
          id(1),
          row(1, {
            job_status: {
              phase: "Pending",
              message: "x".repeat(16777216),
              observedAt: DateTime.makeUnsafe(0),
            },
          }),
        );
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const client = yield* Effect.acquireRelease(
          Effect.sync(() =>
            httpRequest(`${address}/v1/functions/echo/runs/${id(1)}:watch`, {
              headers: { authorization: `Bearer ${f.tokens.owner}` },
            }),
          ),
          (client) => Effect.sync(() => client.destroy()),
        );
        const incoming = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
          client.once("response", (response) => {
            response.pause();
            response.on("error", () => {});
            resolve(response);
          });
          client.once("error", reject);
        });
        client.end();
        const response = yield* Effect.promise(() => incoming);
        yield* Effect.addFinalizer(() => Effect.sync(() => response.destroy()));
        yield* Deferred.await(wrote);
        expect(raw?.writableNeedDrain).toBe(true);
        expect(writes).toBe(1);
        if (mode === "deadline") {
          yield* TestClock.adjust("1999 millis");
          expect(raw?.destroyed).toBe(false);
          yield* TestClock.adjust("1 millis");
        } else yield* f.shutdown.finish;
        yield* Deferred.await(stopped);
        expect(raw?.destroyed).toBe(true);
        expect(raw?.listenerCount("drain")).toBe(0);
        expect(writes).toBe(1);
        yield* f.shutdown.finish;
        expect(f.rows.get(id(1))?.state).toBe("queued");
      }),
    ),
  );

it.effect("WatchRun seals new streams and returns an envelope after shutdown", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      yield* f.shutdown.finish;
      const r = yield* Effect.promise(() =>
        f.app.inject({
          method: "GET",
          url: `/v1/functions/echo/runs/${id(1)}:watch`,
          headers: { authorization: `Bearer ${f.tokens.owner}` },
        }),
      );
      expect(r.statusCode).toBe(503);
      expect(r.json().error.details[0].reason).toBe("NOT_READY");
    }),
  ),
);

it.effect("closing the public app ends native SSE and releases the single subscriber", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      yield* c.next;
      yield* Effect.promise(() => f.app.close());
      yield* c.ended;
      expect(yield* Ref.get(f.active)).toBe(0);
      expect(f.rows.get(id(1))?.state).toBe("queued");
    }),
  ),
);

it.effect("WatchRun recovers lost Store subscription hints through fallback and retry", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      yield* c.next;
      yield* Queue.offer(f.events, new DatabaseError({ operation: "subscribe" }));
      yield* Effect.yieldNow;
      yield* f.complete(1, false);
      yield* TestClock.adjust("1 second");
      expect(event(yield* c.next).data.state).toBe("SUCCEEDED");
      yield* c.ended;
      yield* Queue.take(f.subscriptions);
      expect(f.attempts()).toBe(2);
    }),
  ),
);

it.effect(
  "WatchRun rejects missing rows,invalid requests and missing keys with normal envelopes",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const [suffix, headers, code] of [
          ["", {}, 401],
          ["", { authorization: `Bearer ${f.tokens.owner}` }, 404],
          ["?unknown=true", { authorization: `Bearer ${f.tokens.owner}` }, 400],
        ] as const) {
          const response = yield* Effect.promise(() =>
            f.app.inject({
              method: "GET",
              url: `/v1/functions/echo/runs/${id(1)}:watch${suffix}`,
              headers,
            }),
          );
          expect(response.statusCode).toBe(code);
          expect(response.headers["content-type"]).toContain("application/json");
          expect(response.json()).toHaveProperty("error.details.0.reason");
        }
      }),
    ),
);

it.effect("shutdown interrupts a blocked initial WatchRun read before headers", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      f.blockReads();
      const pending = yield* connect(f).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* f.shutdown.finish;
      const c = yield* Fiber.join(pending);
      expect(c.response.statusCode).toBe(503);
      expect(c.response.headers["content-type"]).toContain("application/json");
      yield* c.ended;
    }),
  ),
);

it.effect("shutdown interrupts a blocked streaming reread and ends SSE without an envelope", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const c = yield* connect(f);
      yield* c.next;
      yield* Queue.take(f.reads);
      f.blockReads();
      yield* Queue.offer(f.events, { id: id(1), kind: "status" });
      yield* Queue.take(f.reads);
      yield* f.shutdown.finish;
      yield* c.ended;
      expect(yield* Queue.size(c.frames)).toBe(0);
    }),
  ),
);

for (const state of ["queued", "failed"] as const)
  it.effect(
    `a normal reader receives a legal large ${state} BASIC snapshot on connect and reconnect`,
    () =>
      run(
        Effect.gen(function* () {
          const writes: { bytes: number; accepted: boolean; highWaterMark: number }[] = [];
          let response: import("node:http").ServerResponse | undefined;
          const f = yield* fixture({
            transport: (reply) => {
              response = reply.raw;
              const original = reply.raw.write.bind(reply.raw);
              reply.raw.write = (frame: string) => {
                const accepted = original(frame);
                writes.push({
                  bytes: Buffer.byteLength(frame),
                  accepted,
                  highWaterMark: reply.raw.writableHighWaterMark,
                });
                return accepted;
              };
            },
          });
          const value = row(1, {
            state,
            finished_at: state === "failed" ? DateTime.makeUnsafe(1000) : null,
            job_status: {
              phase: "Failed",
              message: "x".repeat(131072),
              observedAt: DateTime.makeUnsafe(1000),
            },
          });
          expect(publicSchemas.RunSummary.safeParse(toRunSummary(value)).success).toBe(true);
          f.rows.set(id(1), value);
          for (let attempt = 0; attempt < 2; attempt++) {
            const c = yield* connect(f);
            const snapshot = event(yield* c.next);
            expect(snapshot.kind).toBe("state");
            expect(snapshot.data.jobStatus.message).toHaveLength(131072);
            expect(snapshot.data).not.toHaveProperty("input");
            if (state === "queued") {
              c.client.destroy();
              c.response.destroy();
            }
            yield* c.ended;
            expect(yield* Queue.size(c.frames)).toBe(0);
            expect(response?.listenerCount("drain")).toBe(0);
          }
          expect(writes).toHaveLength(2);
          expect(
            writes.every((write) => write.bytes > write.highWaterMark && !write.accepted),
          ).toBe(true);
        }),
      ),
  );
