import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { type Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { DatabaseError } from "@krun/shared/dist/store/errors.js";
import { Store, type StoreShape } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { toRun } from "@krun/shared/dist/store/mappers.js";
import { Clock, DateTime, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { InjectOptions } from "fastify";
import { makeInternalApp } from "./internal-app.js";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fixture = (override?: (store: StoreShape) => StoreShape) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1792972800000);
    const store = yield* Store;
    yield* store.migrate();
    const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
    const seed = (
      n: number,
      state:
        | "queued"
        | "scheduled"
        | "running"
        | "cancelling"
        | "cancelled"
        | "succeeded"
        | "failed" = "running",
      token = true,
    ) =>
      Effect.gen(function* () {
        yield* store.createRun({
          id: id(n),
          function_name: "echo",
          input: JSON.parse('{"n":1,"__proto__":{"opaque":true},"nested":[null]}'),
          priority: 0,
          created_by: "test",
          request_hash: "a".repeat(64),
          idempotency_key: null,
          callback_url: null,
          created_at: yield* DateTime.now,
        });
        if (token)
          yield* store.setJobToken(
            id(n),
            "krun-test-p38-job",
            createHash("sha256")
              .update(tokens[(n - 1) % 2] ?? "")
              .digest("hex"),
          );
        if (state === "queued") return;
        yield* store.markScheduled(id(n));
        if (state === "scheduled") return;
        yield* store.transition(id(n), "scheduled", "running", null, {});
        if (state === "running") return;
        if (state === "cancelling" || state === "cancelled") {
          yield* store.transition(id(n), "running", "cancelling", null, {});
          if (state === "cancelled")
            yield* store.transition(id(n), "cancelling", "cancelled", null, {});
        } else
          yield* store.transition(
            id(n),
            "running",
            state,
            state === "failed" ? "exit_code" : null,
            {},
          );
      });
    const logs: string[] = [];
    const app = yield* makeInternalApp({ maxResultBytes: 64 }).pipe(
      Effect.provideService(Store, override ? override(store) : store),
      Effect.provideService(LogDestination, {
        write: (line) => {
          logs.push(line);
        },
      }),
    );
    const call = (operation = "input", options: Partial<InjectOptions> = {}, n = 1) =>
      app.inject({
        method: operation === "input" ? "GET" : operation === "status" ? "POST" : "PUT",
        url: `/internal/v1/runs/${id(n)}/${operation}`,
        headers: {
          authorization: `Bearer ${tokens[0]}`,
          "content-type": "application/json",
          "user-agent": "krun-test-p38-agent",
        },
        ...options,
      });
    return { app, store, tokens, seed, call, logs };
  });
const run = <A, E>(program: Effect.Effect<A, E, Store | Database | import("effect").Scope.Scope>) =>
  Effect.scoped(program).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")))),
  );
const reason = (
  response: { statusCode: number; json: () => unknown },
  code: number,
  expected: string,
) => {
  expect(response.statusCode).toBe(code);
  expect(response.json()).toMatchObject({
    error: {
      code,
      details: [
        {
          reason: expected,
          domain: "krun.io",
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        },
      ],
    },
  });
};

for (const state of ["queued", "scheduled", "running"] as const)
  it.effect(`internal token accepts ${state},GetInput has exact JSON Content-Length`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, state);
        const r = yield* Effect.promise(() => f.call());
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual((yield* f.store.getRun(id(1))).input);
        expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body));
      }),
    ),
  );
for (const state of ["cancelling", "cancelled", "succeeded", "failed"] as const)
  it.effect(`internal token rejects ${state}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, state);
        reason(
          yield* Effect.promise(() => f.call("result", { payload: "false" })),
          401,
          "TOKEN_INVALID",
        );
      }),
    ),
  );
it.effect("internal uniform auth precedes media,size and JSON;route/version precedes auth", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      yield* f.seed(2);
      for (const authorization of [
        undefined,
        "Basic test",
        "Bearer wrong",
        `Bearer ${f.tokens[1]}`,
      ]) {
        reason(
          yield* Effect.promise(() =>
            f.call("result", {
              headers: {
                ...(authorization ? { authorization } : {}),
                "content-type": "text/plain",
                "content-length": "999999",
              },
              payload: "{",
            }),
          ),
          401,
          "TOKEN_INVALID",
        );
      }
      for (const [url, expected] of [
        ["/internal/v2/runs/x/input", "UNSUPPORTED_API_VERSION"],
        ["/internal/v01/runs/x/input", "ROUTE_NOT_FOUND"],
        ["/v1/functions", "ROUTE_NOT_FOUND"],
        [`/internal/v1/runs/${id(1)}/input`, "ROUTE_NOT_FOUND"],
      ] as const)
        reason(
          yield* Effect.promise(() => f.app.inject({ method: "DELETE", url })),
          404,
          expected ?? "",
        );
      for (const runId of ["malformed", id(1).toUpperCase(), id(99)])
        reason(
          yield* Effect.promise(() => f.call("input", { url: `/internal/v1/runs/${runId}/input` })),
          401,
          "TOKEN_INVALID",
        );
      expect(f.logs.join("")).not.toContain(f.tokens[0]);
      expect(f.logs.join("")).toContain("krun-test-p38-agent");
    }),
  ),
);
for (const [operation, payload] of [
  ["status", '{"message":"ok","unknown":1}'],
  ["status", '{"message":""}'],
  ["status", '{"message":"ok","progress":1.01}'],
  ["status", '{"message":"ok","data":[]}'],
  ["status", '{"message":"ok","reportTime":"now"}'],
  ["error", '{"message":"x","source":"KRUN"}'],
  ["error", '{"message":""}'],
  ["result", "null"],
  ["result", "{"],
  ["result", ""],
] as const)
  it.effect(`internal400 ${operation} ${payload}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        reason(yield* Effect.promise(() => f.call(operation, { payload })), 400, "REQUEST_INVALID");
      }),
    ),
  );
