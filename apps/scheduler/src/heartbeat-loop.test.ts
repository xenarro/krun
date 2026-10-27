import { expect, it } from "@effect/vitest";
import { type FunctionEntry, Functions } from "@krun/shared/dist/functions/cache.js";
import { functionSpecSchema } from "@krun/shared/dist/functions/schema.js";
import { validateFunction } from "@krun/shared/dist/functions/validation.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { DatabaseError, Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { DateTime, Deferred, Effect, Fiber, Metric, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeHeartbeatLoop } from "./heartbeat-loop.js";
import { makeJobController } from "./job-controller.js";
import { JobPodSource } from "./k8s/informers.js";
import { Kube } from "./k8s/kube.js";

const id = "0192f000-0000-7000-8000-000000000049";
const fn = "p49-echo";
const namespace = "krun-test-p49-unit";
const entry = (timeout = true): FunctionEntry => {
  const spec = functionSpecSchema.parse({
    image: `ghcr.io/krun-test/function@sha256:${"a".repeat(64)}`,
    inputSchema: { type: "object" },
    ...(timeout ? { heartbeatTimeout: "30s" } : {}),
  });
  return {
    name: fn,
    uid: "krun-test-p49",
    generation: 1,
    resourceVersion: "1",
    spec,
    status: undefined,
    result: validateFunction(spec, {
      maxActiveDeadline: 86400,
      maxQueued: 1000,
      allowedRegistries: ["ghcr.io"],
      allowedServiceAccounts: ["krun-job-default"],
      webhookAllowedHosts: [],
    }),
  };
};
const fixture = (options: { synced?: boolean; stale?: boolean } = {}) =>
  Effect.gen(function* () {
    const actual = yield* Store;
    yield* actual.migrate();
    yield* actual.createRun({
      id,
      function_name: fn,
      input: {},
      idempotency_key: null,
      request_hash: "a".repeat(64),
      priority: 0,
      created_by: "krun-test-p49",
      created_at: yield* DateTime.now,
      callback_url: "https://receiver.example.invalid/heartbeat",
    });
    yield* actual.setJobToken(id, `krun-${id}`, "owned-test-hash");
    yield* actual.markScheduled(id);
    yield* actual.transition(id, "scheduled", "running", null, {});
    if (options.stale !== false) yield* TestClock.adjust("31 seconds");
    const jobs = new Map<string, V1Job>();
    const pods = new Map<string, V1Pod>();
    const job: V1Job = {
      metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
      status: { conditions: [] },
    };
    const pod: V1Pod = {
      metadata: { name: "krun-test-p49-pod", namespace, labels: { "krun.io/run-id": id } },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "function",
            image: "owned",
            imageID: "owned",
            ready: true,
            restartCount: 0,
            state: { running: {} },
          },
        ],
      },
    };
    jobs.set(`krun-${id}`, job);
    pods.set("krun-test-p49-pod", pod);
    const jobsReady = yield* Deferred.make<void>();
    const podsReady = yield* Deferred.make<void>();
    if (options.synced !== false) {
      yield* Deferred.succeed(jobsReady, undefined);
      yield* Deferred.succeed(podsReady, undefined);
    }
    const calls: string[] = [];
    let log: Effect.Effect<string, KubeApiError> = Effect.succeed("krun-test-p49-private-tail");
    let deleting: Effect.Effect<void, KubeApiError> = Effect.void;
    let secret: Effect.Effect<void, KubeApiError> = Effect.void;
    let committing: Effect.Effect<void, DatabaseError> = Effect.void;
    let pendingJob = false;
    let currentEntry = entry();
    const store: Store["Service"] = {
      ...actual,
      listStale: (...args) =>
        Effect.sync(() => void calls.push("list")).pipe(Effect.andThen(actual.listStale(...args))),
      transition: (...args) =>
        Effect.sync(() => void calls.push("cas")).pipe(
          Effect.andThen(Effect.suspend(() => committing)),
          Effect.andThen(actual.transition(...args)),
        ),
    };
    const kube: Kube["Service"] = {
      createJob: () => Effect.succeed({}),
      createSecret: () => Effect.succeed({}),
      readSecret: () => Effect.succeed({}),
      readPodLog: (target) =>
        Effect.suspend(() => {
          expect(target).toMatchObject({
            namespace,
            name: "krun-test-p49-pod",
            runId: id,
            function: fn,
          });
          calls.push("logs");
          return log;
        }),
      deleteJob: (_target, policy) =>
        Effect.sync(() => void calls.push(policy)).pipe(
          Effect.andThen(Effect.suspend(() => deleting)),
          Effect.tap(() =>
            Effect.sync(() => {
              jobs.clear();
              pods.clear();
            }),
          ),
        ),
      deleteSecret: () =>
        Effect.sync(() => void calls.push("secret")).pipe(
          Effect.andThen(Effect.suspend(() => secret)),
        ),
    };
    const source: JobPodSource["Service"] = {
      jobs: { list: () => [...jobs.values()], get: (name) => jobs.get(name) },
      pods: { list: () => [...pods.values()], get: (name) => pods.get(name) },
      ready: Effect.all([Deferred.await(jobsReady), Deferred.await(podsReady)]).pipe(Effect.asVoid),
      jobEvents: Stream.empty,
      podEvents: Stream.empty,
      hasPendingJob: () => pendingJob,
      acknowledgeJob: () => {},
    };
    const functions: Functions["Service"] = {
      get: () => Effect.sync(() => currentEntry),
      getAny: () => Effect.sync(() => currentEntry),
      list: Effect.sync(() => [currentEntry]),
      synced: Effect.void,
      isSynced: Effect.succeed(true),
    };
    const controller = yield* makeJobController({
      namespace,
      maxRunning: 8,
      checkResult: () => Effect.succeed(null),
    }).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(Kube, kube),
      Effect.provideService(JobPodSource, source),
    );
    const heartbeat = yield* makeHeartbeatLoop({ controller }).pipe(
      Effect.provideService(Store, store),
      Effect.provideService(Functions, functions),
      Effect.provideService(JobPodSource, source),
    );
    const operations = () => calls.filter((value) => value !== "list");
    return {
      actual,
      heartbeat,
      controller,
      calls,
      operations,
      jobs,
      pods,
      job,
      pod,
      jobsReady,
      podsReady,
      setTimeout: (value: boolean) => {
        currentEntry = entry(value);
      },
      setLog: (value: typeof log) => {
        log = value;
      },
      setDelete: (value: typeof deleting) => {
        deleting = value;
      },
      setSecret: (value: typeof secret) => {
        secret = value;
      },
      setCommit: (value: typeof committing) => {
        committing = value;
      },
      setPending: (value: boolean) => {
        pendingJob = value;
      },
    };
  });
