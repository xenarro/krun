import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Metric, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Readiness, ReadinessLive } from "../health/readiness.js";
import { KubeApiError } from "../k8s/errors.js";
import { type FunctionEvent, FunctionSource } from "../k8s/functions.js";
import { type FunctionEntry, makeFunctions } from "./cache.js";
import type { FunctionCeilings } from "./validation.js";

const namespace = "krun-test-p2-3";
const ceilings: FunctionCeilings = {
  maxActiveDeadline: 86400,
  maxQueued: 1000,
  allowedRegistries: [],
  allowedServiceAccounts: ["krun-job-default"],
  webhookAllowedHosts: [],
};
const resource = (name = "echo", generation = 1, uid = `uid-${name}`) => ({
  apiVersion: "krun.io/v1alpha1",
  kind: "Function",
  metadata: { name, namespace, uid, generation, resourceVersion: String(generation) },
  spec: {
    image: `ghcr.io/acme/worker@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
});
const waitFor = (test: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    while (!(yield* test)) yield* Effect.yieldNow;
  });
const fixture = Effect.gen(function* () {
  const feed = yield* Queue.unbounded<FunctionEvent, KubeApiError>();
  let starts = 0;
  let stops = 0;
  const source = Layer.succeed(FunctionSource, {
    watch: (ns) => {
      expect(ns).toBe(namespace);
      return Stream.unwrap(
        Effect.sync(() => {
          starts++;
          return Stream.fromQueue(feed).pipe(Stream.ensuring(Effect.sync(() => stops++)));
        }),
      );
    },
  });
  const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
  const send = (event: FunctionEvent) => Queue.offer(feed, event);
  const sync = (items: readonly unknown[] = []) => send({ type: "sync", items });
  return { cache, feed, send, sync, starts: () => starts, stops: () => stops };
});
const run = <A, E>(program: Effect.Effect<A, E, Readiness | import("effect").Scope.Scope>) =>
  Effect.scoped(program).pipe(Effect.provide(ReadinessLive(Effect.void)));

it.effect("readiness waits for initial LIST, including an empty list; metrics start at zero", () =>
  run(
    Effect.gen(function* () {
      const { cache, sync } = yield* fixture;
      const ready = yield* Readiness;
      yield* Ref.update(ready.state, (state) => ({ ...state, ready: true }));
      expect(yield* cache.isSynced).toBe(false);
      expect((yield* ready.check).status).toBe("unavailable");
      expect(yield* Metric.value(Metric.gauge("krun_functions_synced"))).toEqual({ value: 0 });
      yield* sync();
      yield* cache.synced;
      expect(yield* cache.isSynced).toBe(true);
      expect((yield* ready.check).status).toBe("ok");
      expect(yield* Metric.value(Metric.gauge("krun_functions_synced"))).toEqual({ value: 1 });
      expect(yield* cache.list).toEqual([]);
    }),
  ),
);

it.effect("stub add/update/delete validates; invalid Functions are absent from the valid map", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const good = resource();
      const bad = resource("invalid");
      bad.spec.inputSchema = { type: "not-a-type" } as typeof bad.spec.inputSchema;
      yield* f.sync([good, bad]);
      yield* f.cache.synced;
      expect((yield* f.cache.list).map((entry) => entry.name)).toEqual(["echo"]);
      expect(yield* f.cache.get("invalid")).toBeUndefined();
      expect((yield* f.cache.getAny("invalid"))?.result.reason).toBe("SchemaInvalid");
      const original: FunctionEntry | undefined = yield* f.cache.get("echo");
      expect(original?.result.ok).toBe(true);
      if (original?.result.ok) {
        expect(original.result.validate({ value: "text" })).toBe(true);
        expect(original.result.validate({ value: 1 })).toBe(false);
        expect(Duration.toMillis(original.result.queueTimeout)).toBe(
          Duration.toMillis(Duration.hours(1)),
        );
      }
      const update = resource("echo", 2);
      update.spec.inputSchema = { type: "unknown" } as typeof update.spec.inputSchema;
      yield* f.send({ type: "update", object: update });
      yield* waitFor(Effect.map(f.cache.get("echo"), (value) => value === undefined));
      expect((yield* f.cache.getAny("echo"))?.generation).toBe(2);
      yield* f.send({ type: "add", object: resource("fresh", 1, "uid-fresh") });
      yield* waitFor(Effect.map(f.cache.get("fresh"), (value) => value !== undefined));
      yield* f.send({ type: "delete", object: resource("fresh", 1, "uid-fresh") });
      yield* waitFor(Effect.map(f.cache.get("fresh"), (value) => value === undefined));
    }),
  ),
);

it.effect("status-only and metadata-only updates retain compiled validator identity", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sync([resource()]);
      yield* f.cache.synced;
      const initial = yield* f.cache.get("echo");
      const status = {
        ...resource(),
        metadata: { ...resource().metadata, resourceVersion: "2" },
        status: { observedGeneration: 1, conditions: [] },
      };
      yield* f.send({ type: "update", object: status });
      yield* waitFor(Effect.map(f.cache.get("echo"), (entry) => entry?.resourceVersion === "2"));
      expect((yield* f.cache.get("echo"))?.result).toBe(initial?.result);
      expect((yield* f.cache.get("echo"))?.status).toEqual(status.status);
      yield* f.send({ type: "update", object: resource("echo", 2) });
      yield* waitFor(Effect.map(f.cache.get("echo"), (entry) => entry?.generation === 2));
      expect((yield* f.cache.get("echo"))?.result).not.toBe(initial?.result);
    }),
  ),
);

it.effect("uid replacement recompiles and a delayed deletion cannot remove the replacement", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sync([resource()]);
      yield* f.cache.synced;
      const initial = yield* f.cache.get("echo");
      yield* f.send({ type: "update", object: resource("echo", 1, "replacement") });
      yield* waitFor(Effect.map(f.cache.get("echo"), (entry) => entry?.uid === "replacement"));
      expect((yield* f.cache.get("echo"))?.result).not.toBe(initial?.result);
      yield* f.send({ type: "delete", object: resource() });
      yield* f.send({ type: "add", object: resource("barrier", 1, "barrier") });
      yield* waitFor(Effect.map(f.cache.get("barrier"), (entry) => entry !== undefined));
      expect((yield* f.cache.get("echo"))?.uid).toBe("replacement");
    }),
  ),
);

it.effect(
  "re-LIST replaces atomically, reuses unchanged compilation and drops missing objects",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sync([resource(), resource("removed", 1, "removed")]);
        yield* f.cache.synced;
        const before = yield* f.cache.get("echo");
        yield* f.sync([resource(), resource("new", 1, "new")]);
        yield* waitFor(Effect.map(f.cache.get("new"), (entry) => entry !== undefined));
        expect(yield* f.cache.get("removed")).toBeUndefined();
        expect((yield* f.cache.get("echo"))?.result).toBe(before?.result);
      }),
    ),
);

it.effect("namespace isolation, deterministic list, owned snapshots and bounded ready gauges", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const external = resource("outside");
      external.metadata.namespace = "another-test-namespace";
      const input = resource("z-last");
      const invalid = resource("bad");
      invalid.spec.image = "not-pinned";
      yield* f.sync([input, resource("a-first"), invalid, external]);
      yield* f.cache.synced;
      expect((yield* f.cache.list).map((entry) => entry.name)).toEqual(["a-first", "z-last"]);
      input.spec.image = "mutated";
      expect((yield* f.cache.get("z-last"))?.spec?.image).not.toBe("mutated");
      expect(Object.isFrozen((yield* f.cache.get("z-last"))?.spec)).toBe(true);
      expect(
        yield* Metric.value(
          Metric.withAttributes(Metric.gauge("krun_functions"), { ready: "true" }),
        ),
      ).toEqual({ value: 2 });
      expect(
        yield* Metric.value(
          Metric.withAttributes(Metric.gauge("krun_functions"), { ready: "false" }),
        ),
      ).toEqual({ value: 1 });
    }),
  ),
);

it.effect(
  "404 before CRD establishment and watch errors retry with bounded backoff, never false sync",
  () =>
    run(
      Effect.gen(function* () {
        let starts = 0;
        const source = Layer.succeed(FunctionSource, {
          watch: () =>
            Stream.unwrap(
              Effect.sync(() => {
                starts++;
                if (starts <= 2)
                  return Stream.fail(
                    new KubeApiError({
                      operation: "functions",
                      reason: "request_failed",
                      status: starts === 1 ? 404 : 503,
                    }),
                  );
                return Stream.succeed<FunctionEvent>({ type: "sync", items: [resource()] }).pipe(
                  Stream.concat(Stream.never),
                );
              }),
            ),
        });
        const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
        yield* waitFor(Effect.sync(() => starts === 1));
        expect(yield* cache.isSynced).toBe(false);
        yield* TestClock.adjust("99 millis");
        expect(starts).toBe(1);
        yield* TestClock.adjust("1 millis");
        yield* waitFor(Effect.sync(() => starts === 2));
        expect(yield* cache.isSynced).toBe(false);
        yield* TestClock.adjust("200 millis");
        yield* cache.synced;
        expect(starts).toBe(3);
        expect((yield* cache.list).length).toBe(1);
      }),
    ),
);

it.effect("scope shutdown stops informer, clears cache and readiness/metrics", () =>
  Effect.gen(function* () {
    const ready = yield* Readiness;
    let f: Effect.Success<typeof fixture> | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        f = yield* fixture;
        yield* f.sync([resource()]);
        yield* f.cache.synced;
        expect(f.starts()).toBe(1);
      }),
    );
    expect(f?.stops()).toBe(1);
    expect((yield* Ref.get(ready.state)).functionsSynced).toBe(false);
    expect(yield* Metric.value(Metric.gauge("krun_functions_synced"))).toEqual({ value: 0 });
  }).pipe(Effect.provide(ReadinessLive(Effect.void))),
);

it.effect("repeated failures cap exponential reconnect delay at thirty seconds", () =>
  run(
    Effect.gen(function* () {
      let starts = 0;
      const source = Layer.succeed(FunctionSource, {
        watch: () =>
          Stream.unwrap(
            Effect.sync(() => {
              starts++;
              return Stream.fail(
                new KubeApiError({ operation: "functions", reason: "request_failed", status: 404 }),
              );
            }),
          ),
      });
      const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
      yield* waitFor(Effect.sync(() => starts === 1));
      for (const delay of [
        100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000, 30000,
      ]) {
        const before = starts;
        yield* TestClock.adjust(Duration.millis(delay - 1));
        expect(starts).toBe(before);
        yield* TestClock.adjust("1 millis");
        yield* waitFor(Effect.sync(() => starts === before + 1));
      }
      expect(yield* cache.isSynced).toBe(false);
    }),
  ),
);

it.effect("a post-sync error re-LISTs, removes vanished entries and preserves initial sync", () =>
  run(
    Effect.gen(function* () {
      let attempts = 0;
      const source = Layer.succeed(FunctionSource, {
        watch: () =>
          Stream.unwrap(
            Effect.sync(() => {
              attempts++;
              return attempts === 1
                ? Stream.succeed<FunctionEvent>({ type: "sync", items: [resource("before")] }).pipe(
                    Stream.concat(
                      Stream.fail(
                        new KubeApiError({
                          operation: "functions",
                          reason: "request_failed",
                          status: 410,
                        }),
                      ),
                    ),
                  )
                : Stream.succeed<FunctionEvent>({ type: "sync", items: [resource("after")] }).pipe(
                    Stream.concat(Stream.never),
                  );
            }),
          ),
      });
      const cache = yield* makeFunctions({ namespace, ceilings }).pipe(Effect.provide(source));
      yield* cache.synced;
      expect((yield* cache.list).map((entry) => entry.name)).toEqual(["before"]);
      yield* TestClock.adjust("100 millis");
      yield* waitFor(Effect.map(cache.get("after"), (entry) => entry !== undefined));
      expect(yield* cache.get("before")).toBeUndefined();
      expect(yield* cache.isSynced).toBe(true);
      expect(attempts).toBe(2);
    }),
  ),
);

it.effect("closing during backoff prevents a restart", () =>
  run(
    Effect.gen(function* () {
      let attempts = 0;
      const source = Layer.succeed(FunctionSource, {
        watch: () =>
          Stream.unwrap(
            Effect.sync(() => {
              attempts++;
              return Stream.fail(
                new KubeApiError({ operation: "functions", reason: "request_failed" }),
              );
            }),
          ),
      });
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          makeFunctions({ namespace, ceilings }).pipe(
            Effect.provide(source),
            Effect.andThen(Effect.never),
          ),
        ),
      );
      yield* waitFor(Effect.sync(() => attempts === 1));
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("1 minute");
      expect(attempts).toBe(1);
    }),
  ),
);