for (const [op, size, expected] of [
  ["result", 65, "RESULT_TOO_LARGE"],
  ["status", 16385, "REQUEST_TOO_LARGE"],
  ["error", 32769, "REQUEST_TOO_LARGE"],
] as const)
  it.effect(`internal413 ${op} counted bytes and Connection close`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        const r = yield* Effect.promise(() => f.call(op, { payload: " ".repeat(size) }));
        reason(r, 413, expected);
        expect(r.headers.connection).toBe("close");
      }),
    ),
  );
it.effect("internal415 beats413;500 and503 remain sanitized", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      reason(
        yield* Effect.promise(() =>
          f.call("result", {
            headers: { authorization: `Bearer ${f.tokens[0]}`, "content-type": "text/plain" },
            payload: "x".repeat(100),
          }),
        ),
        415,
        "CONTENT_TYPE_UNSUPPORTED",
      );
      for (const defect of [false, true]) {
        const g = yield* fixture((store) => ({
          ...store,
          setResult: () =>
            defect
              ? Effect.die(new Error("private-diagnostic"))
              : Effect.fail(new DatabaseError({ operation: "setResult" })),
        }));
        const r = yield* Effect.promise(() =>
          g.call("result", {
            headers: { authorization: `Bearer ${f.tokens[0]}`, "content-type": "application/json" },
            payload: "false",
          }),
        );
        reason(r, defect ? 500 : 503, defect ? "INTERNAL" : "NOT_READY");
        expect(r.body).not.toContain("private-diagnostic");
      }
    }),
  ),
);
it.effect("internal results/errors replace without state/events;opaque own keys preserved", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      for (const payload of ["false", "0", '""', '{"__proto__":{"x":1},"n":[null]}'])
        expect((yield* Effect.promise(() => f.call("result", { payload }))).statusCode).toBe(204);
      const error = {
        message: "failed",
        type: "TestError",
        details: JSON.parse('{"__proto__":{"x":1},"n":[null]}'),
      };
      expect(
        (yield* Effect.promise(() => f.call("error", { payload: JSON.stringify(error) })))
          .statusCode,
      ).toBe(204);
      const row = yield* f.store.getRun(id(1));
      expect(row.state).toBe("running");
      expect(row.error).toEqual({ ...error, source: "function" });
      expect(row.result).toEqual(JSON.parse('{"__proto__":{"x":1},"n":[null]}'));
    }),
  ),
);
it.effect(
  "internal status10Hz admits exactly1/sec,replaces wholesale,stores at and renders reportTime",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        const codes: number[] = [];
        for (let i = 0; i < 20; i++) {
          const r = yield* Effect.promise(() =>
            f.call("status", {
              payload: JSON.stringify(
                i === 0
                  ? { message: "first", progress: 0.5, data: { n: 1 } }
                  : { message: `tick${i}` },
              ),
            }),
          );
          codes.push(r.statusCode);
          if (r.statusCode === 429) {
            reason(r, 429, "STATUS_RATE_LIMITED");
            expect(r.headers["retry-after"]).toBe("1");
          }
          yield* TestClock.adjust("100 millis");
        }
        expect(codes.filter((n) => n === 204)).toHaveLength(2);
        expect(codes[0]).toBe(204);
        expect(codes[10]).toBe(204);
        const row = yield* f.store.getRun(id(1));
        expect(row.runtime_status).toEqual({
          message: "tick10",
          at: DateTime.makeUnsafe(1792972801000),
        });
        expect(toRun(row).runtimeStatus).toEqual({
          message: "tick10",
          reportTime: "2026-10-26T00:00:01.000Z",
        });
      }),
    ),
);
it.effect(
  "internal concurrent status admits one;failed writes do not start rate window;guarded false is401",
  () =>
    run(
      Effect.gen(function* () {
        let fails = true;
        const f = yield* fixture((store) => ({
          ...store,
          setRuntimeStatus: (id, status) =>
            fails
              ? Effect.fail(new DatabaseError({ operation: "setRuntimeStatus" }))
              : store.setRuntimeStatus(id, status),
        }));
        yield* f.seed(1);
        reason(
          yield* Effect.promise(() => f.call("status", { payload: '{"message":"x"}' })),
          503,
          "NOT_READY",
        );
        fails = false;
        const replies = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 10 }, () => f.call("status", { payload: '{"message":"x"}' })),
          ),
        );
        expect(replies.filter((r) => r.statusCode === 204)).toHaveLength(1);
        const g = yield* fixture((store) => ({ ...store, setResult: () => Effect.succeed(false) }));
        reason(
          yield* Effect.promise(() =>
            g.call("result", {
              headers: {
                authorization: `Bearer ${f.tokens[0]}`,
                "content-type": "application/json",
              },
              payload: "false",
            }),
          ),
          401,
          "TOKEN_INVALID",
        );
      }),
    ),
);
it.effect("internal stalled Store is interrupted at5s and503 before6s", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const f = yield* fixture((store) => ({
        ...store,
        setResult: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      }));
      yield* f.seed(1);
      const start = yield* Clock.currentTimeMillis;
      const pending = yield* Effect.promise(() => f.call("result", { payload: "false" })).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const r = yield* Fiber.join(pending);
      reason(r, 503, "NOT_READY");
      expect(r.headers["retry-after"]).toBe("1");
      expect(interrupted).toBe(true);
      expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(6000);
    }),
  ),
);

