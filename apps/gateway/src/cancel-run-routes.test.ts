import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import {
  type DatabaseError,
  type Run,
  type SqliteTables,
  type State,
  Store,
  type StoreShape,
  toRun,
} from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { DateTime, Effect, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { cancelRunRoutes } from "./cancel-run-routes.js";
import { runReadRoutes } from "./run-read-routes.js";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
const fixture = (
  options: {
    beforeReadReturn?: (store: StoreShape, row: Run) => Effect.Effect<unknown, DatabaseError>;
    afterCancelWin?: (store: StoreShape, id: string) => Effect.Effect<unknown, DatabaseError>;
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const tokens = Object.fromEntries(
      ["owner", "other", "admin", "reader", "limited"].map((n) => [
        n,
        randomBytes(32).toString("hex"),
      ]),
    );
    const config = {
      keys: [
        {
          name: "owner",
          key: tokens.owner,
          scopes: ["runs:write"],
          functions: ["alpha", "deleted"],
        },
        { name: "other", key: tokens.other, scopes: ["runs:write"], functions: ["*"] },
        { name: "admin", key: tokens.admin, scopes: ["admin"] },
        { name: "reader", key: tokens.reader, scopes: ["runs:read"], functions: ["*"] },
        { name: "limited", key: tokens.limited, scopes: ["runs:write"], functions: ["nothing"] },
      ],
    };
    const file = yield* Ref.make(Buffer.from(JSON.stringify(config)));
    const keys = yield* makeKeys({ path: "krun-test-p35-keys", read: Ref.get(file) });
    const functions = yield* makeFunctions({
      namespace: "krun-test-p35",
      ceilings: {
        maxActiveDeadline: 86400,
        maxQueued: 1000,
        allowedRegistries: [],
        allowedServiceAccounts: ["krun-job-default"],
        webhookAllowedHosts: [],
      },
    }).pipe(
      Effect.provideService(FunctionSource, { watch: () => Stream.never }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    const actual = yield* Store;
    yield* actual.migrate();
    let interleaved = false;
    // Observation/interleaving only: every read, CAS and returned value comes
    // from the actual Store. Competing updates commit between real operations.
    const observed: StoreShape = {
      ...actual,
      getRun: (runId) =>
        actual.getRun(runId).pipe(
          Effect.tap((row) => {
            if (options.beforeReadReturn && !interleaved) {
              interleaved = true;
              return options.beforeReadReturn(actual, row);
            }
            return Effect.void;
          }),
        ),
      transition: (...args) =>
        actual
          .transition(...args)
          .pipe(
            Effect.tap((changed) =>
              changed && args[2] === "cancelling" && options.afterCancelWin
                ? options.afterCancelWin(actual, args[0])
                : Effect.void,
            ),
          ),
    };
    const logs: string[] = [];
    const app = yield* makePublicApp({
      routes: async (server) => {
        server.register(runReadRoutes);
        server.register(cancelRunRoutes);
      },
    }).pipe(
      Effect.provideService(Store, observed),
      Effect.provideService(Keys, keys),
      Effect.provideService(Functions, functions),
      Effect.provideService(LogDestination, {
        write(line) {
          logs.push(line);
        },
      }),
    );
    const call = (n: number, who = "owner", fn = "alpha", body: unknown = {}, query = "") =>
      app.inject({
        method: "POST",
        url: `/v1/functions/${fn}/runs/${id(n)}:cancel${query}`,
        headers: who
          ? { authorization: `Bearer ${tokens[who] ?? who}`, "content-type": "application/json" }
          : { "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
    const seed = (n: number, state: State = "queued", owner = "owner", fn = "alpha") =>
      Effect.gen(function* () {
        yield* actual.createRun({
          id: id(n),
          idempotency_key: null,
          request_hash: "a".repeat(64),
          function_name: fn,
          created_by: owner,
          input: JSON.parse(
            '{"privateInput":"krun-test-p35-secret-input","nul":"\\u0000","__proto__":{"opaque":true}}',
          ),
          priority: 0,
          callback_url: "https://example.invalid/krun-test-p35-callback",
          created_at: at,
        });
        if (state !== "queued") {
          yield* actual.setJobToken(id(n), "krun-test-p35-job", "b".repeat(64));
          yield* actual.markScheduled(id(n));
          if (state !== "scheduled") {
            yield* actual.transition(id(n), "scheduled", "running", null, {});
            if (state === "cancelling" || state === "cancelled")
              yield* actual.transition(
                id(n),
                "running",
                "cancelling",
                null,
                {},
                { actor: "prior-actor" },
              );
            if (state === "cancelled")
              yield* actual.transition(id(n), "cancelling", "cancelled", null, {});
            if (state === "succeeded")
              yield* actual.transition(id(n), "running", "succeeded", null, {});
            if (state === "failed")
              yield* actual.transition(id(n), "running", "failed", "exit_code", {});
          }
        }
      });
    const events = (n: number) =>
      Effect.flatMap(Database, ({ db }) =>
        Effect.tryPromise({
          try: () =>
            db
              .withTables<SqliteTables>()
              .selectFrom("run_events")
              .selectAll()
              .where("run_id", "=", id(n))
              .orderBy("rowid")
              .execute(),
          catch: () => new Error("Owned event read failed"),
        }),
      );
    return { actual, app, call, seed, events, tokens, logs, file, config };
  });
const run = <A, E>(body: Effect.Effect<A, E, Store | Database | import("effect").Scope.Scope>) =>
  Effect.scoped(body).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")))),
  );
const payload = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);

for (const state of ["queued", "scheduled", "running"] as const)
  it.effect(
    `CancelRun ${state} returns FULL CANCELLING and exactly one actor event without terminal side effects`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.seed(1, state);
          const before = yield* f.events(1);
          const response = yield* Effect.promise(() => f.call(1));
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual(toRun(yield* f.actual.getRun(id(1))));
          expect(response.json().state).toBe("CANCELLING");
          expect(response.json().input.nul).toBe("\0");
          expect(Object.hasOwn(response.json().input, "__proto__")).toBe(true);
          expect(response.json()).not.toHaveProperty("endTime");
          const events = yield* f.events(1);
          expect(events).toHaveLength(before.length + 1);
          const changed = events.filter((e) => e.to_state === "cancelling");
          expect(changed).toHaveLength(1);
          expect(payload(changed[0]?.payload)).toEqual({ actor: "owner" });
          expect(changed[0]?.from_state).toBe(state);
          const deliveries = yield* Effect.flatMap(Database, ({ db }) =>
            Effect.promise(() =>
              db.withTables<SqliteTables>().selectFrom("deliveries").selectAll().execute(),
            ),
          );
          expect(deliveries).toHaveLength(0);
          for (const field of [
            "job_token_hash",
            "lease_owner",
            "request_hash",
            "idempotency_key_nul",
          ])
            expect(response.json()).not.toHaveProperty(field);
        }),
      ),
  );
for (const state of ["cancelling", "cancelled"] as const)
  it.effect(`CancelRun already ${state} is 200 FULL with no new transition or delivery`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, state);
        const before = yield* f.events(1);
        const first = yield* Effect.promise(() => f.call(1));
        const second = yield* Effect.promise(() => f.call(1));
        expect(first.statusCode).toBe(200);
        expect(second.json()).toEqual(first.json());
        expect(first.json()).toEqual(toRun(yield* f.actual.getRun(id(1))));
        expect(yield* f.events(1)).toEqual(before);
      }),
    ),
  );
