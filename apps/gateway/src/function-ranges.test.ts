import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { functionResourceSchema } from "@krun/shared/dist/functions/schema.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { type FunctionEvent, FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { Deferred, Duration, Effect, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makePublicApp } from "./app.js";
import { functionReadRoutes } from "./function-routes.js";

const resource = (name: string, overrides: Record<string, unknown> = {}, generation = 1) => ({
  apiVersion: "krun.io/v1alpha1",
  kind: "Function",
  metadata: {
    name,
    namespace: "krun-test-p32-contracts",
    uid: `uid-${name}`,
    generation,
    resourceVersion: String(generation),
  },
  spec: {
    image: `example.invalid/job@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object" },
    ...overrides,
  },
});
const fixture = (
  items: unknown[],
  limits = {
    KRUN_MAX_INPUT_BYTES: 1048576,
    KRUN_MAX_RESULT_BYTES: 0,
    KRUN_MAX_WAIT: Duration.millis(1250),
  },
) =>
  Effect.gen(function* () {
    const token = randomBytes(32).toString("hex"),
      rotated = randomBytes(32).toString("hex");
    const record = (key: string | string[], functions = ["f-*"]) => ({
      name: "review-reader",
      key,
      scopes: ["functions:read"],
      functions,
    });
    const file = yield* Ref.make({ keys: [record(token)] });
    const keys = yield* makeKeys({
      path: "owned-review-memory",
      read: Ref.get(file).pipe(Effect.map((value) => Buffer.from(JSON.stringify(value)))),
    });
    const commands = yield* Queue.unbounded<{
      event: FunctionEvent;
      ack: Deferred.Deferred<void>;
    }>();
    const source = Stream.fromQueue(commands).pipe(
      Stream.flatMap(({ event, ack }) =>
        Stream.succeed(event).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(ack, undefined)).pipe(Stream.drain)),
        ),
      ),
    );
    const functions = yield* makeFunctions({
      namespace: "krun-test-p32-contracts",
      ceilings: {
        maxActiveDeadline: 2147483648,
        maxQueued: 2147483648,
        allowedRegistries: [],
        allowedServiceAccounts: ["krun-job-default"],
        webhookAllowedHosts: [],
      },
    }).pipe(
      Effect.provideService(FunctionSource, { watch: () => source }),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    const replace = (next: unknown[]) =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>();
        yield* Queue.offer(commands, { event: { type: "sync", items: next }, ack });
        yield* Deferred.await(ack);
      });
    yield* replace(items);
    const app = yield* makePublicApp({ routes: functionReadRoutes(limits) }).pipe(
      Effect.provideService(Keys, keys),
      Effect.provideService(Functions, functions),
      Effect.provideService(LogDestination, { write() {} }),
    );
    const call = (url: string, credential = token) =>
      app.inject({ url, headers: { authorization: `Bearer ${credential}` } });
    return { app, call, functions, replace, file, token, rotated, record, limits };
  });
const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(program).pipe(Effect.provide(StoreSqlite(":memory:")));
for (const field of ["maxConcurrency", "maxQueued", "activeDeadlineSeconds"] as const) {
  it.effect(
    `rejects ${field} beyond int32 before Ready advertisement and keeps healthy neighbors`,
    () =>
      run(
        Effect.gen(function* () {
          const definition = resource("f-wide", { [field]: 2147483648 });
          expect(functionResourceSchema.safeParse(definition).success).toBe(false);
          const { call, functions } = yield* fixture([
            resource("f-a"),
            definition,
            resource("f-z"),
          ]);
          expect(yield* functions.get("f-wide")).toBeUndefined();
          expect((yield* functions.getAny("f-wide"))?.result.ok).toBe(false);
          const response = yield* Effect.promise(() => call("/v1/functions/f-wide"));
          expect(response.statusCode).toBe(404);
          expect(response.json().error.details[0].reason).toBe("FUNCTION_NOT_FOUND");
          const list = yield* Effect.promise(() => call("/v1/functions"));
          expect(list.statusCode).toBe(200);
          expect(list.json().functions.map((entry: { name: string }) => entry.name)).toEqual([
            "functions/f-a",
            "functions/f-z",
          ]);
          const first = yield* Effect.promise(() => call("/v1/functions?pageSize=1"));
          expect(first.json().nextPageToken).not.toBe("");
          const next = yield* Effect.promise(() =>
            call(`/v1/functions?pageToken=${encodeURIComponent(first.json().nextPageToken)}`),
          );
          expect(next.statusCode).toBe(200);
          expect(next.json().functions.map((entry: { name: string }) => entry.name)).toEqual([
            "functions/f-z",
          ]);
          expect(next.json().nextPageToken).toBe("");
        }),
      ),
  );
  it.effect(`preserves the exact int32 ${field} maximum without clamping`, () =>
    run(
      Effect.gen(function* () {
        const definition = resource("f-edge", { [field]: 2147483647 });
        expect(functionResourceSchema.safeParse(definition).success).toBe(true);
        const { call, functions } = yield* fixture([definition]);
        expect((yield* functions.get("f-edge"))?.result.ok).toBe(true);
        const response = yield* Effect.promise(() => call("/v1/functions/f-edge"));
        expect(response.statusCode).toBe(200);
        expect(response.json()[field]).toBe(2147483647);
      }),
    ),
  );
}
it.effect(
  "int32 endpoint, opaque own-name schema data, and caller configuration snapshot remain valid",
  () =>
    run(
      Effect.gen(function* () {
        const inputSchema = JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}},"default":{"__proto__":null}}',
        );
        const f = yield* fixture([resource("f-a", { maxConcurrency: 2147483647, inputSchema })]);
        f.limits.KRUN_MAX_INPUT_BYTES = 1;
        const response = yield* Effect.promise(() => f.call("/v1/functions/f-a"));
        expect(response.statusCode).toBe(200);
        expect(response.json().maxConcurrency).toBe(2147483647);
        expect(response.json().maxInputBytes).toBe(1048576);
        expect(response.json().maxResultBytes).toBe(0);
        expect(response.json().inputSchema).toEqual(inputSchema);
        expect(Object.hasOwn(response.json().inputSchema.properties, "__proto__")).toBe(true);
      }),
    ),
);
it.effect("keyset continuation survives deletion and rechecks currently valid definitions", () =>
  run(
    Effect.gen(function* () {
      const { call, replace } = yield* fixture([resource("f-a"), resource("f-b"), resource("f-c")]);
      const first = yield* Effect.promise(() => call("/v1/functions?pageSize=1"));
      const cursor = first.json().nextPageToken;
      expect(cursor).not.toBe("");
      yield* replace([
        resource("f-b", { image: "example.invalid/job:latest" }, 2),
        resource("f-c"),
        resource("f-d"),
      ]);
      const continued = yield* Effect.promise(() => call(`/v1/functions?pageToken=${cursor}`));
      expect(continued.statusCode).toBe(200);
      expect(continued.json().functions.map((f: { name: string }) => f.name)).toEqual([
        "functions/f-c",
        "functions/f-d",
      ]);
      expect((yield* Effect.promise(() => call("/v1/functions/f-b"))).statusCode).toBe(404);
    }),
  ),
);
it.effect("cursor survives same-owner rotation but not a visibility-policy change", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture([resource("f-a"), resource("f-b"), resource("f-c")]);
      const first = yield* Effect.promise(() => f.call("/v1/functions?pageSize=1"));
      const cursor = first.json().nextPageToken;
      yield* Ref.set(f.file, { keys: [f.record([f.token, f.rotated])] });
      yield* TestClock.adjust("30 seconds");
      const rotated = yield* Effect.promise(() =>
        f.call(`/v1/functions?pageToken=${cursor}`, f.rotated),
      );
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().functions.map((f: { name: string }) => f.name)).toEqual([
        "functions/f-b",
        "functions/f-c",
      ]);
      yield* Ref.set(f.file, { keys: [f.record(f.rotated, ["f-c"])] });
      yield* TestClock.adjust("30 seconds");
      expect(
        (yield* Effect.promise(() => f.call(`/v1/functions?pageToken=${cursor}`, f.rotated)))
          .statusCode,
      ).toBe(400);
      const current = yield* Effect.promise(() => f.call("/v1/functions", f.rotated));
      expect(current.json().functions.map((f: { name: string }) => f.name)).toEqual([
        "functions/f-c",
      ]);
      expect((yield* Effect.promise(() => f.call("/v1/functions", f.token))).statusCode).toBe(401);
    }),
  ),
);
it.effect(
  "cursor parser rejects noncanonical base64, invalid UTF8, extra members and wrong context",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture([resource("f-a"), resource("f-b")]);
        const first = yield* Effect.promise(() => f.call("/v1/functions?pageSize=1"));
        const cursor = first.json().nextPageToken;
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        const bad = [
          cursor + "=",
          Buffer.from([0xff]).toString("base64url"),
          Buffer.from(JSON.stringify({ ...decoded, extra: true })).toString("base64url"),
          Buffer.from(JSON.stringify({ ...decoded, context: "0".repeat(64) })).toString(
            "base64url",
          ),
          "a".repeat(1025),
        ];
        for (const token of bad) {
          const response = yield* Effect.promise(() =>
            f.call(`/v1/functions?pageToken=${encodeURIComponent(token)}`),
          );
          expect(response.statusCode).toBe(400);
          expect(response.json().error.details[0].reason).toBe("REQUEST_INVALID");
        }
      }),
    ),
);
