import { expect, it } from "@effect/vitest";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { leaderRunStore } from "@krun/shared/dist/runtime/run-metrics.js";
import { DatabaseError, Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { toRun } from "@krun/shared/dist/store/mappers.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { DateTime, Deferred, Effect, Fiber, Metric, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeJobController } from "./job-controller.js";
import { JobPodSource } from "./k8s/informers.js";
import { Kube } from "./k8s/kube.js";

const id = "0192f000-0000-7000-8000-000000000048";
const namespace = "krun-test-p48-failure";
const fn = "p48-echo";
const boundaries = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];
const failed = (reason: string) =>
  Metric.value(
    Metric.withAttributes(Metric.counter("krun_runs_failed_total", { incremental: true }), {
      function: fn,
      reason,
    }),
  ).pipe(Effect.map((value) => value.count));
const detected = Metric.value(
  Metric.withAttributes(Metric.histogram("krun_terminal_detect_seconds", { boundaries }), {
    function: fn,
  }),
);
const fixture = (options: { scheduled?: boolean; token?: boolean } = {}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.migrate();
    yield* store.createRun({
      id,
      function_name: fn,
      input: {},
      idempotency_key: null,
      request_hash: "a".repeat(64),
      priority: 0,
      created_by: "krun-test-p48",
      created_at: yield* DateTime.now,
      callback_url: "https://receiver.example.invalid/terminal",
    });
    if (options.token !== false) yield* store.setJobToken(id, `krun-${id}`, "owned-test-hash");
    if (options.scheduled !== false) yield* store.markScheduled(id);
    const jobs = new Map<string, V1Job>();
    const pods = new Map<string, V1Pod>();
    const calls: string[] = [];
    let log: Effect.Effect<string, KubeApiError> = Effect.succeed("krun-test-p48-private-tail");
    let beforeCas: Effect.Effect<void, DatabaseError> = Effect.void;
    const kube: Kube["Service"] = {
      createJob: () => Effect.succeed({}),
      createSecret: () => Effect.succeed({}),
      readSecret: () => Effect.succeed({}),
      deleteSecret: () => Effect.sync(() => void calls.push("secret")),
      deleteJob: (_target, propagation) => Effect.sync(() => void calls.push(propagation)),
      readPodLog: (target) =>
        Effect.suspend(() => {
          calls.push("logs");
          expect(target).toMatchObject({ namespace, name: "krun-test-p48-pod", runId: id });
          return log;
        }),
    };
    const controlled: Store["Service"] = {
      ...store,
      transition: (...args) =>
        Effect.sync(() => void calls.push("cas")).pipe(
          Effect.andThen(beforeCas),
          Effect.andThen(store.transition(...args)),
        ),
    };
    const source: JobPodSource["Service"] = {
      jobs: { list: () => [...jobs.values()], get: (name) => jobs.get(name) },
      pods: { list: () => [...pods.values()], get: (name) => pods.get(name) },
      jobEvents: Stream.empty,
      podEvents: Stream.empty,
      ready: Effect.void,
      hasPendingJob: () => false,
      acknowledgeJob: () => {},
    };
    const controller = yield* makeJobController({
      namespace,
      maxRunning: 8,
      checkResult: () => Effect.succeed(null),
    }).pipe(
      Effect.provideService(Store, controlled),
      Effect.provideService(Kube, kube),
      Effect.provideService(JobPodSource, source),
    );
    const job = (reason?: string, complete = false) =>
      jobs.set(`krun-${id}`, {
        metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
        status: {
          conditions: complete
            ? [{ type: "Complete", status: "True" }]
            : reason === undefined
              ? []
              : [{ type: "Failed", status: "True", reason, message: "Owned Kubernetes failure" }],
        },
      });
    const pod = (
      options: {
        exit?: number;
        oom?: boolean;
        evicted?: boolean;
        disrupted?: boolean;
        deleting?: boolean;
        finished?: number;
      } = {},
    ) => {
      const value: V1Pod = {
        metadata: {
          name: "krun-test-p48-pod",
          namespace,
          labels: { "krun.io/run-id": id },
          ...(options.deleting
            ? { deletionTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)) }
            : {}),
        },
        status: {
          phase: options.exit === undefined ? "Running" : "Failed",
          ...(options.evicted ? { reason: "Evicted", message: "Owned eviction" } : {}),
          conditions: options.disrupted
            ? [{ type: "DisruptionTarget", status: "True", reason: "PreemptionByScheduler" }]
            : [],
          containerStatuses: [
            {
              name: "function",
              ready: false,
              restartCount: 0,
              image: "owned",
              imageID: "owned",
              state:
                options.exit === undefined
                  ? { running: {} }
                  : {
                      terminated: {
                        exitCode: options.exit,
                        reason: options.oom
                          ? "OOMKilled"
                          : options.exit === 0
                            ? "Completed"
                            : "Error",
                        message: "Owned container termination",
                        startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
                        finishedAt: DateTime.toDateUtc(DateTime.makeUnsafe(options.finished ?? 0)),
                      },
                    },
            },
          ],
        },
      };
      pods.set("krun-test-p48-pod", value);
      return value;
    };
    return {
      store,
      controller,
      calls,
      jobs,
      pods,
      job,
      pod,
      setLog: (value: typeof log) => {
        log = value;
      },
      setBeforeCas: (value: typeof beforeCas) => {
        beforeCas = value;
      },
    };
  });