for (const [op, field, limit] of [
  ["status", "message", 1024],
  ["status", "data", 4096],
  ["error", "message", 4096],
  ["error", "type", 128],
  ["error", "details", 8192],
] as const)
  it.effect(`internal compact JSON UTF-8 boundary ${op}.${field}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        for (const over of [false, true]) {
          const object = field === "data" || field === "details";
          // JSON quotes/backslashes count; non-ASCII remains unescaped UTF-8.
          const base = object ? { text: "🧪" } : "🧪";
          const overhead = Buffer.byteLength(JSON.stringify(base));
          const text = "🧪" + "x".repeat(limit - overhead + (over ? 1 : 0));
          const payload = JSON.stringify({ message: "ok", [field]: object ? { text } : text });
          const r = yield* Effect.promise(() => f.call(op, { payload }));
          if (over) reason(r, 400, "REQUEST_INVALID");
          else expect(r.statusCode).toBe(204);
        }
      }),
    ),
  );
it.effect(
  "internal invalid requests never extend status window;zero-row status permits immediate later success",
  () =>
    run(
      Effect.gen(function* () {
        let changed = false;
        const f = yield* fixture((store) => ({
          ...store,
          setRuntimeStatus: (id, status) =>
            changed ? store.setRuntimeStatus(id, status) : Effect.succeed(false),
        }));
        yield* f.seed(1);
        reason(
          yield* Effect.promise(() => f.call("status", { payload: '{"message":"x"}' })),
          401,
          "TOKEN_INVALID",
        );
        changed = true;
        reason(
          yield* Effect.promise(() => f.call("status", { payload: '{"message":""}' })),
          400,
          "REQUEST_INVALID",
        );
        expect(
          (yield* Effect.promise(() => f.call("status", { payload: '{"message":"x"}' })))
            .statusCode,
        ).toBe(204);
        yield* TestClock.adjust("999 millis");
        reason(
          yield* Effect.promise(() => f.call("status", { payload: '{"message":"x"}' })),
          429,
          "STATUS_RATE_LIMITED",
        );
        yield* TestClock.adjust("1 millis");
        expect(
          (yield* Effect.promise(() => f.call("status", { payload: '{"message":"x"}' })))
            .statusCode,
        ).toBe(204);
      }),
    ),
);
it.effect("internal queued without token is uniform401", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1, "queued", false);
      reason(yield* Effect.promise(() => f.call()), 401, "TOKEN_INVALID");
      yield* f.store.setJobToken(
        id(1),
        "krun-test-p38-job",
        createHash("sha256")
          .update(f.tokens[0] ?? "")
          .digest("hex"),
      );
      expect((yield* Effect.promise(() => f.call())).statusCode).toBe(200);
    }),
  ),
);

it.effect("internal queued concurrent status attempts share the post-validation5s bound", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const f = yield* fixture((store) => ({
        ...store,
        setRuntimeStatus: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }));
      yield* f.seed(1);
      const first = yield* Effect.promise(() =>
        f.call("status", { payload: '{"message":"first"}' }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* Effect.promise(() =>
        f.call("status", { payload: '{"message":"second"}' }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      reason(yield* Fiber.join(first), 503, "NOT_READY");
      reason(yield* Fiber.join(second), 503, "NOT_READY");
    }),
  ),
);