const test = <R>(
  body: (f: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<void, unknown, R>,
  options: Parameters<typeof fixture>[0] = {},
) =>
  fixture(options).pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
const count = Metric.value(
  Metric.withAttributes(Metric.counter("krun_runs_failed_total", { incremental: true }), {
    function: fn,
    reason: "heartbeat_timeout",
  }),
).pipe(Effect.map((value) => value.count));

it.effect(
  "stale heartbeat orders logs,foreground delete,winning CAS,Secret and atomic BASIC delivery",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual(["logs", "Foreground", "cas", "secret"]);
        expect(yield* f.actual.getRun(id)).toMatchObject({
          state: "failed",
          failure_reason: "heartbeat_timeout",
          log_tail: "krun-test-p49-private-tail",
          error: { source: "krun", message: "no status for 30s, last at 1970-01-01T00:00:00.000Z" },
        });
        expect(yield* count).toBe(1);
        const deliveries = yield* f.actual.claimDeliveries(yield* DateTime.now, 10);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.payload).not.toHaveProperty("logTail");
        yield* f.heartbeat.iterate;
        expect(yield* count).toBe(1);
        expect(f.operations()).toHaveLength(4);
      }),
    ),
);
it.effect("functions without heartbeatTimeout are never queried or judged", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setTimeout(false);
      yield* f.heartbeat.iterate;
      expect(f.calls).toEqual([]);
      expect((yield* f.actual.getRun(id)).state).toBe("running");
    }),
  ),
);
it.effect("fresh runtimeStatus survives a stale startTime", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.actual.setRuntimeStatus(id, {
        message: "owned fresh status",
        at: yield* DateTime.now,
      });
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual([]);
      expect(yield* count).toBe(0);
    }),
  ),
);
for (const terminal of ["Complete", "Failed"])
  it.effect(`cached Job ${terminal} belongs to the informer path`, () =>
    test((f) =>
      Effect.gen(function* () {
        f.job.status = { conditions: [{ type: terminal, status: "True" }] };
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual([]);
      }),
    ),
  );