for (const state of ["succeeded", "failed"] as const)
  it.effect(
    `CancelRun ${state} is 400 FAILED_PRECONDITION RUN_TERMINAL with state and no mutation`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.seed(1, state);
          const before = yield* f.events(1);
          const response = yield* Effect.promise(() => f.call(1));
          expect(response.statusCode).toBe(400);
          expect(response.json().error.status).toBe("FAILED_PRECONDITION");
          expect(response.json().error.details[0]).toMatchObject({
            reason: "RUN_TERMINAL",
            metadata: { state: state.toUpperCase() },
          });
          expect(yield* f.events(1)).toEqual(before);
          expect((yield* f.actual.getRun(id(1))).state).toBe(state);
        }),
      ),
  );
it.effect("CancelRun preserves false result and opaque FULL error/status fields", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1, "running");
      yield* f.actual.setResult(id(1), false);
      yield* f.actual.setError(id(1), {
        source: "function",
        message: "",
        type: "opaque-type",
        details: { privateDetails: [null, 0] },
      });
      yield* f.actual.setRuntimeStatus(id(1), {
        progress: 0,
        message: "",
        data: { opaque: [false, null] },
        at,
      });
      const response = yield* Effect.promise(() => f.call(1));
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toBe(false);
      expect(response.json().error.details).toEqual({ privateDetails: [null, 0] });
      expect(response.json().runtimeStatus.progress).toBe(0);
      expect(response.json()).toEqual(toRun(yield* f.actual.getRun(id(1))));
      expect(response.json()).not.toHaveProperty("resultUri");
    }),
  ),
);
it.effect("Repeat/concurrent CancelRun adds only one cancelling transition", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      const results = yield* Effect.promise(() =>
        Promise.all(Array.from({ length: 20 }, () => f.call(1))),
      );
      expect(results.every((r) => r.statusCode === 200 && r.json().state === "CANCELLING")).toBe(
        true,
      );
      expect((yield* f.events(1)).filter((e) => e.to_state === "cancelling")).toHaveLength(1);
      expect((yield* f.actual.getRun(id(1))).state).toBe("cancelling");
    }),
  ),
);
it.effect(
  "Wildcard resolves stored function without cache readiness and successful audit names it",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "queued", "owner", "deleted");
        const response = yield* Effect.promise(() => f.call(1, "owner", "-"));
        expect(response.statusCode).toBe(200);
        expect(response.json().name).toBe(`functions/deleted/runs/${id(1)}`);
        expect(
          f.logs
            .map((line) => JSON.parse(line))
            .find((line) => line.event === "http_request" && line.code === 200),
        ).toMatchObject({ function: "deleted", run_id: id(1), key: "owner" });
        expect(Object.values(f.tokens).some((t) => f.logs.join("").includes(t))).toBe(false);
        expect(f.logs.join("")).not.toContain("krun-test-p35-secret-input");
      }),
    ),
);
it.effect(
  "Missing, wrong parent, foreign owner and denied stored function are indistinguishable without transitions",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        yield* f.seed(2, "queued", "other");
        yield* f.seed(3, "queued", "owner", "beta");
        const results = yield* Effect.promise(() =>
          Promise.all([
            f.call(99),
            f.call(1, "owner", "deleted"),
            f.call(2),
            f.call(3, "owner", "-"),
          ]),
        );
        for (const r of results) {
          expect(r.statusCode).toBe(404);
          expect(r.json().error.details[0].reason).toBe("RUN_NOT_FOUND");
          expect(r.json().error.message).toBe(results[0]?.json().error.message);
        }
        for (const n of [1, 2, 3]) expect((yield* f.actual.getRun(id(n))).state).toBe("queued");
      }),
    ),
);
it.effect(
  "Admin may cancel foreign runs but event actor is caller, not original owner; parent still matters",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "queued", "other");
        const bad = yield* Effect.promise(() => f.call(1, "admin", "deleted"));
        expect(bad.statusCode).toBe(404);
        const good = yield* Effect.promise(() => f.call(1, "admin", "-"));
        expect(good.statusCode).toBe(200);
        const event = (yield* f.events(1)).find((e) => e.to_state === "cancelling");
        expect(payload(event?.payload)).toEqual({ actor: "admin" });
      }),
    ),
);
it.effect("Lost CAS re-reads scheduler advancement and cancels current scheduled state", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({ beforeReadReturn: (s, row) => s.markScheduled(row.id) });
      yield* f.seed(1);
      const response = yield* Effect.promise(() => f.call(1));
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("CANCELLING");
      const event = (yield* f.events(1)).find((e) => e.to_state === "cancelling");
      expect(event?.from_state).toBe("scheduled");
      expect(payload(event?.payload)).toEqual({ actor: "owner" });
    }),
  ),
);
for (const state of ["succeeded", "failed"] as const)
  it.effect(
    `Lost CAS observes actual ${state} and reports RUN_TERMINAL, never a stale success`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({
            beforeReadReturn: (s, row) =>
              s.transition(row.id, "running", state, state === "failed" ? "exit_code" : null, {}),
          });
          yield* f.seed(1, "running");
          const response = yield* Effect.promise(() => f.call(1));
          expect(response.statusCode).toBe(400);
          expect(response.json().error.details[0]).toMatchObject({
            reason: "RUN_TERMINAL",
            metadata: { state: state.toUpperCase() },
          });
          expect((yield* f.events(1)).filter((e) => e.to_state === "cancelling")).toHaveLength(0);
        }),
      ),
  );
