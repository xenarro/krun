import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { Duration, Effect, Stream } from "effect";
import { makePublicApp } from "./app.js";
import { functionReadRoutes } from "./function-routes.js";

const resource = (name: string, spec: Record<string, unknown> = {}) => ({
  metadata: {
    name,
    namespace: "krun-test-p3-2",
    uid: `uid-${name}`,
    generation: 1,
    resourceVersion: "1",
  },
  spec: {
    image: `example.invalid/job@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object" },
    ...spec,
  },
});
const fixture = (
  items: unknown[] = [
    resource("alpha"),
    resource("beta", {
      callback: { url: "https://hooks.example.invalid/cb" },
      heartbeatTimeout: "30s",
      maxQueued: 0,
    }),
    resource("broken", { image: "example.invalid/job:latest" }),
    resource("hidden"),
  ],
  synced = true,
  limits = {
    KRUN_MAX_INPUT_BYTES: 12345,
    KRUN_MAX_RESULT_BYTES: 54321,
    KRUN_MAX_WAIT: Duration.millis(1250),
  },
) =>
  Effect.gen(function* () {
    const tokens = {
      reader: randomBytes(32).toString("hex"),
      empty: randomBytes(32).toString("hex"),
      admin: randomBytes(32).toString("hex"),
      wrong: randomBytes(32).toString("hex"),
    };
    const keys = yield* makeKeys({
      path: "krun-test-p3-2-keys",
      read: Effect.succeed(
        Buffer.from(
          JSON.stringify({
            keys: [
              {
                name: "reader",
                key: tokens.reader,
                scopes: ["functions:read"],
                functions: ["alpha", "beta", "f-*"],
              },
              {
                name: "empty",
                key: tokens.empty,
                scopes: ["functions:read"],
                functions: ["nothing"],
              },
              { name: "admin", key: tokens.admin, scopes: ["admin"] },
              { name: "wrong", key: tokens.wrong, scopes: ["runs:read"], functions: ["*"] },
            ],
          }),
        ),
      ),
    });
    const functions = yield* makeFunctions({
      namespace: "krun-test-p3-2",
      ceilings: {
        maxActiveDeadline: 86400,
        maxQueued: 1000,
        allowedRegistries: [],
        allowedServiceAccounts: ["krun-job-default"],
        webhookAllowedHosts: ["hooks.example.invalid"],
      },
    }).pipe(
      Effect.provideService(FunctionSource, {
        watch: () =>
          synced
            ? Stream.succeed({ type: "sync" as const, items }).pipe(Stream.concat(Stream.never))
            : Stream.never,
      }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    if (synced) yield* functions.synced;
    const store = yield* Store;
    yield* store.migrate();
    const app = yield* makePublicApp({
      routes: functionReadRoutes(limits),
    }).pipe(
      Effect.provideService(Keys, keys),
      Effect.provideService(Functions, functions),
      Effect.provideService(LogDestination, { write() {} }),
    );
    const call = (url: string, key: keyof typeof tokens = "reader") =>
      app.inject({ url, headers: { authorization: `Bearer ${tokens[key]}` } });
    return { app, call, functions };
  });
const run = <A, E>(program: Effect.Effect<A, E, Store | import("effect").Scope.Scope>) =>
  Effect.scoped(program).pipe(Effect.provide(StoreSqlite(":memory:")));

it.effect(
  "lists only validated Ready definitions in name order and projects exactly the public fields",
  () =>
    run(
      Effect.gen(function* () {
        const { call } = yield* fixture();
        const response = yield* Effect.promise(() => call("/v1/functions"));
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.functions.map((f: { name: string }) => f.name)).toEqual([
          "functions/alpha",
          "functions/beta",
        ]);
        expect(body.nextPageToken).toBe("");
        expect(body.functions[0]).toEqual({
          name: "functions/alpha",
          inputSchema: { type: "object" },
          maxConcurrency: 10,
          maxQueued: 1000,
          queueTimeout: "1h",
          activeDeadlineSeconds: 3600,
          maxInputBytes: 12345,
          maxResultBytes: 54321,
          maxWait: "1250ms",
        });
        expect(body.functions[1].callback).toEqual({ url: "https://hooks.example.invalid/cb" });
        expect(body.functions[1].heartbeatTimeout).toBe("30s");
        expect(body.functions[1].maxQueued).toBe(0);
        expect(JSON.stringify(body)).not.toContain(":null");
      }),
    ),
);
it.effect(
  "empty glob matches return an empty collection,while admin still excludes invalid definitions",
  () =>
    run(
      Effect.gen(function* () {
        const { call } = yield* fixture();
        const empty = yield* Effect.promise(() => call("/v1/functions", "empty"));
        expect(empty.json()).toEqual({ functions: [], nextPageToken: "" });
        const admin = yield* Effect.promise(() => call("/v1/functions", "admin"));
        expect(admin.json().functions.map((f: { name: string }) => f.name)).toEqual([
          "functions/alpha",
          "functions/beta",
          "functions/hidden",
        ]);
      }),
    ),
);
it.effect("GetFunction returns the same projection with no private spec/status members", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture();
      const response = yield* Effect.promise(() => call("/v1/functions/beta"));
      expect(response.statusCode).toBe(200);
      expect(response.json().callback).toEqual({ url: "https://hooks.example.invalid/cb" });
      for (const name of ["uid", "image", "env", "spec", "status", "resourceVersion"])
        expect(response.json()).not.toHaveProperty(name);
    }),
  ),
);
it.effect("missing,invalid and forbidden functions have indistinguishable canonical errors", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture();
      const responses = yield* Effect.promise(() =>
        Promise.all([
          call("/v1/functions/f-missing"),
          call("/v1/functions/broken", "admin"),
          call("/v1/functions/hidden"),
        ]),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(response.json().error.details[0].reason).toBe("FUNCTION_NOT_FOUND");
      }
      expect(responses.map((r) => r.body)).toEqual([
        responses[0]?.body,
        responses[0]?.body,
        responses[0]?.body,
      ]);
    }),
  ),
);
it.effect("enforces authentication and scope before query/visibility checks", () =>
  run(
    Effect.gen(function* () {
      const { app, call } = yield* fixture();
      const absent = yield* Effect.promise(() => app.inject({ url: "/v1/functions" }));
      expect(absent.statusCode).toBe(401);
      const denied = yield* Effect.promise(() => call("/v1/functions?unknown=1", "wrong"));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.details[0].reason).toBe("SCOPE_MISSING");
    }),
  ),
);
it.effect("uses stable keyset pages and allows page size changes", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture([resource("f-c"), resource("f-a"), resource("f-b")]);
      const first = yield* Effect.promise(() => call("/v1/functions?pageSize=1"));
      expect(first.json().functions.map((f: { name: string }) => f.name)).toEqual([
        "functions/f-a",
      ]);
      expect(first.json().nextPageToken).not.toBe("");
      const second = yield* Effect.promise(() =>
        call(
          `/v1/functions?pageSize=2&pageToken=${encodeURIComponent(first.json().nextPageToken)}`,
        ),
      );
      expect(second.json().functions.map((f: { name: string }) => f.name)).toEqual([
        "functions/f-b",
        "functions/f-c",
      ]);
      expect(second.json().nextPageToken).toBe("");
    }),
  ),
);
it.effect("defaults absent/zero page size and caps oversized pages", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture(
        Array.from({ length: 205 }, (_, i) => resource(`f-${String(i).padStart(3, "0")}`)),
      );
      for (const query of ["", "?pageSize=0"]) {
        const response = yield* Effect.promise(() => call(`/v1/functions${query}`));
        expect(response.json().functions).toHaveLength(50);
      }
      const large = yield* Effect.promise(() => call("/v1/functions?pageSize=500"));
      expect(large.json().functions).toHaveLength(200);
    }),
  ),
);
it.effect(
  "rejects malformed tokens,unknown query fields,negative/noninteger page size and token replay by another key",
  () =>
    run(
      Effect.gen(function* () {
        const { call } = yield* fixture();
        for (const query of [
          "?pageToken=not-base64!",
          "?filter=x",
          "?pageSize=-1",
          "?pageSize=1.2",
          "?pageSize=null",
          "?pageSize=1&pageSize=2",
        ]) {
          const response = yield* Effect.promise(() => call(`/v1/functions${query}`));
          expect(response.statusCode).toBe(400);
          expect(response.json().error.details[0].reason).toBe("REQUEST_INVALID");
        }
        const first = yield* Effect.promise(() => call("/v1/functions?pageSize=1"));
        const replay = yield* Effect.promise(() =>
          call(
            `/v1/functions?pageToken=${encodeURIComponent(first.json().nextPageToken)}`,
            "admin",
          ),
        );
        expect(replay.statusCode).toBe(400);
      }),
    ),
);

it.effect("preserves valid zero installation byte caps and whole-second wait rendering", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture([resource("alpha")], true, {
        KRUN_MAX_INPUT_BYTES: 0,
        KRUN_MAX_RESULT_BYTES: 0,
        KRUN_MAX_WAIT: Duration.seconds(60),
      });
      const response = yield* Effect.promise(() => call("/v1/functions/alpha"));
      expect(response.statusCode).toBe(200);
      expect(response.json().maxInputBytes).toBe(0);
      expect(response.json().maxResultBytes).toBe(0);
      expect(response.json().maxWait).toBe("60s");
    }),
  ),
);
it.effect("unsynced cache returns sanitized retryable503 for both methods", () =>
  run(
    Effect.gen(function* () {
      const { call } = yield* fixture([], false);
      for (const path of ["/v1/functions", "/v1/functions/alpha"]) {
        const response = yield* Effect.promise(() => call(path));
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json().error.details[0].reason).toBe("NOT_READY");
      }
    }),
  ),
);
