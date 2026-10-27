import { expect, it } from "@effect/vitest";
import { makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { type FunctionEvent, FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { CustomObjectsApi } from "@kubernetes/client-node";
import { Deferred, Effect, Fiber, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { makeFunctionStatusWriter } from "./function-status.js";
import { runLeaderElection } from "./k8s/leader-election.js";
import { LeaseApi, type LeaseRecord } from "./k8s/lease-api.js";

const namespace = "krun-test-p47-status";
const resource = (name = "echo", generation = 1, resourceVersion = "1", uid = `uid-${name}`) => ({
  metadata: { name, namespace, uid, generation, resourceVersion },
  spec: {
    image: `example.invalid/worker@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object" },
  },
});
const invalid = () => ({
  ...resource("invalid"),
  spec: { ...resource().spec, inputSchema: { type: "not-a-type" } },
});
const ready = (generation = 1) => ({
  observedGeneration: generation,
  conditions: [{ type: "Ready", status: "True", reason: "Valid", message: "" }],
});
const fixture = Effect.gen(function* () {
  const feed = yield* Queue.unbounded<FunctionEvent>();
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
    Effect.provideService(FunctionSource, { watch: () => Stream.fromQueue(feed) }),
    Effect.provide(ReadinessLive(Effect.void)),
  );
  const connection = yield* makeKubeConnection({
    load: (config) =>
      config.loadFromClusterAndUser(
        { name: namespace, server: "http://krun-test-p47.invalid", skipTLSVerify: true },
        { name: namespace },
      ),
  });
  const writer = yield* makeFunctionStatusWriter({ namespace, cache: cache.status }).pipe(
    Effect.provideService(KubeConnection, connection),
  );
  const send = (event: FunctionEvent) => Queue.offer(feed, event);
  const sync = (items: readonly unknown[]) =>
    send({ type: "sync", items }).pipe(Effect.andThen(cache.synced));
  const observed = (name: string, version: string | undefined) =>
    Effect.gen(function* () {
      while ((yield* cache.getAny(name))?.resourceVersion !== version) yield* Effect.yieldNow;
    });
  return { cache, writer, connection, send, sync, observed };
});
afterEach(() => vi.restoreAllMocks());

it.effect(
  "P4.7: invalid Function gets Ready=False with validation reason; repeated input patches once",
  () =>
    Effect.gen(function* () {
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockResolvedValue({});
      const f = yield* fixture;
      yield* f.sync([invalid()]);
      expect(yield* f.cache.list).toEqual([]);
      yield* f.writer.reconcile;
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(1);
      const entry = yield* f.cache.getAny("invalid");
      expect(patch.mock.calls[0]?.[0]).toEqual({
        group: "krun.io",
        version: "v1alpha1",
        namespace,
        plural: "functions",
        name: "invalid",
        body: {
          metadata: { uid: "uid-invalid", resourceVersion: "1" },
          status: {
            observedGeneration: 1,
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "SchemaInvalid",
                message: entry?.result.message,
              },
            ],
          },
        },
      });
    }),
);

it.effect(
  "current condition is authoritative: echoed status is free, erased/new-generation/replaced status is repaired",
  () =>
    Effect.gen(function* () {
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockResolvedValue({});
      const f = yield* fixture;
      yield* f.sync([{ ...resource(), status: ready() }]);
      yield* f.writer.reconcile;
      expect(patch).not.toHaveBeenCalled();
      yield* f.send({ type: "update", object: { ...resource("echo", 1, "2"), status: {} } });
      yield* f.observed("echo", "2");
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(1);
      yield* f.send({ type: "update", object: { ...resource("echo", 1, "3"), status: ready() } });
      yield* f.observed("echo", "3");
      const compiled = (yield* f.cache.getAny("echo"))?.result;
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(1);
      yield* f.send({ type: "update", object: { ...resource("echo", 2, "4"), status: ready() } });
      yield* f.observed("echo", "4");
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch.mock.calls[1]?.[0].body.status).toEqual(ready(2));
      expect((yield* f.cache.getAny("echo"))?.result).not.toBe(compiled);
      yield* f.send({ type: "delete", object: resource("echo", 2, "4") });
      yield* f.observed("echo", undefined);
      yield* f.writer.reconcile;
      yield* f.send({ type: "add", object: resource("echo", 1, "1", "replacement") });
      yield* f.observed("echo", "1");
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(3);
      expect(patch.mock.calls[2]?.[0].body.metadata.uid).toBe("replacement");
    }),
);

for (const field of ["status", "reason", "message"] as const) {
  it.effect(
    `condition-only ${field} change is repaired even with observedGeneration already current`,
    () =>
      Effect.gen(function* () {
        const patch = vi
          .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
          .mockResolvedValue({});
        const f = yield* fixture;
        const current = ready();
        const condition = current.conditions[0];
        if (condition === undefined) return yield* Effect.die("Owned condition missing");
        condition[field] =
          field === "status" ? "False" : field === "reason" ? "SchemaInvalid" : "outdated";
        yield* f.sync([{ ...resource(), status: current }]);
        yield* f.writer.reconcile;
        expect(patch).toHaveBeenCalledTimes(1);
        expect(patch.mock.calls[0]?.[0].body.status).toEqual(ready());
      }),
  );
}

it.effect(
  "failed patches do not acknowledge inputs or starve other Functions; a later pass retries",
  () =>
    Effect.gen(function* () {
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockRejectedValueOnce({ code: 503, body: { message: "private-status-canary" } })
        .mockResolvedValue({});
      const f = yield* fixture;
      yield* f.sync([resource("a"), resource("b")]);
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(2);
      yield* f.writer.reconcile;
      expect(patch).toHaveBeenCalledTimes(3);
      expect(patch.mock.calls.map(([request]) => request.name)).toEqual(["a", "b", "a"]);
    }),
);

it.effect(
  "the leader-scoped subscription starts with the full cache and follows changes, not just valid Functions",
  () =>
    Effect.gen(function* () {
      const patched = yield* Queue.unbounded<string>();
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockImplementation(async (request) => {
          Queue.offerUnsafe(patched, request.name);
          return {};
        });
      const f = yield* fixture;
      yield* f.sync([invalid()]);
      expect(patch).not.toHaveBeenCalled();
      const fiber = yield* Effect.forkScoped(f.writer.run);
      expect(yield* Queue.take(patched)).toBe("invalid");
      yield* f.send({ type: "add", object: resource() });
      expect(yield* Queue.take(patched)).toBe("echo");
      yield* Fiber.interrupt(fiber);
      yield* f.send({ type: "add", object: resource("after-close") });
      yield* f.observed("after-close", "1");
      expect(patch).toHaveBeenCalledTimes(2);
    }),
);

it.effect("closing the writer scope prevents future writes through retained capabilities", () =>
  Effect.gen(function* () {
    const patch = vi
      .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
      .mockResolvedValue({});
    const f = yield* fixture;
    yield* f.sync([invalid()]);
    const scope = yield* Scope.make();
    const connection = yield* makeKubeConnection({
      load: (config) =>
        config.loadFromClusterAndUser(
          { name: namespace, server: "http://krun-test-p47.invalid", skipTLSVerify: true },
          { name: namespace },
        ),
    });
    const writer = yield* makeFunctionStatusWriter({ namespace, cache: f.cache.status }).pipe(
      Effect.provideService(KubeConnection, connection),
      Effect.provideService(Scope.Scope, scope),
    );
    yield* Scope.close(scope, yield* Effect.exit(Effect.void));
    yield* writer.reconcile;
    expect(patch).not.toHaveBeenCalled();
  }),
);

it.effect(
  "a blocked earlier patch cannot make the pass write a stale generation for another Function",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockImplementation(async (request) => {
          if (request.name === "a") {
            Deferred.doneUnsafe(started, Effect.void);
            await Effect.runPromise(Deferred.await(release));
          }
          return {};
        });
      const f = yield* fixture;
      yield* f.sync([resource("a"), resource("b")]);
      const writing = yield* Effect.forkScoped(f.writer.reconcile);
      yield* Deferred.await(started);
      yield* f.send({ type: "update", object: resource("b", 2, "2") });
      yield* f.observed("b", "2");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writing);
      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch.mock.calls[1]?.[0]).toMatchObject({
        name: "b",
        body: {
          metadata: { resourceVersion: "2" },
          status: { observedGeneration: 2 },
        },
      });
    }),
);

it.effect(
  "real election keeps the writer silent on standby and closes its subscription on leader loss",
  () =>
    Effect.gen(function* () {
      const patched = yield* Deferred.make<void>();
      const read = yield* Deferred.make<void>();
      const patch = vi
        .spyOn(CustomObjectsApi.prototype, "patchNamespacedCustomObjectStatus")
        .mockImplementation(async () => {
          Deferred.doneUnsafe(patched, Effect.void);
          return {};
        });
      const f = yield* fixture;
      yield* f.sync([invalid()]);
      let current: LeaseRecord = {
        metadata: { resourceVersion: "1" },
        spec: { holderIdentity: "other" },
      };
      const api: LeaseApi["Service"] = {
        read: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(read, undefined);
            return current;
          }),
        create: (_namespace, body) => Effect.succeed(body),
        replace: (_namespace, body) =>
          Effect.sync(() => {
            current = body;
            return current;
          }),
      };
      const work = Effect.gen(function* () {
        const writer = yield* makeFunctionStatusWriter({ namespace, cache: f.cache.status }).pipe(
          Effect.provideService(KubeConnection, f.connection),
        );
        yield* Effect.forkScoped(writer.run);
      });
      const election = yield* Effect.forkScoped(
        Effect.exit(
          runLeaderElection({ namespace, podName: "krun-test-p47-leader" }, work).pipe(
            Effect.provideService(LeaseApi, api),
            Effect.provide(ReadinessLive(Effect.void)),
          ),
        ),
      );
      yield* Deferred.await(read);
      expect(patch).not.toHaveBeenCalled();
      current = { metadata: { resourceVersion: "2" }, spec: { holderIdentity: "" } };
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(patched);
      current = {
        metadata: { resourceVersion: "3" },
        spec: { holderIdentity: "replacement-leader" },
      };
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(election))._tag).toBe("Failure");
      yield* f.send({ type: "update", object: resource("invalid", 2, "2") });
      yield* f.observed("invalid", "2");
      expect(patch).toHaveBeenCalledTimes(1);
    }),
);