it.effect("A peer cancellation winning CAS is an idempotent 200 without replacing its actor", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture({
        beforeReadReturn: (s, row) =>
          s.transition(row.id, row.state, "cancelling", null, {}, { actor: "peer-admin" }),
      });
      yield* f.seed(1);
      const response = yield* Effect.promise(() => f.call(1));
      expect(response.statusCode).toBe(200);
      const events = (yield* f.events(1)).filter((e) => e.to_state === "cancelling");
      expect(events).toHaveLength(1);
      expect(payload(events[0]?.payload)).toEqual({ actor: "peer-admin" });
    }),
  ),
);
it.effect(
  "Scheduler finishing after a winning cancel returns current CANCELLED with the accepted result",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          afterCancelWin: (s, runId) => s.transition(runId, "cancelling", "cancelled", null, {}),
        });
        yield* f.seed(1, "running");
        yield* f.actual.setResult(id(1), false);
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(200);
        expect(response.json().state).toBe("CANCELLED");
        expect(response.json().result).toBe(false);
        expect((yield* f.events(1)).filter((e) => e.to_state === "cancelling")).toHaveLength(1);
      }),
    ),
);
it.effect("Current grant reload applies before mutation", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      const key = f.config.keys[0];
      if (key?.functions) key.functions = ["nothing"];
      yield* Ref.set(f.file, Buffer.from(JSON.stringify(f.config)));
      yield* TestClock.adjust("30 seconds");
      const response = yield* Effect.promise(() => f.call(1, "owner", "-"));
      expect(response.statusCode).toBe(404);
      expect((yield* f.actual.getRun(id(1))).state).toBe("queued");
    }),
  ),
);
it.effect(
  "Auth, scope and strict body/query validation use canonical errors without mutation",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1);
        for (const [who, body, query, code, reason] of [
          ["", {}, "", 401, "KEY_MISSING"],
          ["invalid-token", {}, "", 401, "KEY_INVALID"],
          ["reader", {}, "", 403, "SCOPE_MISSING"],
          ["owner", null, "", 400, "REQUEST_INVALID"],
          ["owner", { state: "CANCELLED" }, "", 400, "REQUEST_INVALID"],
          ["owner", {}, "?view=BASIC", 400, "REQUEST_INVALID"],
          ["owner", {}, "?unknown=1", 400, "REQUEST_INVALID"],
        ] as const) {
          const r = yield* Effect.promise(() => f.call(1, who, "alpha", body, query));
          expect(r.statusCode).toBe(code);
          expect(r.json().error.details[0].reason).toBe(reason);
        }
        expect((yield* f.actual.getRun(id(1))).state).toBe("queued");
      }),
    ),
);
it.effect("Real transaction failure rolls back row/event/delivery and remains INTERNAL", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1);
      yield* Effect.flatMap(Database, ({ db }) =>
        Effect.promise(() => db.schema.dropTable("run_events").execute()),
      );
      const response = yield* Effect.promise(() => f.call(1));
      expect(response.statusCode).toBe(500);
      expect(response.json().error.details[0].reason).toBe("INTERNAL");
      expect((yield* f.actual.getRun(id(1))).state).toBe("queued");
    }),
  ),
);