for (const phase of [undefined, "Pending", "Succeeded", "Failed"])
  it.effect(`pod phase ${phase} is never killed`, () =>
    test((f) =>
      Effect.gen(function* () {
        if (phase === undefined) f.pods.clear();
        else f.pod.status = { phase };
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual([]);
      }),
    ),
  );
it.effect("reported function error is preserved separately from heartbeat failure and tail", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.actual.setError(id, {
        source: "function",
        message: "owned report",
        details: { private: "krun-test-p49-error-canary" },
      });
      yield* f.heartbeat.iterate;
      expect(yield* f.actual.getRun(id)).toMatchObject({
        failure_reason: "heartbeat_timeout",
        error: { source: "function", message: "owned report" },
        log_tail: "krun-test-p49-private-tail",
      });
    }),
  ),
);
it.effect("nothing fires before both lists; ten-second cadence does not overlap", () =>
  test(
    (f) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(f.heartbeat.run);
        yield* TestClock.adjust("10 seconds");
        expect(f.calls).toEqual([]);
        yield* Deferred.succeed(f.jobsReady, undefined);
        yield* TestClock.adjust("10 seconds");
        expect(f.calls).toEqual([]);
        yield* Deferred.succeed(f.podsReady, undefined);
        yield* TestClock.adjust("0 millis");
        expect(f.calls.filter((c) => c === "list")).toHaveLength(1);
        yield* TestClock.adjust("9999 millis");
        expect(f.calls.filter((c) => c === "list")).toHaveLength(1);
        yield* TestClock.adjust("1 millis");
        expect(f.calls.filter((c) => c === "list")).toHaveLength(2);
        yield* Fiber.interrupt(fiber);
      }),
    { synced: false, stale: false },
  ),
);
it.effect(
  "hanging logs abort after ten seconds but persistence still proceeds with null tail",
  () =>
    test((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let aborted = false;
        f.setLog(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                aborted = true;
              }),
            ),
          ),
        );
        const fiber = yield* Effect.forkScoped(f.heartbeat.iterate);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(fiber);
        expect(aborted).toBe(true);
        expect(yield* f.actual.getRun(id)).toMatchObject({ state: "failed", log_tail: null });
      }),
    ),
);
it.effect("a status refreshed during log capture prevents destructive delete", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setLog(
        f.actual
          .setRuntimeStatus(id, { message: "recovered", at: yield* DateTime.now })
          .pipe(Effect.orDie, Effect.as("owned tail")),
      );
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual(["logs"]);
      expect((yield* f.actual.getRun(id)).state).toBe("running");
    }),
  ),
);
it.effect("terminal cache change during logs is left to the informer", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setLog(
        Effect.sync(() => {
          f.job.status = { conditions: [{ type: "Complete", status: "True" }] };
          return "owned tail";
        }),
      );
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual(["logs"]);
    }),
  ),
);
it.effect("foreground deletion failure never publishes terminal state or deletes Secret", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setDelete(
        Effect.fail(
          new KubeApiError({ operation: "request", reason: "request_failed", status: 503 }),
        ),
      );
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual(["logs", "Foreground"]);
      expect((yield* f.actual.getRun(id)).state).toBe("running");
      expect(yield* count).toBe(0);
    }),
  ),
);
it.effect(
  "post-delete Store failure retries its owned CAS even after both cached objects vanish",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.setCommit(Effect.fail(new DatabaseError({ operation: "transition" })));
        yield* f.heartbeat.iterate;
        expect((yield* f.actual.getRun(id)).state).toBe("running");
        f.setCommit(Effect.void);
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual(["logs", "Foreground", "cas", "cas", "secret"]);
        expect((yield* f.actual.getRun(id)).failure_reason).toBe("heartbeat_timeout");
        expect(yield* count).toBe(1);
      }),
    ),
);
it.effect(
  "post-CAS Secret retry survives disabled timeout without refetch,redelete or recount",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.setSecret(
          Effect.fail(
            new KubeApiError({ operation: "request", reason: "request_failed", status: 503 }),
          ),
        );
        yield* f.heartbeat.iterate;
        f.setTimeout(false);
        f.setSecret(Effect.void);
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual(["logs", "Foreground", "cas", "secret", "secret"]);
        expect(yield* count).toBe(1);
      }),
    ),
);
it.effect(
  "cancellation wins a racing CAS without a second terminal write or Secret ownership theft",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.setCommit(f.actual.transition(id, "running", "cancelling", null, {}).pipe(Effect.asVoid));
        yield* f.heartbeat.iterate;
        expect((yield* f.actual.getRun(id)).state).toBe("cancelling");
        expect(f.operations()).toEqual(["logs", "Foreground", "cas"]);
        expect(yield* count).toBe(0);
      }),
    ),
);
it.effect(
  "pending native Job ingress defers heartbeat rather than guessing its terminal body",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.setPending(true);
        yield* f.heartbeat.iterate;
        expect(f.operations()).toEqual([]);
      }),
    ),
);

