import { expect, it } from "@effect/vitest";
import { type FunctionEntry, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { FunctionSource, makeFunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  type StatusFunction,
  startFunctionStatusKube,
} from "../../../test/fake-kube/functions-status.js";
import { makeFunctionStatusWriter } from "./function-status.js";

const namespace = "krun-test-p47-native";
const object = (
  generation = 1,
  resourceVersion = "1",
  uid = "krun-test-p47-uid",
): StatusFunction => ({
  metadata: { name: "echo", namespace, generation, resourceVersion, uid },
  spec: {
    image: `example.invalid/job@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object" },
    env: [{ name: "PRIVATE", value: "krun-test-private-env-canary" }],
  },
});
const fixture = (initial: StatusFunction) =>
  Effect.gen(function* () {
    const fake = yield* Effect.acquireRelease(
      Effect.promise(() => startFunctionStatusKube(namespace, [initial])),
      (fake) => Effect.promise(() => fake.close()),
    );
    const connection = yield* makeKubeConnection({
      load: (config) =>
        config.loadFromClusterAndUser(
          { name: namespace, server: fake.address, skipTLSVerify: true },
          { name: namespace },
        ),
    });
    const source = yield* makeFunctionSource.pipe(
      Effect.provideService(KubeConnection, connection),
    );
    const cache = yield* makeFunctions({
      namespace,
      ceilings: {
        maxActiveDeadline: 86400,
        maxQueued: 1000,
        allowedRegistries: [],
        allowedServiceAccounts: ["krun-job-default"],
        webhookAllowedHosts: [],
      },
    }).pipe(
      Effect.provideService(FunctionSource, source),
      Effect.provide(ReadinessLive(Effect.void)),
    );
    yield* cache.synced;
    yield* Effect.promise(() => fake.watching);
    const writer = yield* makeFunctionStatusWriter({ namespace, cache: cache.status }).pipe(
      Effect.provideService(KubeConnection, connection),
    );
    const observe = (predicate: (entry: FunctionEntry | undefined) => boolean) =>
      Stream.runHead(
        cache.status.changes.pipe(
          Stream.mapEffect(() => cache.getAny("echo")),
          Stream.filter(predicate),
        ),
      );
    return { fake, cache, writer, observe };
  });

it.live(
  "native CustomObjectsApi uses status Merge Patch, echoes without recompilation or repeated writes, and repairs status erasure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = object();
        const f = yield* fixture({
          ...initial,
          spec: { ...initial.spec, inputSchema: { type: "not-a-type" } },
        });
        const compiled = (yield* f.cache.getAny("echo"))?.result;
        yield* f.writer.reconcile;
        yield* f.observe((entry) => entry?.status?.conditions?.[0]?.status === "False");
        expect(f.fake.patches).toHaveLength(1);
        expect(f.fake.patches[0]).toMatchObject({
          name: "echo",
          code: 200,
          contentType: "application/merge-patch+json",
          body: {
            metadata: { uid: initial.metadata.uid, resourceVersion: "1" },
            status: {
              observedGeneration: 1,
              conditions: [{ type: "Ready", status: "False", reason: "SchemaInvalid" }],
            },
          },
        });
        expect((yield* f.cache.getAny("echo"))?.result).toBe(compiled);
        yield* f.writer.reconcile;
        expect(f.fake.patches).toHaveLength(1);
        const running = yield* Effect.forkScoped(f.writer.run);
        const erased = f.fake.snapshot("echo");
        if (!erased) return yield* Effect.die("Owned object missing");
        f.fake.observe({
          ...erased,
          metadata: { ...erased.metadata, resourceVersion: "200" },
          status: {},
        });
        yield* Effect.promise(() => f.fake.waitForPatches(2));
        yield* f.observe(
          (entry) =>
            entry?.status?.conditions?.[0]?.status === "False" && entry.resourceVersion !== "200",
        );
        f.fake.observe({ ...object(2, "201"), status: {} });
        yield* Effect.promise(() => f.fake.waitForPatches(3));
        yield* f.observe((entry) => entry?.status?.observedGeneration === 2);
        yield* f.writer.reconcile;
        expect(f.fake.patches).toHaveLength(3);
        expect(f.fake.patches[2]).toMatchObject({
          code: 200,
          body: {
            status: {
              observedGeneration: 2,
              conditions: [{ type: "Ready", status: "True", reason: "Valid", message: "" }],
            },
          },
        });
        expect(JSON.stringify(f.fake.patches)).not.toContain("krun-test-private-env-canary");
        yield* Fiber.interrupt(running);
      }),
    ),
);

for (const change of ["generation", "uid"] as const) {
  it.live(
    `native optimistic status patch cannot write an old validation across ${change} replacement`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture(object());
          const held = f.fake.holdNext();
          const running = yield* Effect.forkScoped(f.writer.run);
          yield* Effect.promise(() => held.started);
          const replacement = object(
            change === "generation" ? 2 : 1,
            "300",
            change === "uid" ? "replacement-uid" : "krun-test-p47-uid",
          );
          f.fake.observe({
            ...replacement,
            spec: { ...replacement.spec, inputSchema: { type: "invalid" } },
          });
          yield* f.observe((entry) => entry?.resourceVersion === "300");
          held.release();
          yield* Effect.promise(() => f.fake.waitForPatches(2));
          yield* f.observe((entry) => entry?.status?.conditions?.[0]?.reason === "SchemaInvalid");
          expect(f.fake.patches.map((patch) => patch.code)).toEqual([409, 200]);
          expect(f.fake.patches[1]).toMatchObject({
            body: {
              metadata: {
                uid: replacement.metadata.uid,
                resourceVersion: "300",
              },
              status: { observedGeneration: replacement.metadata.generation },
            },
          });
          yield* Fiber.interrupt(running);
        }),
      ),
  );
}

it.live(
  "interrupting the leader writer aborts an actual pending native patch socket without acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture(object());
        const held = f.fake.holdNext();
        const writing = yield* Effect.forkScoped(f.writer.reconcile);
        yield* Effect.promise(() => held.started);
        yield* Fiber.interrupt(writing);
        yield* Effect.promise(() => held.aborted);
        held.release();
        expect(f.fake.patches).toHaveLength(0);
        yield* f.writer.reconcile;
        expect(f.fake.patches.map((patch) => patch.code)).toEqual([200]);
      }),
    ),
);

it.effect(
  "native pending status patch shares the ten-second Effect Clock budget and remains retryable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(object());
      const held = f.fake.holdNext();
      const writing = yield* Effect.forkScoped(f.writer.reconcile);
      yield* Effect.promise(() => held.started);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(writing);
      yield* Effect.promise(() => held.aborted);
      held.release();
      expect(f.fake.patches).toHaveLength(0);
      yield* f.writer.reconcile;
      expect(f.fake.patches.map((patch) => patch.code)).toEqual([200]);
    }),
);
