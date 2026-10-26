import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { type State, Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import type { JsonValue } from "@krun/shared/dist/store/model.js";
import { DateTime, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { runReadRoutes } from "./run-read-routes.js";
import { runResultRoutes } from "./run-result-routes.js";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
const reference = (n: number) => `s3://krun-test-p36/runs/${id(n)}/result.json`;
const fixture = (
  options: {
    configured?: boolean;
    sign?: (ref: string, ttl: number) => Effect.Effect<string, unknown>;
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const tokens = Object.fromEntries(
      ["owner", "other", "admin", "writer"].map((n) => [n, randomBytes(32).toString("hex")]),
    );
    const config = {
      keys: [
        {
          name: "owner",
          key: tokens.owner,
          scopes: ["runs:read"],
          functions: ["alpha", "deleted"],
        },
        { name: "other", key: tokens.other, scopes: ["runs:read"], functions: ["*"] },
        { name: "admin", key: tokens.admin, scopes: ["admin"] },
        { name: "writer", key: tokens.writer, scopes: ["runs:write"], functions: ["*"] },
      ],
    };
    const file = yield* Ref.make(Buffer.from(JSON.stringify(config)));
    const keys = yield* makeKeys({ path: "krun-test-p36-keys", read: Ref.get(file) });
    const functions = yield* makeFunctions({
      namespace: "krun-test-p36",
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
    const store = yield* Store;
    yield* store.migrate();
    const calls: { ref: string; ttl: number; at: number }[] = [];
    // Only the explicitly requested object-store boundary is fake; handlers,
    // authentication, scoped runner, persistence and serialization are real.
    const objectStore = {
      presignGet: (ref: string, ttl: number) =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          calls.push({ ref, ttl, at: now });
          return options.sign
            ? yield* options.sign(ref, ttl)
            : `https://objects.example.test/result.json?issued=${now}&ttl=${ttl}&sequence=${calls.length}`;
        }),
    };
    const logs: string[] = [];
    const app = yield* makePublicApp({
      routes: async (server) => {
        server.register(runReadRoutes);
        server.register(runResultRoutes(options.configured === false ? undefined : objectStore));
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
    const call = (n: number, who = "owner", fn = "alpha", query = "") =>
      app.inject({
        method: "GET",
        url: `/v1/functions/${fn}/runs/${id(n)}:getResult${query}`,
        headers: who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {},
      });
    const seed = (
      n: number,
      state: State = "succeeded",
      value?: JsonValue,
      ref?: string,
      owner = "owner",
      fn = "alpha",
    ) =>
      Effect.gen(function* () {
        yield* store.createRun({
          id: id(n),
          idempotency_key: null,
          request_hash: "a".repeat(64),
          function_name: fn,
          created_by: owner,
          input: { privateInput: "krun-test-p36-private-input" },
          priority: 0,
          callback_url: null,
          created_at: at,
        });
        if (state === "queued") return;
        yield* store.setJobToken(id(n), "krun-test-p36-job", "b".repeat(64));
        yield* store.markScheduled(id(n));
        if (state === "scheduled") return;
        yield* store.transition(id(n), "scheduled", "running", null, {});
        if (value !== undefined) yield* store.setResult(id(n), value);
        if (state === "running") return;
        if (state === "cancelling" || state === "cancelled") {
          yield* store.transition(id(n), "running", "cancelling", null, {});
          if (state === "cancelled")
            yield* store.transition(id(n), "cancelling", "cancelled", null, {});
          return;
        }
        yield* store.transition(
          id(n),
          "running",
          state,
          state === "failed" ? "exit_code" : null,
          ref === undefined ? {} : { result_ref: ref },
        );
      });
    return { app, store, seed, call, calls, logs, tokens, file, config, objectStore };
  });
const run = <A, E>(program: Effect.Effect<A, E, Store | Database | import("effect").Scope.Scope>) =>
  Effect.scoped(program).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")))),
  );

for (const [name, value] of [
  ["false", false],
  ["zero", 0],
  ["empty string", ""],
  ["JSON string", 'quoted "text"\0🧪'],
  ["empty array", []],
  ["empty object", {}],
  ["opaque own keys", JSON.parse('{"__proto__":{"opaque":true},"nested":[null,false,0]}')],
] as const)
  it.effect(`GetRunResult inline ${name} is raw JSON,never a Run wrapper`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "succeeded", value);
        const before = yield* f.store.getRun(id(1));
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^application\/json/);
        expect(response.json()).toEqual(value);
        expect(response.body).toBe(JSON.stringify(value));
        expect(f.calls).toHaveLength(0);
        expect(yield* f.store.getRun(id(1))).toEqual(before);
      }),
    ),
  );