const test = <R>(
  body: (f: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<void, unknown, R>,
  options: { scheduled?: boolean; token?: boolean } = {},
) =>
  fixture(options).pipe(
    Effect.flatMap(body),
    Effect.provide(StoreSqlite(":memory:")),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );

it.effect(
  "captures exit3 before JobFailed; commits separate tail and function error with one metric sample",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.job();
        f.pod({ exit: 3 });
        yield* f.store.setError(id, {
          source: "function",
          message: "Owned report",
          details: { private: "krun-test-p48-private-error" },
        });
        yield* f.controller.handle(id);
        expect(f.calls).toEqual(["logs"]);
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        yield* TestClock.adjust("2 seconds");
        f.job("BackoffLimitExceeded");
        yield* f.controller.handle(id);
        const row = yield* f.store.getRun(id);
        expect(row).toMatchObject({
          state: "failed",
          failure_reason: "exit_code",
          log_tail: "krun-test-p48-private-tail",
          error: { source: "function", message: "Owned report" },
          job_status: { exitCode: 3 },
        });
        expect(f.calls).toEqual(["logs", "cas", "secret", "Background"]);
        expect(yield* failed("exit_code")).toBe(1);
        expect(yield* detected).toMatchObject({ count: 1, sum: 2 });
        const [delivery] = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
        expect(delivery?.payload).not.toHaveProperty("logTail");
        yield* f.controller.handle(id);
        expect(yield* failed("exit_code")).toBe(1);
        expect(yield* detected).toMatchObject({ count: 1, sum: 2 });
      }),
    ),
);

for (const [name, options, jobReason, reason] of [
  [
    "oom beats every competing signal",
    { exit: 137, oom: true, evicted: true, disrupted: true },
    "DeadlineExceeded",
    "oom_killed",
  ],
  [
    "deadline beats eviction/disruption/exit",
    { exit: 143, evicted: true, disrupted: true },
    "DeadlineExceeded",
    "deadline_exceeded",
  ],
  [
    "eviction beats disruption/exit",
    { exit: 3, evicted: true, disrupted: true },
    "BackoffLimitExceeded",
    "evicted",
  ],
  ["disruption beats exit", { exit: 3, disrupted: true }, "BackoffLimitExceeded", "disrupted"],
  ["plain nonzero exit", { exit: 3 }, "BackoffLimitExceeded", "exit_code"],
] as const) {
  it.effect(name, () =>
    test((f) =>
      Effect.gen(function* () {
        f.job(jobReason);
        f.pod(options);
        yield* f.controller.handle(id);
        expect((yield* f.store.getRun(id)).failure_reason).toBe(reason);
        expect(yield* failed(reason)).toBe(1);
        expect(yield* detected).toMatchObject({ count: 1 });
        expect(f.calls).toEqual(["logs", "cas", "secret", "Background"]);
      }),
    ),
  );
}

