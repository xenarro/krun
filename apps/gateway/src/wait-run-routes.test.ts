import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { parseGatewayConfig } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { DatabaseError, NotFoundError, type Run, Store } from "@krun/shared/dist/store/index.js";
import { DnsLookup } from "@krun/shared/dist/webhook/index.js";
import { DateTime, Deferred, Effect, Fiber, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { createRunRoutes } from "./create-run-routes.js";
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
  options: { cap?: string; terminalAtInsert?: boolean; deletedFunction?: boolean } = {},
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
    const app = yield* makePublicApp({ routes }).pipe(
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
    };
  });
const run = <A, E>(program: Effect.Effect<A, E, import("effect").Scope.Scope | GatewayShutdown>) =>
  program.pipe(Effect.provide(GatewayShutdownLive));

it.effect("WaitRun returns a terminal FULL Run immediately with200 and no mutation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(
        id(1),
        row(1, { state: "succeeded", result: false, finished_at: DateTime.makeUnsafe(0) }),
      );
      const r = yield* f.call(1, { timeout: "60s" });
      expect(r.statusCode).toBe(200);
      expect(r.json().state).toBe("SUCCEEDED");
      expect(r.json().input).toEqual({ opaque: "private-input" });
      expect(r.json().result).toBe(false);
    }),
  ),
);
it.effect("WaitRun broadcasts a fake Store transition to every waiter without a clock tick", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const a = yield* f.call(1).pipe(Effect.forkScoped);
      const b = yield* f.call(1).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* Queue.take(f.reads);
      expect(yield* Ref.get(f.active)).toBe(1);
      expect(f.attempts()).toBe(1);
      yield* f.complete(1);
      for (const fiber of [a, b]) {
        const r = yield* Fiber.join(fiber);
        expect(r.statusCode).toBe(200);
        expect(r.json().state).toBe("SUCCEEDED");
      }
    }),
  ),
);
it.effect("WaitRun timeout returns200 with the current nonterminal row instead of an error", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const response = yield* f.call(1, { timeout: "500ms" }).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* TestClock.adjust("500 millis");
      const r = yield* Fiber.join(response);
      expect(r.statusCode).toBe(200);
      expect(r.json().state).toBe("QUEUED");
    }),
  ),
);
for (const body of [{ timeout: "999h" }, {}])
  it.effect(`WaitRun caps/defaults ${JSON.stringify(body)} to KRUN_MAX_WAIT`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ cap: "2s" });
        f.rows.set(id(1), row(1));
        const done = yield* Deferred.make<void>();
        const response = yield* f.call(1, body).pipe(
          Effect.tap(() => Deferred.succeed(done, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(f.reads);
        yield* TestClock.adjust("1999 millis");
        expect(yield* Deferred.isDone(done)).toBe(false);
        yield* TestClock.adjust("1 millis");
        expect((yield* Fiber.join(response)).statusCode).toBe(200);
      }),
    ),
  );