it.effect("a ten-second-old status is still fresh under the configured thirty-second timeout", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.actual.setRuntimeStatus(id, {
        message: "still fresh",
        at: DateTime.makeUnsafe(21000),
      });
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual([]);
    }),
  ),
);
it.effect("the exact heartbeat cutoff is not stale", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.actual.setRuntimeStatus(id, { message: "boundary", at: DateTime.makeUnsafe(1000) });
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual([]);
    }),
  ),
);
it.effect("oversized running logs preserve BOM and complete UTF-8 within sixteen KiB", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setLog(Effect.succeed("\ufeff" + "a".repeat(16380) + "界"));
      yield* f.heartbeat.iterate;
      const row = yield* f.actual.getRun(id);
      expect(row.log_tail?.startsWith("\ufeff")).toBe(true);
      expect(Buffer.byteLength(row.log_tail ?? "")).toBe(16383);
      expect(row.log_tail).not.toContain("\ufffd");
    }),
  ),
);
it.effect("log transport failure is best-effort and never blocks the ordered timeout", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setLog(
        Effect.fail(
          new KubeApiError({ operation: "request", reason: "request_failed", status: 403 }),
        ),
      );
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual(["logs", "Foreground", "cas", "secret"]);
      expect((yield* f.actual.getRun(id)).log_tail).toBeNull();
    }),
  ),
);
it.effect(
  "an informer cannot reclassify a successful foreground delete while heartbeat SQL is pending",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.setCommit(Effect.fail(new DatabaseError({ operation: "transition" })));
        yield* f.heartbeat.iterate;
        const deleted: V1Job = {
          ...f.job,
          status: { conditions: [{ type: "Failed", status: "True" }] },
        };
        yield* f.controller.handle(id, { id, deletedJob: deleted });
        yield* TestClock.adjust("2 minutes");
        yield* f.controller.checkLost;
        expect((yield* f.actual.getRun(id)).state).toBe("running");
        f.setCommit(Effect.void);
        yield* f.heartbeat.iterate;
        expect((yield* f.actual.getRun(id)).failure_reason).toBe("heartbeat_timeout");
        expect(yield* count).toBe(1);
      }),
    ),
);
it.effect(
  "overlapping manual heartbeat passes cannot duplicate destructive work or publication",
  () =>
    test((f) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.setLog(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("owned tail"),
          ),
        );
        const first = yield* Effect.forkScoped(f.heartbeat.iterate);
        yield* Deferred.await(entered);
        const second = yield* Effect.forkScoped(f.heartbeat.iterate);
        yield* TestClock.adjust("0 millis");
        expect(f.operations()).toEqual(["logs"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(f.operations()).toEqual(["logs", "Foreground", "cas", "secret"]);
        expect(yield* count).toBe(1);
      }),
    ),
);

it.effect("a poisoned post-delete CAS is attempted at most once per pass", () =>
  test((f) =>
    Effect.gen(function* () {
      f.setCommit(Effect.fail(new DatabaseError({ operation: "transition" })));
      yield* f.heartbeat.iterate;
      yield* f.heartbeat.iterate;
      expect(f.operations()).toEqual(["logs", "Foreground", "cas", "cas"]);
      expect(yield* count).toBe(0);
    }),
  ),
);
