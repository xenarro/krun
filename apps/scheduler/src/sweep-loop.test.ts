import { expect, it } from "@effect/vitest";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { DatabaseError, Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { CoreV1Api, type V1Job, type V1Secret } from "@kubernetes/client-node";
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Metric, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { JobPodSource } from "./k8s/informers.js";
import { makeSweepLoop } from "./sweep-loop.js";

const namespace = "krun-test-p410-unit";
const id = (n: number) => `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const secret = (n: number, at = "1970-01-01T00:00:00.000Z"): V1Secret => ({
  metadata: {
    name: `krun-${id(n)}`,
    namespace,
    uid: `uid-${n}`,
    resourceVersion: "1",
    labels: { "krun.io/run-id": id(n) },
    creationTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(at)),
  },
  data: { token: "krun-test-private-not-observed" },
});
const count = Metric.value(Metric.counter("krun_sweep_deleted_total", { incremental: true })).pipe(
  Effect.map((value) => value.count),
);
const fixture = Effect.gen(function* () {
  const actual = yield* Store;
  const ready = yield* Deferred.make<void>();
  const jobs = new Map<string, V1Job>();
  const pending = new Set<string>();
  const source: JobPodSource["Service"] = {
    jobs: {
      list: () => [...jobs.values()],
      get: (_ns, name) => (name === undefined ? undefined : jobs.get(name)),
    },
    pods: { list: () => [], get: () => undefined },
    ready: Deferred.await(ready),
    hasPendingJob: (run) => pending.has(run),
    acknowledgeJob: () => {},
    jobEvents: Stream.empty,
    podEvents: Stream.empty,
  };
  const calls: { before: DateTime.Utc; batch: number }[] = [];
  const batches: number[] = [];
  let sweep: Store["Service"]["sweep"] = () => Effect.succeed(batches.shift() ?? 0);
  const store: Store["Service"] = {
    ...actual,
    sweep: (before, batch) =>
      Effect.suspend(() => {
        calls.push({ before, batch });
        return sweep(before, batch);
      }),
  };
  const list = vi
    .spyOn(CoreV1Api.prototype, "listNamespacedSecret")
    .mockResolvedValue({ items: [] });
  const remove = vi.spyOn(CoreV1Api.prototype, "deleteNamespacedSecret").mockResolvedValue({});
  const connection = yield* makeKubeConnection({
    load: (config) =>
      config.loadFromClusterAndUser(
        { name: namespace, server: "http://krun-test-p410.invalid", skipTLSVerify: true },
        { name: namespace },
      ),
  });
  const owner = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const loop = yield* makeSweepLoop({ namespace, retention: Duration.hours(1) }).pipe(
    Effect.provideService(Store, store),
    Effect.provideService(KubeConnection, connection),
    Effect.provideService(JobPodSource, source),
    Effect.provideService(Scope.Scope, owner),
  );
  return {
    loop,
    calls,
    batches,
    list,
    remove,
    jobs,
    pending,
    owner,
    sync: Deferred.succeed(ready, undefined),
    setSweep: (value: typeof sweep) => {
      sweep = value;
    },
    connection,
  };
});
const run = <R>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, unknown, R>) =>
  fixture.pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
afterEach(() => vi.restoreAllMocks());

it.effect(
  "sweeps full 1000-row batches to a short batch with one clock-derived retention cutoff and committed-only metric",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        f.batches.push(1000, 1000, 7);
        yield* f.loop.iterate;
        expect(f.calls.map((call) => call.batch)).toEqual([1000, 1000, 1000]);
        expect(f.calls.map((call) => DateTime.toEpochMillis(call.before))).toEqual([
          3600000, 3600000, 3600000,
        ]);
        expect(yield* count).toBe(2007);
        expect(f.list).toHaveBeenCalledTimes(1);
        expect(f.list.mock.calls[0]?.[0]).toEqual({
          namespace,
          labelSelector: "krun.io/run-id",
          limit: 1000,
        });
      }),
    ),
);
it.effect("does not judge orphan Secrets or sweep before initial cache readiness", () =>
  run((f) =>
    Effect.gen(function* () {
      const fiber = yield* f.loop.iterate.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(f.calls).toHaveLength(0);
      expect(f.list).not.toHaveBeenCalled();
      yield* f.sync;
      yield* Fiber.join(fiber);
      expect(f.calls).toHaveLength(1);
    }),
  ),
);
it.effect(
  "only old valid labeled same-namespace Secrets without a current or pending Job are deleted with identity preconditions",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        const missingUid = secret(7);
        delete missingUid.metadata?.uid;
        const missingCreated = secret(9);
        delete missingCreated.metadata?.creationTimestamp;
        f.list.mockResolvedValue({
          items: [
            secret(1),
            secret(2, "1970-01-01T01:00:00.000Z"),
            secret(3, "1970-01-01T03:00:00.000Z"),
            secret(4),
            secret(5),
            { metadata: { ...secret(6).metadata, labels: {} } },
            missingUid,
            { metadata: { ...secret(8).metadata, namespace: "other" } },
            missingCreated,
            { metadata: { ...secret(10).metadata, labels: { "krun.io/run-id": "malformed" } } },
          ],
        });
        f.jobs.set("nonstandard-name", {
          metadata: { name: "nonstandard-name", namespace, labels: { "krun.io/run-id": id(4) } },
        });
        f.pending.add(id(5));
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(1);
        expect(f.remove.mock.calls[0]?.[0]).toEqual({
          namespace,
          name: `krun-${id(1)}`,
          body: { preconditions: { uid: "uid-1", resourceVersion: "1" } },
        });
        expect(yield* count).toBe(0);
      }),
    ),
);
it.effect(
  "follows native continuation pages even when a page is short and never uses Secret data",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        f.list
          .mockResolvedValueOnce({ items: [secret(1)], metadata: { _continue: "opaque-next" } })
          .mockResolvedValueOnce({ items: [secret(2)] });
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(2);
        expect(f.list.mock.calls[1]?.[0]).toEqual({
          namespace,
          labelSelector: "krun.io/run-id",
          limit: 1000,
          _continue: "opaque-next",
        });
      }),
    ),
);
it.effect(
  "a per-Secret 503 cannot starve later orphans and the next pass retries;404 and409 are safe",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        f.list.mockResolvedValue({ items: [secret(1), secret(2), secret(3), secret(4)] });
        f.remove
          .mockRejectedValueOnce({ code: 503 })
          .mockRejectedValueOnce({ code: 404 })
          .mockRejectedValueOnce({ code: 409 });
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(4);
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(8);
        expect(yield* count).toBe(0);
      }),
    ),
);
it.effect(
  "rechecks the live Job cache between deletions instead of trusting a list-time snapshot",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        f.list.mockResolvedValue({ items: [secret(1), secret(2)] });
        f.remove.mockImplementationOnce(async () => {
          f.jobs.set("arrived", {
            metadata: { name: "arrived", labels: { "krun.io/run-id": id(2) } },
          });
          return {};
        });
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(1);
      }),
    ),
);
it.effect(
  "partial SQL failure counts only earlier committed batches and retries without stopping the periodic component",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.sync;
        let attempts = 0;
        f.setSweep(() =>
          Effect.suspend(() =>
            ++attempts === 2
              ? Effect.fail(new DatabaseError({ operation: "sweep" }))
              : Effect.succeed(attempts === 1 ? 1000 : 3),
          ),
        );
        yield* f.loop.iterate;
        expect(yield* count).toBe(1000);
        expect(f.list).not.toHaveBeenCalled();
        yield* f.loop.iterate;
        expect(yield* count).toBe(1003);
        expect(f.list).toHaveBeenCalledTimes(1);
      }),
    ),
);
it.effect(
  "a 429 stops further API acquisitions for this pass and retries only on a later pass",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 hours");
        yield* f.sync;
        f.list.mockResolvedValue({ items: [secret(1), secret(2)] });
        f.remove.mockRejectedValueOnce({ code: 429, headers: { "retry-after": "60" } });
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(1);
        yield* f.loop.iterate;
        expect(f.remove).toHaveBeenCalledTimes(3);
      }),
    ),
);
it.effect("malformed and repeated-token lists stop safely instead of spinning or guessing", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.sync;
      f.list
        .mockResolvedValueOnce({ items: [], metadata: { _continue: "same" } })
        .mockResolvedValueOnce({ items: [], metadata: { _continue: "same" } });
      yield* f.loop.iterate;
      expect(f.list).toHaveBeenCalledTimes(2);
      f.list.mockResolvedValueOnce({ items: undefined } as unknown as Awaited<
        ReturnType<CoreV1Api["listNamespacedSecret"]>
      >);
      yield* f.loop.iterate;
      expect(f.remove).not.toHaveBeenCalled();
    }),
  ),
);
it.effect("overlapping explicit iterations serialize SQL and native work", () =>
  run((f) =>
    Effect.gen(function* () {
      yield* f.sync;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      f.setSweep(() => {
        if (!first) return Effect.succeed(0);
        first = false;
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(0),
        );
      });
      const a = yield* f.loop.iterate.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const b = yield* f.loop.iterate.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(f.calls).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      expect(f.calls).toHaveLength(2);
    }),
  ),
);
it.effect(
  "runs immediately then every ten minutes without overlap and stops on leader-scope closure",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.sync;
        const fiber = yield* f.loop.run.pipe(Effect.forkScoped);
        while (f.list.mock.calls.length < 1) yield* Effect.yieldNow;
        yield* TestClock.adjust("599 seconds");
        expect(f.calls).toHaveLength(1);
        yield* TestClock.adjust("1 second");
        expect(f.calls).toHaveLength(2);
        yield* Fiber.interrupt(fiber);
        yield* Scope.close(f.owner, Exit.void);
        yield* f.loop.iterate;
        yield* f.loop.run;
        expect(f.calls).toHaveLength(2);
      }),
    ),
);
it.effect(
  "the shared ten-second native request budget ends a hanging list without counting extra rows",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.sync;
        f.list.mockImplementationOnce(() => new Promise(() => {}));
        const fiber = yield* f.loop.iterate.pipe(Effect.forkScoped);
        while (f.list.mock.calls.length < 1) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        expect(yield* count).toBe(0);
      }),
    ),
);

it.effect(
  "interruption after a batch starts settles the committed count before stopping subsequent work",
  () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.sync;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setSweep(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(7),
          ),
        );
        const fiber = yield* f.loop.iterate.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const stopped = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopped);
        expect(yield* count).toBe(7);
        expect(f.list).not.toHaveBeenCalled();
      }),
    ),
);