it.effect(
  "fallback fetches at terminal detection; absent pod retains Kubernetes reason without invented exit latency",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.job("NodeLost");
        yield* f.controller.handle(id);
        expect(yield* f.store.getRun(id)).toMatchObject({
          state: "failed",
          failure_reason: "disrupted",
          log_tail: null,
          error: { source: "kubernetes", type: "NodeLost", message: "Owned Kubernetes failure" },
        });
        expect(f.calls).toEqual(["cas", "secret", "Background"]);
        expect(yield* failed("disrupted")).toBe(1);
        expect(yield* detected).toMatchObject({ count: 0 });
      }),
    ),
);

it.effect("terminal fallback fetches once when the first pod observation has no exit", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job("NodeLost");
      f.pod();
      yield* f.controller.handle(id);
      expect(f.calls).toEqual(["logs", "cas", "secret", "Background"]);
      expect((yield* f.store.getRun(id)).log_tail).toBe("krun-test-p48-private-tail");
    }),
  ),
);

for (const complete of [true, false]) {
  it.effect(`exit0 never fetches logs even when JobComplete=${complete}`, () =>
    test((f) =>
      Effect.gen(function* () {
        f.job(complete ? undefined : "DeadlineExceeded", complete);
        f.pod({ exit: 0 });
        yield* f.controller.handle(id);
        expect(f.calls).not.toContain("logs");
        expect((yield* f.store.getRun(id)).log_tail).toBeNull();
        expect(yield* detected).toMatchObject({ count: 1 });
      }),
    ),
  );
}

it.effect("deletionTimestamp captures early without an exit; replay does not fetch again", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job();
      f.pod({ deleting: true });
      yield* f.controller.handle(id);
      yield* f.controller.handle(id);
      expect(f.calls).toEqual(["logs", "cas"]);
      expect((yield* f.store.getRun(id)).state).toBe("running");
    }),
  ),
);

for (const status of [404, 503]) {
  it.effect(`pods/log ${status} leaves null and does not starve terminal persistence`, () =>
    test((f) =>
      Effect.gen(function* () {
        f.job("BackoffLimitExceeded");
        f.pod({ exit: 3 });
        f.setLog(
          Effect.fail(new KubeApiError({ operation: "request", reason: "request_failed", status })),
        );
        yield* f.controller.handle(id);
        expect(yield* f.store.getRun(id)).toMatchObject({ state: "failed", log_tail: null });
        expect(yield* failed("exit_code")).toBe(1);
        expect(f.calls).toEqual(["logs", "cas", "secret", "Background"]);
      }),
    ),
  );
}

it.effect(
  "hanging log adapter is interrupted at ten seconds, leaves null and continues the terminal path",
  () =>
    test((f) =>
      Effect.gen(function* () {
        f.job("BackoffLimitExceeded");
        f.pod({ exit: 3 });
        const started = yield* Deferred.make<void>();
        let interrupted = false;
        f.setLog(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );
        const fiber = yield* Effect.forkScoped(f.controller.handle(id));
        yield* Deferred.await(started);
        yield* TestClock.adjust("9999 millis");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        expect(fiber.pollUnsafe()).toBeDefined();
        yield* Fiber.join(fiber);
        expect(interrupted).toBe(true);
        expect(yield* f.store.getRun(id)).toMatchObject({ state: "failed", log_tail: null });
        expect(yield* detected).toMatchObject({ count: 1, sum: 10 });
      }),
    ),
);

it.effect("a UTF8 cap cannot introduce replacement bytes beyond the 16KiB log-tail budget", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job("BackoffLimitExceeded");
      f.pod({ exit: 3 });
      f.setLog(Effect.succeed(`${"x".repeat(16383)}💥`));
      yield* f.controller.handle(id);
      const tail = (yield* f.store.getRun(id)).log_tail;
      expect(tail).toBe("x".repeat(16383));
      expect(Buffer.byteLength(tail ?? "")).toBeLessThanOrEqual(16384);
    }),
  ),
);

it.effect("a lost Job preserves its earlier captured tail and records the known exit latency", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job();
      f.pod({ exit: 3 });
      yield* f.controller.handle(id);
      f.jobs.clear();
      f.pods.clear();
      yield* f.controller.checkLost;
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      expect(yield* f.store.getRun(id)).toMatchObject({
        state: "failed",
        failure_reason: "job_lost",
        log_tail: "krun-test-p48-private-tail",
      });
      expect(yield* failed("job_lost")).toBe(1);
      expect(yield* detected).toMatchObject({ count: 1, sum: 120 });
    }),
  ),
);