it.effect("WaitRun re-reads after one second when a transition hint is lost", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const response = yield* f.call(1).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* f.complete(1, false);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(response)).json().state).toBe("SUCCEEDED");
    }),
  ),
);
it.effect(
  "WaitRun ignores unrelated hints and reads authoritative rows, not notification payloads",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1));
        const done = yield* Deferred.make<void>();
        const response = yield* f.call(1).pipe(
          Effect.tap(() => Deferred.succeed(done, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(f.reads);
        yield* Queue.offer(f.events, { id: id(2), kind: "state" });
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(done)).toBe(false);
        yield* Queue.offer(f.events, { id: id(1), kind: "status" });
        yield* Queue.take(f.reads);
        expect(yield* Deferred.isDone(done)).toBe(false);
        yield* f.complete(1);
        expect((yield* Fiber.join(response)).json().state).toBe("SUCCEEDED");
      }),
    ),
);
it.effect("shutdown answers an in-flight WaitRun at once without cancelling its Run", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const response = yield* f.call(1).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* f.shutdown.finish;
      const r = yield* Fiber.join(response);
      expect(r.statusCode).toBe(200);
      expect(r.json().state).toBe("QUEUED");
      expect(f.rows.get(id(1))?.state).toBe("queued");
    }),
  ),
);
it.effect(
  "WaitRun reauthorizes stored owner/function and hides missing or inaccessible history",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1, { state: "succeeded", finished_at: DateTime.makeUnsafe(0) }));
        for (const [n, who, fn] of [
          [2, "owner", "echo"],
          [1, "other", "echo"],
          [1, "owner", "wrong"],
          [1, "hidden", "-"],
        ] as const) {
          const r = yield* f.call(n, { timeout: "0ms" }, who, fn);
          expect(r.statusCode).toBe(404);
          expect(r.json().error.details[0].reason).toBe("RUN_NOT_FOUND");
        }
        expect((yield* f.call(1, {}, "admin", "-")).statusCode).toBe(200);
        expect((yield* f.call(1, {}, "owner", "-")).json().name).toBe(
          `functions/echo/runs/${id(1)}`,
        );
      }),
    ),
);
it.effect(
  "WaitRun authenticates/scope-checks before validation and rejects undeclared or invalid fields",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1));
        expect((yield* f.call(1, { timeout: "bad" }, "")).statusCode).toBe(401);
        expect((yield* f.call(1, { timeout: "bad" }, "wrong")).statusCode).toBe(403);
        for (const body of [
          null,
          { timeout: null },
          { timeout: "-1s" },
          { timeout: "forever" },
          { timeout: "999999999999999999999h" },
          { extra: true },
        ])
          expect((yield* f.call(1, body)).statusCode).toBe(400);
        expect((yield* f.call(1, { timeout: "0ms" })).statusCode).toBe(200);
      }),
    ),
);
it.effect(
  "CreateRun and WaitRun share one notifier and CreateRun keeps201 for immediate completion",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ terminalAtInsert: true });
        const created = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: "/v1/functions/echo/runs?wait=30s",
            payload: { input: {} },
            headers: { authorization: `Bearer ${f.tokens.owner}` },
          }),
        );
        expect(created.statusCode).toBe(201);
        expect(created.json().state).toBe("SUCCEEDED");
        const waited = yield* Effect.promise(() =>
          f.app.inject({
            method: "POST",
            url: `/v1/${created.json().name}:wait`,
            headers: { authorization: `Bearer ${f.tokens.owner}` },
            payload: { timeout: "30s" },
          }),
        );
        expect(waited.statusCode).toBe(200);
        expect(waited.json()).toEqual(created.json());
        expect(f.attempts()).toBe(1);
        yield* Effect.promise(() => f.app.close());
        expect(yield* Ref.get(f.active)).toBe(0);
      }),
    ),
);
it.effect("notifier reconnects after Store failure while fallback keeps waits correct", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const response = yield* f.call(1).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      yield* Queue.offer(f.events, new DatabaseError({ operation: "subscribe" }));
      yield* Effect.yieldNow;
      yield* f.complete(1, false);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(response)).statusCode).toBe(200);
      yield* Queue.take(f.subscriptions);
      expect(f.attempts()).toBe(2);
      expect(yield* Ref.get(f.active)).toBe(1);
    }),
  ),
);
it.effect("WaitRun accepts an omitted body and reads history after Function deletion", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ deletedFunction: true });
      f.rows.set(id(1), row(1, { state: "cancelled", finished_at: DateTime.makeUnsafe(0) }));
      const response = yield* Effect.promise(() =>
        f.app.inject({
          method: "POST",
          url: `/v1/functions/-/runs/${id(1)}:wait`,
          headers: { authorization: `Bearer ${f.tokens.owner}` },
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("CANCELLED");
    }),
  ),
);
it.effect("WaitRun rechecks authorization on the final authoritative read", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      const response = yield* f.call(1).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      f.rows.set(id(1), row(1, { created_by: "other", state: "succeeded" }));
      yield* Queue.offer(f.events, { id: id(1), kind: "state" });
      const r = yield* Fiber.join(response);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.details[0].reason).toBe("RUN_NOT_FOUND");
      expect(r.body.includes("private-input")).toBe(false);
    }),
  ),
);
it.effect("one notification wakes simultaneous CreateRun and WaitRun with201 and200", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      const created = yield* Effect.promise(() =>
        f.app.inject({
          method: "POST",
          url: "/v1/functions/echo/runs?wait=60s",
          payload: { input: { mixed: true } },
          headers: { authorization: `Bearer ${f.tokens.owner}` },
        }),
      ).pipe(Effect.forkScoped);
      const key = yield* Deferred.await(f.inserted);
      yield* Queue.take(f.reads);
      const waiting = yield* Effect.promise(() =>
        f.app.inject({
          method: "POST",
          url: `/v1/functions/echo/runs/${key}:wait`,
          payload: { timeout: "60s" },
          headers: { authorization: `Bearer ${f.tokens.owner}` },
        }),
      ).pipe(Effect.forkScoped);
      yield* Queue.take(f.reads);
      const current = f.rows.get(key);
      if (!current) return yield* Effect.die("Missing fake admission");
      f.rows.set(key, { ...current, state: "succeeded", finished_at: yield* DateTime.now });
      yield* Queue.offer(f.events, { id: key, kind: "state" });
      const a = yield* Fiber.join(created),
        b = yield* Fiber.join(waiting);
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(200);
      expect(a.json()).toEqual(b.json());
      expect(f.attempts()).toBe(1);
    }),
  ),
);
it.effect("shutdown seals new WaitRun responses before Store reads", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.rows.set(id(1), row(1));
      yield* f.shutdown.finish;
      const r = yield* f.call(1, { timeout: "0ms" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.details[0].reason).toBe("NOT_READY");
    }),
  ),
);
it.effect(
  "disconnecting a native WaitRun client does not cancel the Run and closes owned work",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.rows.set(id(1), row(1));
        const address = yield* Effect.promise(() => f.app.listen({ host: "127.0.0.1", port: 0 }));
        const client = yield* Effect.acquireRelease(
          Effect.sync(() =>
            httpRequest(
              `${address}/v1/functions/echo/runs/${id(1)}:wait`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${f.tokens.owner}`,
                  "content-type": "application/json",
                },
              },
              (response) => response.resume(),
            ),
          ),
          (request) => Effect.sync(() => request.destroy()),
        );
        client.on("error", () => {});
        const closed = new Promise<void>((resolve) => client.once("close", resolve));
        client.end("{}");
        yield* Queue.take(f.reads);
        client.destroy();
        yield* Effect.promise(() => closed);
        expect(f.rows.get(id(1))?.state).toBe("queued");
        yield* Effect.promise(() => f.app.close());
        expect(yield* Ref.get(f.active)).toBe(0);
      }),
    ),
);
