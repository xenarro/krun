import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Database, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { DateTime, Effect, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { runReadRoutes } from "./run-read-routes.js";

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
const fixture = Effect.gen(function* () {
  const tokens = Object.fromEntries(
    ["owner", "other", "admin", "empty", "wrong"].map((name) => [
      name,
      randomBytes(32).toString("hex"),
    ]),
  );
  const config = {
    keys: [
      {
        name: "owner",
        key: tokens.owner,
        scopes: ["runs:read"],
        functions: ["alpha", "deleted", "f-*"],
      },
      { name: "other", key: tokens.other, scopes: ["runs:read"], functions: ["*"] },
      { name: "admin", key: tokens.admin, scopes: ["admin"] },
      { name: "empty", key: tokens.empty, scopes: ["runs:read"], functions: ["nothing"] },
      { name: "wrong", key: tokens.wrong, scopes: ["runs:write"], functions: ["*"] },
    ],
  };
  const file = yield* Ref.make(Buffer.from(JSON.stringify(config)));
  const keys = yield* makeKeys({ path: "krun-test-p34-keys", read: Ref.get(file) });
  // Existing Run history is readable without a Ready/current Function resource.
  const functions = yield* makeFunctions({
    namespace: "krun-test-p34",
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
  const logs: string[] = [];
  const app = yield* makePublicApp({ routes: runReadRoutes }).pipe(
    Effect.provideService(Keys, keys),
    Effect.provideService(Functions, functions),
    Effect.provideService(LogDestination, {
      write(line) {
        logs.push(line);
      },
    }),
  );
  const call = (path: string, who = "owner") =>
    app.inject({
      url: path,
      headers: who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {},
    });
  const seed = (n: number, fn = "alpha", owner = "owner", millis = n) =>
    store.createRun({
      id: id(n),
      idempotency_key: null,
      request_hash: "a".repeat(64),
      function_name: fn,
      created_by: owner,
      input: JSON.parse('{"secretInput":"opaque","__proto__":{"safe":true},"nul":"\\u0000"}'),
      priority: 0,
      callback_url: null,
      created_at: DateTime.addDuration(at, `${millis} millis`),
    });
  return { store, app, call, seed, keys, file, config, tokens, logs };
});
const run = <A, E>(body: Effect.Effect<A, E, Store | Database | import("effect").Scope.Scope>) =>
  Effect.scoped(body).pipe(
    Effect.provide(StoreLive.pipe(Layer.provideMerge(DatabaseSqlite(":memory:")))),
  );
const list = "/v1/functions/-/runs";
const single = (n: number, fn = "alpha") => `/v1/functions/${fn}/runs/${id(n)}`;

it.effect(
  "GetRun defaults FULL, supports BASIC, and never leaks private columns or FULL-only fields",
  () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(at) + 1000);
        const f = yield* fixture;
        yield* f.seed(1);
        yield* f.store.setJobToken(id(1), "krun-test-p34-job", "b".repeat(64));
        yield* f.store.markScheduled(id(1));
        yield* f.store.transition(id(1), "scheduled", "running", null, {});
        yield* f.store.setResult(id(1), false);
        yield* f.store.setError(id(1), {
          source: "function",
          message: "failed",
          type: "verbatim-Type",
          details: { secretDetails: "opaque" },
        });
        yield* f.store.transition(id(1), "running", "failed", "exit_code", {
          log_tail: "private log",
        });
        const full = yield* Effect.promise(() => f.call(single(1)));
        expect(full.statusCode).toBe(200);
        expect(full.json().input.nul).toBe("\0");
        expect(Object.hasOwn(full.json().input, "__proto__")).toBe(true);
        expect(full.json().result).toBe(false);
        expect(full.json().error.details).toEqual({ secretDetails: "opaque" });
        expect(full.json().logTail).toBe("private log");
        const basic = yield* Effect.promise(() => f.call(`${single(1)}?view=BASIC`));
        expect(basic.statusCode).toBe(200);
        for (const field of ["input", "result", "logTail"])
          expect(basic.json()).not.toHaveProperty(field);
        expect(basic.json().error).toEqual({
          source: "FUNCTION",
          message: "failed",
          type: "verbatim-Type",
        });
        for (const body of [full.json(), basic.json()])
          for (const field of [
            "request_hash",
            "idempotency_key",
            "idempotency_key_nul",
            "job_token_hash",
            "lease_owner",
          ])
            expect(body).not.toHaveProperty(field);
      }),
    ),
);
it.effect(
  "wildcard GetRun resolves the actual function and missing/other-owner/wrong-parent/forbidden rows share RUN_NOT_FOUND",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.seed(1);
        yield* f.seed(2, "alpha", "other");
        yield* f.seed(3, "beta");
        const good = yield* Effect.promise(() => f.call(single(1, "-")));
        expect(good.statusCode).toBe(200);
        expect(good.json().name).toBe(`functions/alpha/runs/${id(1)}`);
        expect(
          f.logs
            .map((line) => JSON.parse(line))
            .find((line) => line.event === "http_request" && line.run_id === id(1)),
        ).toMatchObject({ key: "owner", function: "alpha", run_id: id(1), code: 200 });
        const responses = yield* Effect.promise(() =>
          Promise.all([
            f.call(single(90)),
            f.call(single(2)),
            f.call(single(1, "deleted")),
            f.call(single(3, "-")),
          ]),
        );
        for (const r of responses) {
          expect(r.statusCode).toBe(404);
          expect(r.json().error.details[0].reason).toBe("RUN_NOT_FOUND");
          expect(r.json().error.message).toBe(responses[0]?.json().error.message);
        }
        expect((yield* Effect.promise(() => f.call(single(2, "-"), "admin"))).statusCode).toBe(200);
        expect((yield* Effect.promise(() => f.call(single(3), "admin"))).statusCode).toBe(404);
      }),
    ),
);
it.effect(
  "Run reads retain stored history when the Function informer is unsynced or the Function is absent",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.seed(1, "deleted");
        expect((yield* Effect.promise(() => f.call(single(1, "deleted")))).statusCode).toBe(200);
        expect(
          (yield* Effect.promise(() => f.call("/v1/functions/deleted/runs"))).json().runs,
        ).toHaveLength(1);
      }),
    ),
);
it.effect(
  "ListRuns filters owners and globs before pagination, returns BASIC and emits no hidden-tail token",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const [n, fn, owner] of [
          [1, "beta", "owner"],
          [2, "alpha", "owner"],
          [3, "beta", "owner"],
          [4, "alpha", "other"],
          [5, "deleted", "owner"],
          [6, "beta", "owner"],
        ] as const)
          yield* f.seed(n, fn, owner);
        const first = yield* Effect.promise(() => f.call(`${list}?pageSize=1`));
        expect(first.statusCode).toBe(200);
        expect(first.json().runs.map((r: { name: string }) => r.name)).toEqual([
          `functions/deleted/runs/${id(5)}`,
        ]);
        expect(first.json().nextPageToken).not.toBe("");
        expect(first.json().runs[0]).not.toHaveProperty("input");
        const last = yield* Effect.promise(() =>
          f.call(`${list}?pageSize=2&pageToken=${first.json().nextPageToken}`),
        );
        expect(last.json().runs.map((r: { name: string }) => r.name)).toEqual([
          `functions/alpha/runs/${id(2)}`,
        ]);
        expect(last.json().nextPageToken).toBe("");
        expect((yield* Effect.promise(() => f.call(list, "empty"))).json()).toEqual({
          runs: [],
          nextPageToken: "",
        });
        expect((yield* Effect.promise(() => f.call(list, "admin"))).json().runs).toHaveLength(6);
        expect(
          (yield* Effect.promise(() => f.call("/v1/functions/beta/runs"))).json().error.details[0]
            .reason,
        ).toBe("FUNCTION_NOT_FOUND");
      }),
    ),
);
it.effect(
  "pageSize defaults/zero/cap and tied UUIDv7 descending ordering preserve complete traversal",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.forEach(
          Array.from({ length: 205 }, (_, i) => i + 1),
          (n) => f.seed(n, "alpha", "owner", 0),
        );
        for (const q of ["", "?pageSize=0"])
          expect((yield* Effect.promise(() => f.call(list + q))).json().runs).toHaveLength(50);
        const first = yield* Effect.promise(() => f.call(`${list}?pageSize=500`));
        expect(first.json().runs).toHaveLength(200);
        expect(first.json().runs[0].name).toBe(`functions/alpha/runs/${id(205)}`);
        const tail = yield* Effect.promise(() =>
          f.call(`${list}?pageSize=9&pageToken=${first.json().nextPageToken}`),
        );
        expect(tail.json().runs).toHaveLength(5);
        expect(tail.json().nextPageToken).toBe("");
        expect(
          new Set([...first.json().runs, ...tail.json().runs].map((r: { name: string }) => r.name))
            .size,
        ).toBe(205);
      }),
    ),
);
it.effect("filter grammar delegates state/time/reason terms to the real Store", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed(1);
      yield* f.seed(2);
      yield* f.store.transition(id(2), "queued", "failed", "queue_timeout", {});
      const filter =
        'state = FAILED AND createTime >= "2026-10-25T00:00:00.002Z" AND failureReason = QUEUE_TIMEOUT';
      const response = yield* Effect.promise(() =>
        f.call(`${list}?filter=${encodeURIComponent(filter)}`),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().runs.map((r: { name: string }) => r.name)).toEqual([
        `functions/alpha/runs/${id(2)}`,
      ]);
      expect(
        (yield* Effect.promise(() =>
          f.call(
            list +
              "?filter=" +
              encodeURIComponent('state != FAILED AND createTime < "2026-10-25T00:00:00.0011Z"'),
          ),
        )).json().runs,
      ).toHaveLength(1);
    }),
  ),
);
it.effect(
  "tokens bind parent, exact filter, principal and current grants while pageSize may change",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let n = 1; n <= 4; n++) yield* f.seed(n);
        const page = yield* Effect.promise(() => f.call(`${list}?pageSize=1`));
        const token = page.json().nextPageToken;
        expect(token).not.toBe("");
        for (const [path, who] of [
          [`/v1/functions/alpha/runs?pageToken=${token}`, "owner"],
          [`${list}?filter=state%20%3D%20QUEUED&pageToken=${token}`, "owner"],
          [`${list}?pageToken=${token}`, "other"],
        ] as const) {
          const r = yield* Effect.promise(() => f.call(path, who));
          expect(r.statusCode).toBe(400);
          expect(r.json().error.details[0].reason).toBe("REQUEST_INVALID");
        }
        expect(
          (yield* Effect.promise(() => f.call(`${list}?pageSize=2&pageToken=${token}`))).json()
            .runs,
        ).toHaveLength(2);
        f.config.keys[0]?.functions?.push("new-grant");
        yield* Ref.set(f.file, Buffer.from(JSON.stringify(f.config)));
        yield* TestClock.adjust("30 seconds");
        expect((yield* Effect.promise(() => f.call(`${list}?pageToken=${token}`))).statusCode).toBe(
          400,
        );
      }),
    ),
);
it.effect("structurally invalid inner Store cursors are REQUEST_INVALID, not INTERNAL", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.seed(1);
      yield* f.seed(2);
      const first = yield* Effect.promise(() => f.call(`${list}?pageSize=1`));
      const decoded = JSON.parse(
        Buffer.from(first.json().nextPageToken, "base64url").toString("utf8"),
      );
      for (const k of Object.keys(decoded))
        if (k !== "context" && typeof decoded[k] === "string")
          decoded[k] = "malformed-store-cursor";
      const r = yield* Effect.promise(() =>
        f.call(`${list}?pageToken=${Buffer.from(JSON.stringify(decoded)).toString("base64url")}`),
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.details[0].reason).toBe("REQUEST_INVALID");
    }),
  ),
);
for (const query of [
  "?view=BASIC",
  "?pageSize=-1",
  "?pageSize=1.5",
  "?pageSize=NaN",
  "?pageSize=1&pageSize=2",
  "?pageToken=!!!",
  "?pageToken=abc=",
  `?pageToken=${"a".repeat(1100)}`,
  "?orderBy=createTime",
])
  it.effect(`ListRuns rejects malformed/unknown query ${query.slice(0, 40)}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const r = yield* Effect.promise(() => f.call(list + query));
        expect(r.statusCode).toBe(400);
        expect(r.json().error.details[0].reason).toBe("REQUEST_INVALID");
      }),
    ),
  );
for (const filter of [
  "state = future",
  "state = null",
  "state = FAILED OR state = RUNNING",
  "createTime >= unquoted",
  "failureReason != EXIT_CODE",
  "input.secret = yes",
])
  it.effect(`invalid grammar is FILTER_INVALID: ${filter}`, () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const r = yield* Effect.promise(() =>
          f.call(`${list}?filter=${encodeURIComponent(filter)}`),
        );
        expect(r.statusCode).toBe(400);
        expect(r.json().error.details[0].reason).toBe("FILTER_INVALID");
      }),
    ),
  );
it.effect(
  "auth/scope, strict UUID/view/query validation and database failure retain canonical errors",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const [path, who, code, reason] of [
          [list, "", 401, "KEY_MISSING"],
          [list, "not-a-valid-token", 401, "KEY_INVALID"],
          [list, "wrong", 403, "SCOPE_MISSING"],
          [`${single(1)}?view=bad`, "owner", 400, "REQUEST_INVALID"],
          [`${single(1)}?extra=1`, "owner", 400, "REQUEST_INVALID"],
          ["/v1/functions/alpha/runs/not-uuid", "owner", 400, "REQUEST_INVALID"],
        ] as const) {
          const r = yield* Effect.promise(() => f.call(path, who));
          expect(r.statusCode).toBe(code);
          expect(r.json().error.details[0].reason).toBe(reason);
        }
        yield* Effect.flatMap(Database, ({ db }) =>
          Effect.tryPromise({
            try: () => db.schema.dropTable("runs").execute(),
            catch: () => new Error("Owned failure injection failed"),
          }),
        );
        for (const path of [list, single(1)]) {
          const r = yield* Effect.promise(() => f.call(path));
          expect(r.statusCode).toBe(500);
          expect(r.json().error.details[0].reason).toBe("INTERNAL");
        }
        expect(Object.values(f.tokens).some((t) => f.logs.join("").includes(t))).toBe(false);
        expect(f.logs.join("")).not.toContain("secretInput");
      }),
    ),
);
