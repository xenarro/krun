import { expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Readiness, ReadinessLive } from "../health/readiness.js";
import type { KubeApiError } from "../k8s/errors.js";
import { type FunctionEvent, FunctionSource } from "../k8s/functions.js";
import { makeFunctions } from "./cache.js";
import { functionResourceSchema, functionSpecSchema } from "./schema.js";
import { validateFunction } from "./validation.js";

const namespace = "krun-test-p2-3-width";
const ceilings = {
  maxActiveDeadline: 86400,
  maxQueued: 1000,
  allowedRegistries: [],
  allowedServiceAccounts: ["krun-job-default"],
  webhookAllowedHosts: [],
};
const resource = (
  name: string,
  generation = 1,
  inputSchema: Record<string, unknown> = { type: "object" },
) => ({
  apiVersion: "krun.io/v1alpha1",
  kind: "Function",
  metadata: {
    name,
    namespace,
    uid: `uid-${name}`,
    generation,
    resourceVersion: String(generation),
  },
  spec: { image: `ghcr.io/test/worker@sha256:${"a".repeat(64)}`, queueTimeout: "2m", inputSchema },
});
const wideSchemas = [
  { name: "flat array", schema: () => ({ enum: Array.from({ length: 200000 }, () => 0) }) },
  {
    name: "flat dictionary",
    schema: () => ({
      properties: Object.fromEntries([
        ["__proto__", { type: "string" }],
        ["constructor", { type: "string" }],
        ...Array.from({ length: 150000 }, (_, index) => [String(index), { type: "string" }]),
      ]),
    }),
  },
];
const validateFixture = (bad: ReturnType<typeof resource>) => {
  expect(functionResourceSchema.safeParse(bad).success).toBe(true);
  expect(validateFunction(functionSpecSchema.parse(bad.spec), ceilings).reason).toBe(
    "SchemaTooLarge",
  );
};
for (const shape of wideSchemas) {
  it.effect(
    `${shape.name}: initial LIST isolates size-invalid entries and synchronizes valid neighbors`,
    () =>
      Effect.gen(function* () {
        const bad = resource("oversized", 1, shape.schema());
        validateFixture(bad);
        let attempts = 0;
        const source = Layer.succeed(FunctionSource, {
          watch: () =>
            Stream.unwrap(
              Effect.sync(() => {
                attempts++;
                return Stream.succeed<FunctionEvent>({
                  type: "sync",
                  items: [resource("good"), bad],
                }).pipe(Stream.concat(Stream.never));
              }),
            ),
        });
        const readiness = yield* Readiness;
        yield* Ref.update(readiness.state, (state) => ({ ...state, ready: true }));
        const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
        yield* TestClock.adjust("100 millis");
        expect(yield* cache.isSynced).toBe(true);
        yield* cache.synced;
        expect((yield* readiness.check).status).toBe("ok");
        expect(attempts).toBe(1);
        expect((yield* cache.list).map((entry) => entry.name)).toEqual(["good"]);
        expect(yield* cache.get("oversized")).toBeUndefined();
        const invalid = yield* cache.getAny("oversized");
        expect(invalid?.result.reason).toBe("SchemaTooLarge");
        expect(invalid?.result.queueTimeout).toEqual(Duration.minutes(2));
        expect(Object.isFrozen(invalid?.spec?.inputSchema)).toBe(true);
        const owned = invalid?.spec?.inputSchema as Record<string, unknown>;
        for (const key of Object.keys(bad.spec.inputSchema)) {
          expect(Object.isFrozen(owned[key])).toBe(true);
          expect(Object.keys(owned[key] as object)).toEqual(
            Object.keys(bad.spec.inputSchema[key] as object),
          );
        }
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      }).pipe(Effect.provide(ReadinessLive(Effect.void))),
  );

  it.effect(`${shape.name}: invalid update replaces the old valid generation without a retry`, () =>
    Effect.gen(function* () {
      const feed = yield* Queue.unbounded<FunctionEvent, KubeApiError>();
      let attempts = 0;
      const source = Layer.succeed(FunctionSource, {
        watch: () =>
          Stream.unwrap(
            Effect.sync(() => {
              attempts++;
              return Stream.fromQueue(feed);
            }),
          ),
      });
      const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
      yield* Queue.offer(feed, { type: "sync", items: [resource("changed"), resource("good")] });
      yield* cache.synced;
      expect((yield* cache.get("changed"))?.result.ok).toBe(true);
      const bad = resource("changed", 2, shape.schema());
      validateFixture(bad);
      yield* Queue.offer(feed, { type: "update", object: bad });
      yield* TestClock.adjust("100 millis");
      expect(yield* cache.get("changed")).toBeUndefined();
      const invalid = yield* cache.getAny("changed");
      expect(invalid?.generation).toBe(2);
      expect(invalid?.result.reason).toBe("SchemaTooLarge");
      expect(invalid?.result.queueTimeout).toEqual(Duration.minutes(2));
      expect((yield* cache.get("good"))?.result.ok).toBe(true);
      expect(yield* cache.isSynced).toBe(true);
      expect(attempts).toBe(1);
      // A resync/status-only update of the same invalid generation reuses its result too.
      yield* Queue.offer(feed, { type: "sync", items: [resource("good"), bad] });
      yield* TestClock.adjust("1 millis");
      expect((yield* cache.getAny("changed"))?.result).toBe(invalid?.result);
      expect(yield* cache.get("changed")).toBeUndefined();
    }).pipe(Effect.provide(ReadinessLive(Effect.void))),
  );
}