for (const state of ["failed", "cancelled"] as const)
  it.effect(`GetRunResult ${state} retains its accepted inline result`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, state, false);
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(200);
        expect(response.json()).toBe(false);
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );
it.effect(
  "GetRunResult offloaded result is bodyless307 with exact no-store Location and fixed300-second fresh signing",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "succeeded", undefined, reference(1));
        const first = yield* Effect.promise(() => f.call(1));
        expect(first.statusCode).toBe(307);
        expect(first.body).toBe("");
        expect(first.headers["cache-control"]).toBe("no-store");
        expect(first.headers.authorization).toBeUndefined();
        expect(first.headers["x-krun-token"]).toBeUndefined();
        expect(first.headers.location).toBe(
          `https://objects.example.test/result.json?issued=${DateTime.toEpochMillis(at)}&ttl=300&sequence=1`,
        );
        yield* TestClock.adjust("11 seconds");
        const second = yield* Effect.promise(() => f.call(1));
        expect(second.statusCode).toBe(307);
        expect(second.headers.location).not.toBe(first.headers.location);
        expect(f.calls).toEqual([
          { ref: reference(1), ttl: 300, at: DateTime.toEpochMillis(at) },
          { ref: reference(1), ttl: 300, at: DateTime.toEpochMillis(at) + 11000 },
        ]);
      }),
    ),
);
for (const state of ["succeeded", "failed", "cancelled"] as const)
  it.effect(`GetRunResult ${state} with no result is404 RESULT_MISSING`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, state);
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(404);
        expect(response.json().error.status).toBe("NOT_FOUND");
        expect(response.json().error.details[0].reason).toBe("RESULT_MISSING");
        expect(f.calls).toHaveLength(0);
      }),
    ),
  );
for (const state of ["queued", "scheduled", "running", "cancelling"] as const)
  it.effect(
    `GetRunResult ${state} is400 RUN_NOT_TERMINAL even when an inline result is already accepted`,
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.seed(
            1,
            state,
            state === "running" || state === "cancelling" ? false : undefined,
          );
          const response = yield* Effect.promise(() => f.call(1));
          expect(response.statusCode).toBe(400);
          expect(response.json().error.status).toBe("FAILED_PRECONDITION");
          expect(response.json().error.details[0].reason).toBe("RUN_NOT_TERMINAL");
          expect(f.calls).toHaveLength(0);
        }),
      ),
  );