it.effect("cancellation/stale CAS emits no failure or terminal-exit sample", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job("BackoffLimitExceeded");
      f.pod({ exit: 3 });
      f.setBeforeCas(
        f.store.transition(id, "scheduled", "cancelling", null, {}).pipe(Effect.asVoid),
      );
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).state).toBe("cancelling");
      expect(yield* failed("exit_code")).toBe(0);
      expect(yield* detected).toMatchObject({ count: 0 });
      expect(f.calls).toEqual(["logs", "cas"]);
    }),
  ),
);

it.effect("only committed leader provisioning failures count; stale CAS has no reason sample", () =>
  test((f) =>
    Effect.gen(function* () {
      const leader = leaderRunStore(f.store);
      expect(yield* leader.transition(id, "scheduled", "failed", "job_create_failed", {})).toBe(
        true,
      );
      expect(yield* leader.transition(id, "scheduled", "failed", "exit_code", {})).toBe(false);
      expect(yield* failed("job_create_failed")).toBe(1);
      expect(yield* failed("exit_code")).toBe(0);
      expect(yield* detected).toMatchObject({ count: 0 });
    }),
  ),
);

it.effect("UTF8 log capture preserves a leading BOM as data", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job("BackoffLimitExceeded");
      f.pod({ exit: 3 });
      f.setLog(Effect.succeed("\uFEFFkrun-test-p48-bom"));
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).log_tail).toBe("\uFEFFkrun-test-p48-bom");
    }),
  ),
);

it.effect("repair: an early deletion capture is never persisted or FULL exposed on success", () =>
  test((f) =>
    Effect.gen(function* () {
      f.job();
      f.pod({ deleting: true });
      yield* f.controller.handle(id);
      expect(f.calls.filter((call) => call === "logs")).toHaveLength(1);
      f.pod({ exit: 0, deleting: true });
      f.job(undefined, true);
      yield* f.controller.handle(id);
      const row = yield* f.store.getRun(id);
      expect(row.state).toBe("succeeded");
      expect(row.log_tail).toBeNull();
      expect(toRun(row)).not.toHaveProperty("logTail");
      expect(yield* failed("exit_code")).toBe(0);
      expect(yield* detected).toMatchObject({ count: 1 });
      expect(f.calls.filter((call) => call === "logs")).toHaveLength(1);
    }),
  ),
);

it.effect(
  "repair: queued token-bearing Pod failure survives eviction without queued lifecycle writes",
  () =>
    test(
      (f) =>
        Effect.gen(function* () {
          f.job();
          f.pod({ exit: 3 });
          yield* f.store.setError(id, { source: "function", message: "Owned queued report" });
          yield* f.controller.handle(id);
          expect(f.calls).toEqual(["logs"]);
          expect(yield* f.store.getRun(id)).toMatchObject({
            state: "queued",
            job_status: null,
            started_at: null,
          });
          expect(yield* detected).toMatchObject({ count: 0 });
          f.pods.clear();
          yield* f.controller.handle(id);
          yield* TestClock.adjust("2 seconds");
          expect(yield* f.store.markScheduled(id)).toBe(true);
          f.job("BackoffLimitExceeded");
          yield* f.controller.handle(id);
          expect(yield* f.store.getRun(id)).toMatchObject({
            state: "failed",
            failure_reason: "disrupted",
            log_tail: "krun-test-p48-private-tail",
            error: { source: "function" },
          });
          expect(yield* detected).toMatchObject({ count: 1, sum: 2 });
          expect(f.calls).toEqual(["logs", "cas", "secret", "Background"]);
        }),
      { scheduled: false },
    ),
);

for (const token of [false, true]) {
  it.effect(`repair: queued diagnostics skip ${token ? "exit zero" : "a tokenless run"}`, () =>
    test(
      (f) =>
        Effect.gen(function* () {
          f.job();
          f.pod({ exit: token ? 0 : 3 });
          yield* f.controller.handle(id);
          expect(f.calls).toEqual([]);
          expect(yield* f.store.getRun(id)).toMatchObject({
            state: "queued",
            job_status: null,
            log_tail: null,
          });
          expect(yield* detected).toMatchObject({ count: 0 });
        }),
      { scheduled: false, token },
    ),
  );
}