it.effect(
  "Stored wildcard/deleted Function result needs no informer readiness and audit names stored identity",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(
          1,
          "succeeded",
          { data: "opaque-private-result" },
          undefined,
          "owner",
          "deleted",
        );
        const response = yield* Effect.promise(() => f.call(1, "owner", "-"));
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ data: "opaque-private-result" });
        expect(
          f.logs
            .map((s) => JSON.parse(s))
            .find((e) => e.event === "http_request" && e.code === 200),
        ).toMatchObject({ function: "deleted", run_id: id(1), key: "owner" });
        expect(f.logs.join("")).not.toContain("opaque-private-result");
        expect(f.logs.join("")).not.toContain("krun-test-p36-private-input");
        expect(Object.values(f.tokens).some((t) => f.logs.join("").includes(t))).toBe(false);
      }),
    ),
);
it.effect(
  "Missing/wrong-parent/foreign-owner/forbidden-function results are generic404 before signing or state disclosure",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "succeeded", undefined, reference(1));
        yield* f.seed(2, "failed", false, undefined, "other");
        yield* f.seed(3, "succeeded", undefined, reference(3), "owner", "beta");
        const responses = yield* Effect.promise(() =>
          Promise.all([
            f.call(99),
            f.call(1, "owner", "deleted"),
            f.call(2),
            f.call(3, "owner", "-"),
          ]),
        );
        for (const r of responses) {
          expect(r.statusCode).toBe(404);
          expect(r.json().error.details[0].reason).toBe("RUN_NOT_FOUND");
          expect(r.json().error.message).toBe(responses[0]?.json().error.message);
          expect(r.json().error.details[0]).not.toHaveProperty("metadata.state");
        }
        expect(f.calls).toHaveLength(0);
      }),
    ),
);
it.effect("Admin may read foreign results but still cannot bypass a wrong named parent", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seed(1, "succeeded", undefined, reference(1), "other");
      expect((yield* Effect.promise(() => f.call(1, "admin", "deleted"))).statusCode).toBe(404);
      expect(f.calls).toHaveLength(0);
      expect((yield* Effect.promise(() => f.call(1, "admin", "-"))).statusCode).toBe(307);
      expect(f.calls).toHaveLength(1);
    }),
  ),
);
it.effect(
  "No object-store configuration is needed for inline/missing results;stored offload without signer is INTERNAL",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ configured: false });
        yield* f.seed(1, "succeeded", 0);
        yield* f.seed(2);
        yield* f.seed(3, "succeeded", undefined, reference(3));
        expect((yield* Effect.promise(() => f.call(1))).json()).toBe(0);
        expect((yield* Effect.promise(() => f.call(2))).json().error.details[0].reason).toBe(
          "RESULT_MISSING",
        );
        const bad = yield* Effect.promise(() => f.call(3));
        expect(bad.statusCode).toBe(500);
        expect(bad.json().error.details[0].reason).toBe("INTERNAL");
        expect(f.calls).toHaveLength(0);
      }),
    ),
);
it.effect(
  "Presigner failure remains generic INTERNAL without a Location or private signing data in logs",
  () =>
    run(
      Effect.gen(function* () {
        const marker = "krun-test-p36-private-signer-error";
        const f = yield* fixture({ sign: () => Effect.fail(new Error(marker)) });
        yield* f.seed(1, "succeeded", undefined, reference(1));
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(500);
        expect(response.json().error.details[0].reason).toBe("INTERNAL");
        expect(response.headers.location).toBeUndefined();
        expect(response.body + f.logs.join("")).not.toContain(marker);
        expect(f.calls).toHaveLength(1);
      }),
    ),
);
it.effect(
  "Strict auth/scope/query checks and current grant reload precede result/signing work",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.seed(1, "succeeded", undefined, reference(1));
        for (const [who, query, code, reason] of [
          ["", "", 401, "KEY_MISSING"],
          ["invalid-key", "", 401, "KEY_INVALID"],
          ["writer", "", 403, "SCOPE_MISSING"],
          ["owner", "?view=FULL", 400, "REQUEST_INVALID"],
          ["owner", "?unknown=1", 400, "REQUEST_INVALID"],
        ] as const) {
          const response = yield* Effect.promise(() => f.call(1, who, "alpha", query));
          expect(response.statusCode).toBe(code);
          expect(response.json().error.details[0].reason).toBe(reason);
        }
        const key = f.config.keys[0];
        if (key?.functions) key.functions = ["nothing"];
        yield* Ref.set(f.file, Buffer.from(JSON.stringify(f.config)));
        yield* TestClock.adjust("30 seconds");
        expect((yield* Effect.promise(() => f.call(1, "owner", "-"))).statusCode).toBe(404);
        expect(f.calls).toHaveLength(0);
      }),
    ),
);
it.effect("Malformed persisted reference fails closed without invoking presigner", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const [n, ref] of [
        [1, "https://example.invalid/not-s3"],
        [2, `s3://krun-test-p36/runs/${id(1)}/result.json`],
        [3, `${reference(3)}?unexpected=1`],
      ] as const) {
        yield* f.seed(n, "succeeded", undefined, ref);
        const response = yield* Effect.promise(() => f.call(n));
        expect(response.statusCode).toBe(500);
        expect(response.json().error.details[0].reason).toBe("INTERNAL");
      }
      expect(f.calls).toHaveLength(0);
    }),
  ),
);
it.effect("Non-http,relative,userinfo and same-origin signed targets fail closed", () =>
  run(
    Effect.gen(function* () {
      let next = 10;
      for (const url of [
        "/relative",
        "ftp://example.invalid/result",
        "https://user:password@example.invalid/result",
        "http://localhost/result",
      ]) {
        const f = yield* fixture({ sign: () => Effect.succeed(url) });
        const n = next++;
        yield* f.seed(n, "succeeded", undefined, reference(n));
        const response = yield* Effect.promise(() => f.call(n));
        expect(response.statusCode).toBe(500);
        expect(response.json().error.details[0].reason).toBe("INTERNAL");
        expect(response.headers.location).toBeUndefined();
      }
    }),
  ),
);
for (const location of [
  "http:objects.example.test/result.json",
  String.raw`http:\objects.example.test/result.json`,
  "https:objects.example.test/result.json",
  String.raw`https:\objects.example.test/result.json`,
])
  it.effect(`Ambiguous authority-less signed target fails closed: ${location}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ sign: () => Effect.succeed(location) });
        yield* f.seed(1, "succeeded", undefined, reference(1));
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(500);
        expect(response.json().error.details[0].reason).toBe("INTERNAL");
        expect(response.headers.location).toBeUndefined();
        expect(f.calls).toHaveLength(1);
      }),
    ),
  );
it.effect(
  "Valid cross-origin signing URL bytes, percent escapes and duplicate query remain exact",
  () =>
    run(
      Effect.gen(function* () {
        const location =
          "https://objects.example.test:443/a%2Fb/%7e/result.json?key=a%2fb+%20&key=b&empty=";
        const f = yield* fixture({ sign: () => Effect.succeed(location) });
        yield* f.seed(1, "succeeded", undefined, reference(1));
        const response = yield* Effect.promise(() => f.call(1));
        expect(response.statusCode).toBe(307);
        expect(response.headers.location).toBe(location);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toBe("");
        expect(f.calls).toMatchObject([{ ref: reference(1), ttl: 300 }]);
      }),
    ),
);
it.effect("Real Store failure stays INTERNAL and never calls the signer", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.flatMap(Database, ({ db }) =>
        Effect.promise(() => db.schema.dropTable("runs").execute()),
      );
      const response = yield* Effect.promise(() => f.call(1));
      expect(response.statusCode).toBe(500);
      expect(response.json().error.details[0].reason).toBe("INTERNAL");
      expect(f.calls).toHaveLength(0);
    }),
  ),
);
it.effect("App shutdown interrupts and settles an active presigner finalizer", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const f = yield* fixture({
        sign: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(settled, undefined)),
          ),
      });
      yield* f.seed(1, "succeeded", undefined, reference(1));
      const pending = yield* Effect.promise(() => f.call(1)).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Effect.promise(() => f.app.close());
      yield* Deferred.await(settled);
      yield* Fiber.join(pending);
      expect((yield* f.store.getRun(id(1))).state).toBe("succeeded");
    }),
  ),
);
