import { expect, it } from "@effect/vitest";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { DatabaseError, type NewRun, Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Logger,
  Queue,
  References,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { makeJobController, ResultCheckError } from "./job-controller.js";
import { type InformerEvent, JobPodSource } from "./k8s/informers.js";
import { Kube } from "./k8s/kube.js";

const id = "0192f000-0000-7000-8000-000000000001";
const namespace = "krun-test-p44-jobs";
const fixture = Effect.gen(function* () {
  const store = yield* Store;
  yield* store.migrate();
  const jobs = new Map<string, V1Job>();
  const pods = new Map<string, V1Pod>();
  const jobEvents = yield* Queue.unbounded<InformerEvent>();
  const podEvents = yield* Queue.unbounded<InformerEvent>();
  const synced = yield* Deferred.make<void>();
  const calls: string[] = [];
  let resultError = false;
  let reference: string | null = null;
  let cleanupError = false;
  let beforeCleanup: (id: string) => Effect.Effect<void> = () => Effect.void;
  const cleanupIds: string[] = [];
  let jobDeleteError = false;
  let readError = false;
  let beforeRead: (id: string) => Effect.Effect<void> = () => Effect.void;
  let logError = false;
  let beforeResult: Effect.Effect<void> = Effect.void;
  let beforeCas: Effect.Effect<void, DatabaseError> = Effect.void;
  let activeChecks = 0;
  let maxChecks = 0;
  let observation = 0;
  const pendingJobs = new Map<string, number>();
  let afterAck: (event: InformerEvent) => void = () => {};
  yield* Effect.addFinalizer(() => Effect.sync(() => pendingJobs.clear()));
  const ingest = (event: InformerEvent): InformerEvent => {
    const next = { ...event, jobObservation: ++observation };
    pendingJobs.set(event.id, next.jobObservation);
    return next;
  };
  const source: JobPodSource["Service"] = {
    jobs: { list: () => [...jobs.values()], get: (name) => jobs.get(name) },
    pods: { list: () => [...pods.values()], get: (name) => pods.get(name) },
    jobEvents: Stream.fromQueue(jobEvents),
    podEvents: Stream.fromQueue(podEvents),
    ready: Deferred.await(synced),
    hasPendingJob: (runId: string) => pendingJobs.has(runId),
    acknowledgeJob: (event: InformerEvent) => {
      if (
        event.jobObservation !== undefined &&
        pendingJobs.get(event.id) === event.jobObservation
      ) {
        pendingJobs.delete(event.id);
        afterAck(event);
      }
    },
  };
  const kube: Kube["Service"] = {
    createJob: () => Effect.succeed({}),
    deleteJob: (_target, foreground) =>
      Effect.gen(function* () {
        calls.push(`job:${foreground === "Foreground"}`);
        if (jobDeleteError)
          return yield* Effect.fail(
            new KubeApiError({ operation: "request", reason: "request_failed", status: 503 }),
          );
      }),
    createSecret: () => Effect.succeed({}),
    readSecret: () => Effect.succeed({}),
    deleteSecret: (target) =>
      Effect.gen(function* () {
        calls.push("secret");
        cleanupIds.push(target.runId ?? "");
        yield* beforeCleanup(target.runId ?? "");
        if (cleanupError)
          return yield* Effect.fail(
            new KubeApiError({ operation: "request", reason: "request_failed", status: 503 }),
          );
      }),
    readPodLog: () =>
      Effect.gen(function* () {
        calls.push("logs");
        if (logError)
          return yield* Effect.fail(new KubeApiError({ operation: "request", reason: "timeout" }));
        return "owned failure tail";
      }),
  };
  const controlled: Store["Service"] = {
    ...store,
    getRun: (runId) =>
      Effect.suspend(() =>
        beforeRead(runId).pipe(
          Effect.andThen(
            readError
              ? Effect.fail(new DatabaseError({ operation: "getRun" }))
              : store.getRun(runId),
          ),
        ),
      ),
    setJobStatus: (...args) =>
      store.setJobStatus(...args).pipe(Effect.tap(() => Effect.sync(() => calls.push("status")))),
    transition: (...args) =>
      Effect.gen(function* () {
        if (args[2] === "succeeded" || args[2] === "failed") {
          calls.push("cas");
          yield* beforeCas;
        }
        return yield* store.transition(...args);
      }),
  };
  const buildController = makeJobController({
    namespace,
    maxRunning: 3,
    checkResult: () =>
      Effect.gen(function* () {
        calls.push("result");
        activeChecks++;
        maxChecks = Math.max(maxChecks, activeChecks);
        yield* beforeResult;
        activeChecks--;
        if (resultError)
          return yield* Effect.fail(new ResultCheckError({ reason: "request_failed" }));
        return reference;
      }),
  }).pipe(
    Effect.provideService(Store, controlled),
    Effect.provideService(Kube, kube),
    Effect.provideService(JobPodSource, source),
  );
  const controller = yield* buildController;
  const seed = (state: "queued" | "scheduled" | "running" | "cancelling" = "scheduled") =>
    Effect.gen(function* () {
      const run: NewRun = {
        id,
        function_name: "echo",
        input: {},
        idempotency_key: null,
        request_hash: "owned-test-hash",
        priority: 0,
        created_by: "krun-test-p44",
        created_at: yield* DateTime.now,
        callback_url: "https://receiver.example.invalid/terminal",
      };
      yield* store.createRun(run);
      yield* store.setJobToken(id, `krun-${id}`, "owned-test-hash");
      if (state !== "queued") yield* store.markScheduled(id);
      if (state === "running") yield* store.transition(id, "scheduled", "running", null, {});
      if (state === "cancelling") yield* store.transition(id, "scheduled", "cancelling", null, {});
    });
  const putJob = (complete = true) =>
    jobs.set(`krun-${id}`, {
      metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
      status: complete ? { conditions: [{ type: "Complete", status: "True" }] } : {},
    });
  const putPod = (status: NonNullable<V1Pod["status"]>) =>
    pods.set("owned-pod", {
      metadata: { name: "owned-pod", namespace, labels: { "krun.io/run-id": id } },
      status,
    });
  return {
    store,
    controller,
    source,
    ingest,
    setAfterAck: (value: typeof afterAck) => {
      afterAck = value;
    },
    buildController,
    cleanupIds,
    setBeforeCleanup: (value: typeof beforeCleanup) => {
      beforeCleanup = value;
    },
    calls,
    jobs,
    pods,
    jobEvents,
    podEvents,
    seed,
    putJob,
    putPod,
    sync: Deferred.succeed(synced, undefined),
    setResultError: (v: boolean) => {
      resultError = v;
    },
    setReference: (v: string | null) => {
      reference = v;
    },
    setCleanupError: (v: boolean) => {
      cleanupError = v;
    },
    setJobDeleteError: (value: boolean) => {
      jobDeleteError = value;
    },
    setBeforeRead: (value: typeof beforeRead) => {
      beforeRead = value;
    },
    setReadError: (value: boolean) => {
      readError = value;
    },
    setLogError: () => {
      logError = true;
    },
    setBeforeResult: (v: Effect.Effect<void>) => {
      beforeResult = v;
    },
    setBeforeCas: (v: Effect.Effect<void, DatabaseError>) => {
      beforeCas = v;
    },
    maxChecks: () => maxChecks,
  };
});
const test = <R>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, unknown, R>) =>
  fixture.pipe(Effect.flatMap(body), Effect.provide(StoreSqlite(":memory:")));

it.effect("gates handlers on both processed LISTs and reconciles the initial cache", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      const fiber = yield* Effect.forkScoped(f.controller.handle(id));
      yield* Effect.yieldNow;
      expect((yield* f.store.getRun(id)).state).toBe("scheduled");
      yield* f.sync;
      yield* Fiber.join(fiber);
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      expect(f.calls).toEqual(["status", "result", "cas", "secret", "job:false"]);
    }),
  ),
);

it.effect("replays JobComplete cached while queued immediately after markScheduled", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("queued");
      f.putJob();
      yield* f.sync;
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).state).toBe("queued");
      yield* f.store.markScheduled(id);
      yield* f.controller.replayCached(yield* f.store.getRun(id));
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
    }),
  ),
);

it.effect("patches container timestamps on the direct scheduled terminal CAS", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      f.putPod({
        containerStatuses: [
          {
            name: "function",
            ready: false,
            restartCount: 0,
            image: "owned",
            imageID: "owned",
            state: {
              terminated: {
                exitCode: 0,
                startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-26T01:00:00Z")),
                finishedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-26T01:00:02Z")),
              },
            },
          },
        ],
      });
      yield* f.sync;
      yield* f.controller.handle(id);
      const run = yield* f.store.getRun(id);
      expect(run.started_at === null ? null : DateTime.formatIso(run.started_at)).toBe(
        "2026-10-26T01:00:00.000Z",
      );
      expect(run.finished_at).not.toBeNull();
      expect(f.calls).not.toContain("logs");
    }),
  ),
);

it.effect(
  "retries result-check failures without deletion, then writes resultUri in the callback transaction",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        f.putJob();
        yield* f.sync;
        f.setResultError(true);
        yield* Effect.flip(f.controller.handle(id));
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        expect(f.calls).not.toContain("secret");
        f.setResultError(false);
        f.setReference(`s3://krun-test-p44/runs/${id}/result.json`);
        yield* f.controller.handle(id);
        expect((yield* f.store.getRun(id)).result_ref).toContain("s3://krun-test-p44/");
        const [delivery] = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
        expect(delivery?.payload.resultUri).toContain("s3://krun-test-p44/");
      }),
    ),
);

it.effect("a racing inline result wins over the checked object reference", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setReference(`s3://krun-test-p44/runs/${id}/result.json`);
      f.setBeforeCas(f.store.setResult(id, { winner: "inline" }).pipe(Effect.asVoid));
      yield* f.controller.handle(id);
      const run = yield* f.store.getRun(id);
      expect(run.result).toEqual({ winner: "inline" });
      expect(run.result_ref).toBeNull();
    }),
  ),
);

it.effect("skips object HEAD for an accepted inline result", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.store.setResult(id, { value: 1 });
      f.putJob();
      yield* f.sync;
      yield* f.controller.handle(id);
      expect(f.calls).not.toContain("result");
    }),
  ),
);

it.effect("cancellation wins the CAS without deletion or duplicate terminal side effects", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setBeforeCas(
        f.store.transition(id, "scheduled", "cancelling", null, {}).pipe(Effect.asVoid),
      );
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).state).toBe("cancelling");
      expect(f.calls).not.toContain("secret");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(0);
    }),
  ),
);

it.effect("retries terminal cleanup without retransitioning or duplicating deliveries", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setCleanupError(true);
      yield* Effect.flip(f.controller.handle(id));
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      f.setCleanupError(false);
      yield* f.controller.reconcile;
      expect(f.calls.filter((x) => x === "cas")).toHaveLength(1);
      expect(f.calls.at(-1)).toBe("job:false");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect("isolates per-Job reconciliation failures and handles orphan Jobs", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      f.jobs.set("krun-orphan", {
        metadata: {
          name: "krun-orphan",
          namespace,
          labels: { "krun.io/run-id": "0192f000-0000-7000-8000-000000000002" },
        },
      });
      f.setResultError(true);
      yield* f.sync;
      yield* f.controller.reconcile;
      expect((yield* f.store.getRun(id)).state).toBe("scheduled");
      expect(f.calls).toContain("secret");
      expect(f.calls).toContain("job:false");
    }),
  ),
);

it.effect("serializes overlapping Job, Pod, replay and reconciliation handlers per run", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setBeforeResult(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const one = yield* Effect.forkScoped(f.controller.handle(id));
      yield* Deferred.await(entered);
      const two = yield* Effect.forkScoped(f.controller.handle(id));
      yield* f.controller.reconcile;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(one);
      yield* Fiber.join(two);
      expect(f.maxChecks()).toBe(1);
      expect(f.calls.filter((x) => x === "cas")).toHaveLength(1);
    }),
  ),
);

it.effect("processes live Pod running observations and runs five-minute cache reconciliation", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob(false);
      f.putPod({
        phase: "Running",
        containerStatuses: [
          {
            name: "function",
            ready: true,
            restartCount: 0,
            image: "owned",
            imageID: "owned",
            state: { running: {} },
          },
        ],
      });
      yield* f.sync;
      yield* Effect.forkScoped(f.controller.run);
      yield* Queue.offer(f.podEvents, { id });
      yield* TestClock.adjust("1 second");
      expect((yield* f.store.getRun(id)).state).toBe("running");
      f.putJob();
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
    }),
  ),
);

it.effect("captures one failed-container tail, and a log timeout never blocks finalization", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob(false);
      f.putPod({
        containerStatuses: [
          {
            name: "function",
            ready: false,
            restartCount: 0,
            image: "owned",
            imageID: "owned",
            state: { terminated: { exitCode: 1, reason: "Error" } },
          },
        ],
      });
      yield* f.sync;
      f.setLogError();
      yield* f.controller.handle(id);
      yield* f.controller.handle(id);
      const job = f.jobs.get(`krun-${id}`);
      if (job === undefined) throw new Error("Expected owned test Job");
      job.status = {
        conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
      };
      yield* f.controller.handle(id);
      const run = yield* f.store.getRun(id);
      expect(run.state).toBe("failed");
      expect(run.failure_reason).toBe("exit_code");
      expect(run.log_tail).toBeNull();
      expect(f.calls.filter((x) => x === "logs")).toHaveLength(1);
    }),
  ),
);

it.effect(
  "ImagePullBackOff stays scheduled; reconcile ignores observedAt-only changes but persists a changed reason",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        f.putJob(false);
        const waiting = (reason: string) => ({
          phase: "Pending",
          containerStatuses: [
            {
              name: "function",
              image: "owned",
              imageID: "owned",
              ready: false,
              restartCount: 0,
              state: { waiting: { reason, message: "owned image condition" } },
            },
          ],
        });
        f.putPod(waiting("ImagePullBackOff"));
        yield* f.sync;
        yield* f.controller.handle(id);
        expect((yield* f.store.getRun(id)).job_status?.reason).toBe("ImagePullBackOff");
        const first = f.calls.length;
        yield* TestClock.adjust("5 minutes");
        yield* f.controller.reconcile;
        expect(f.calls).toHaveLength(first);
        f.putPod(waiting("ErrImagePull"));
        yield* f.controller.reconcile;
        expect(f.calls.filter((x) => x === "status")).toHaveLength(2);
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        expect(f.calls).not.toContain("result");
        expect(f.calls).not.toContain("logs");
      }),
    ),
);

it.effect(
  "a Complete carried by a deleted Job event is not lost when the native cache removes it",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        f.putJob(false);
        yield* f.sync;
        yield* Effect.forkScoped(f.controller.run);
        yield* TestClock.adjust("1 second");
        f.jobs.clear();
        yield* Queue.offer(f.jobEvents, {
          id,
          deletedJob: {
            metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
            status: { conditions: [{ type: "Complete", status: "True" }] },
          },
        });
        yield* TestClock.adjust("1 second");
        expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      }),
    ),
);

it.effect("a terminal replay and a terminal CAS winner receive deletes only", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setBeforeCas(
        f.store.transition(id, "scheduled", "succeeded", null, {}).pipe(Effect.asVoid),
      );
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      f.calls.length = 0;
      yield* f.controller.handle(id);
      expect(f.calls).toEqual(["secret", "job:false"]);
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect("a failed result check is retried by the five-minute reconciliation fiber", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setResultError(true);
      yield* Effect.forkScoped(f.controller.run);
      yield* TestClock.adjust("1 second");
      expect((yield* f.store.getRun(id)).state).toBe("scheduled");
      expect(f.calls).not.toContain("secret");
      f.setResultError(false);
      f.setReference(`s3://krun-test-p44/runs/${id}/result.json`);
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      expect(f.calls.slice(-4)).toEqual(["result", "cas", "secret", "job:false"]);
    }),
  ),
);

it.effect(
  "P44-C1: retained terminal work keeps container start and status after Pod eviction",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        yield* f.sync;
        f.putPod({
          phase: "Succeeded",
          containerStatuses: [
            {
              name: "function",
              image: "owned",
              imageID: "owned",
              ready: false,
              restartCount: 0,
              state: { terminated: { exitCode: 0, startedAt: jobStart } },
            },
          ],
        });
        f.setResultError(true);
        yield* Effect.flip(f.controller.handle(id, deletedComplete));
        f.pods.clear();
        f.setResultError(false);
        yield* f.controller.reconcile;
        const row = yield* f.store.getRun(id);
        expect(row.state).toBe("succeeded");
        expect(row.job_status?.podName).toBe("owned-pod");
        expect(row.started_at === null ? null : DateTime.formatIso(row.started_at)).toBe(
          "2026-10-26T01:02:03.000Z",
        );
      }),
    ),
);

for (const stage of ["secret", "job"] as const) {
  it.effect(
    `P44-C1: evicted terminal cleanup retries ${stage} without another CAS or callback`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          yield* f.seed();
          yield* f.sync;
          if (stage === "secret") f.setCleanupError(true);
          else f.setJobDeleteError(true);
          yield* Effect.flip(f.controller.handle(id, deletedComplete));
          expect((yield* f.store.getRun(id)).state).toBe("succeeded");
          f.setCleanupError(false);
          f.setJobDeleteError(false);
          yield* f.controller.reconcile;
          expect(f.calls.filter((call) => call === "cas")).toHaveLength(1);
          expect(f.calls.filter((call) => call === "result")).toHaveLength(1);
          expect(f.calls.at(-1)).toBe("job:false");
          expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
          const after = [...f.calls];
          yield* f.controller.reconcile;
          expect(f.calls).toEqual(after);
        }),
      ),
  );
}

it.effect("P44-C1: deletion is retained before a failed Store read", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      f.setReadError(true);
      const error = yield* Effect.flip(f.controller.handle(id, deletedComplete));
      expect(error._tag).toBe("DatabaseError");
      expect(f.calls).toEqual([]);
      f.setReadError(false);
      yield* f.controller.reconcile;
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
    }),
  ),
);

it.effect("P44-C1: the five-minute retry drains a sole evicted Job without any cached Pod", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      f.setResultError(true);
      yield* Effect.forkScoped(f.controller.run);
      yield* Queue.offer(f.jobEvents, deletedComplete);
      yield* TestClock.adjust("1 second");
      expect(f.jobs.size).toBe(0);
      expect(f.pods.size).toBe(0);
      expect((yield* f.store.getRun(id)).state).toBe("scheduled");
      f.setResultError(false);
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      expect(f.calls.filter((call) => call === "result")).toHaveLength(2);
    }),
  ),
);

it.effect(
  "P44-C1: duplicate deletion observations coalesce and resolved orphan debt is pruned",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        yield* f.sync;
        f.setResultError(true);
        for (let attempt = 0; attempt < 3; attempt++)
          yield* Effect.flip(f.controller.handle(id, deletedComplete));
        f.setResultError(false);
        yield* f.controller.reconcile;
        expect(f.calls.filter((call) => call === "result")).toHaveLength(4);
        expect(f.calls.filter((call) => call === "cas")).toHaveLength(1);
        const absent = "0192f000-0000-7000-8000-000000000002";
        yield* f.controller.handle(absent, {
          id: absent,
          deletedJob: {
            metadata: { name: `krun-${absent}` },
            status: { conditions: [{ type: "Complete", status: "True" }] },
          },
        });
        const after = [...f.calls];
        yield* f.controller.reconcile;
        expect(f.calls).toEqual(after);
      }),
    ),
);

it.effect(
  "P44-C1: a cancelling CAS winner disposes terminal debt without taking over cancellation",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        yield* f.sync;
        f.setBeforeCas(
          f.store.transition(id, "scheduled", "cancelling", null, {}).pipe(Effect.asVoid),
        );
        yield* f.controller.handle(id, deletedComplete);
        expect((yield* f.store.getRun(id)).state).toBe("cancelling");
        expect(f.calls).not.toContain("secret");
        expect(f.calls).not.toContain("job:false");
        const after = [...f.calls];
        yield* f.controller.reconcile;
        expect(f.calls).toEqual(after);
        expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(0);
      }),
    ),
);

it.effect("P44-C1: interrupted late terminal settlement retains ordered cleanup debt", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setBeforeCas(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          yield* f.store.transition(id, "scheduled", "succeeded", null, {});
        }).pipe(Effect.uninterruptible),
      );
      const handler = yield* Effect.forkScoped(f.controller.handle(id, deletedComplete));
      yield* Deferred.await(entered);
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(handler));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      expect(f.calls).not.toContain("secret");
      yield* f.controller.reconcile;
      expect(f.calls.slice(-2)).toEqual(["secret", "job:false"]);
      expect(f.calls.filter((call) => call === "cas")).toHaveLength(1);
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect("P44-C1: closing the leader scope forgets debt and never starts teardown replay", () =>
  Effect.gen(function* () {
    const leader = yield* Scope.make();
    const f = yield* fixture.pipe(Effect.provideService(Scope.Scope, leader));
    yield* f.seed("queued");
    yield* f.sync;
    f.putJob();
    yield* f.controller.handle(id, deletedComplete);
    yield* Scope.close(leader, Exit.void);
    yield* f.store.markScheduled(id);
    yield* f.controller.reconcile;
    expect((yield* f.store.getRun(id)).state).toBe("scheduled");
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(StoreSqlite(":memory:"))),
);

for (const terminated of [true, false]) {
  it.effect(
    `P44-C2: terminal time prefers ${terminated ? "terminated container" : "Job over stale running container"}`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          yield* f.seed();
          f.jobs.set(`krun-${id}`, {
            metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
            status: { startTime: jobStart, conditions: [{ type: "Complete", status: "True" }] },
          });
          const earlier = DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-26T00:01:00Z"));
          f.putPod({
            phase: "Running",
            containerStatuses: [
              {
                name: "function",
                image: "owned",
                imageID: "owned",
                ready: false,
                restartCount: 0,
                state: terminated
                  ? { terminated: { exitCode: 0, startedAt: earlier } }
                  : { running: { startedAt: earlier } },
              },
            ],
          });
          yield* f.sync;
          yield* f.controller.handle(id);
          const row = yield* f.store.getRun(id);
          expect(row.started_at === null ? null : DateTime.formatIso(row.started_at)).toBe(
            terminated ? "2026-10-26T00:01:00.000Z" : "2026-10-26T01:02:03.000Z",
          );
        }),
      ),
  );
}

it.effect("P44-C2: an existing running startTime is preserved", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      const before = (yield* f.store.getRun(id)).started_at;
      f.jobs.set(`krun-${id}`, {
        metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
        status: { startTime: jobStart, conditions: [{ type: "Complete", status: "True" }] },
      });
      yield* f.sync;
      yield* f.controller.handle(id);
      expect((yield* f.store.getRun(id)).started_at).toEqual(before);
    }),
  ),
);

for (const state of ["scheduled", "running"] as const) {
  it.effect(
    `P45: absent ${state} Job fails only at the two-minute grace, then deletes only Secret`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          yield* f.seed(state);
          yield* f.sync;
          yield* f.controller.checkLost;
          yield* TestClock.adjust("119 seconds");
          yield* f.controller.checkLost;
          expect((yield* f.store.getRun(id)).state).toBe(state);
          expect(f.calls).toEqual([]);
          yield* TestClock.adjust("1 second");
          yield* f.controller.checkLost;
          const row = yield* f.store.getRun(id);
          expect(row.state).toBe("failed");
          expect(row.failure_reason).toBe("job_lost");
          expect(row.error?.source).toBe("krun");
          expect(row.finished_at).not.toBeNull();
          expect(f.calls).toEqual(["cas", "secret"]);
          const deliveries = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0]?.payload.state).toBe("FAILED");
          yield* f.controller.checkLost;
          expect(f.calls).toEqual(["cas", "secret"]);
        }),
      ),
  );
}

it.effect("P45: a written result and function error survive lost-Job CAS and callback", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.store.setResult(id, { retained: true });
      yield* f.store.setError(id, {
        source: "function",
        message: "owned function report",
        type: "Owned",
      });
      yield* f.controller.checkLost;
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      const row = yield* f.store.getRun(id);
      expect(row.result).toEqual({ retained: true });
      expect(row.error?.source).toBe("function");
      expect(row.error?.message).toBe("owned function report");
      expect(row.failure_reason).toBe("job_lost");
      const [delivery] = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
      expect(delivery?.payload.error?.source).toBe("FUNCTION");
      expect(f.calls).toEqual(["cas", "secret"]);
    }),
  ),
);

it.effect("P45: Job reappearance clears first-absent time and restarts the full grace", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      yield* TestClock.adjust("1 minute");
      f.putJob(false);
      yield* f.controller.checkLost;
      f.jobs.clear();
      yield* f.controller.checkLost;
      yield* TestClock.adjust("119 seconds");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* TestClock.adjust("1 second");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);

it.effect("P45: no grace or action before both processed LISTs; time begins after sync", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      const before = yield* Effect.forkScoped(f.controller.checkLost);
      yield* TestClock.adjust("3 minutes");
      expect(f.calls).toEqual([]);
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* f.sync;
      yield* Fiber.join(before);
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("failed");
    }),
  ),
);

it.effect("P45: the initial/five-minute controller reconcile executes the same lost check", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* Effect.forkScoped(f.controller.run);
      yield* TestClock.adjust("1 second");
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);

it.effect("P45: known evicted terminal work is never reclassified as job_lost", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      yield* f.controller.checkLost;
      f.setResultError(true);
      yield* Effect.flip(f.controller.handle(id, deletedComplete));
      yield* TestClock.adjust("3 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("scheduled");
      f.setResultError(false);
      yield* f.controller.reconcile;
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
    }),
  ),
);

it.effect("P45: committed loss retains Secret cleanup debt across transient failure", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      yield* TestClock.adjust("2 minutes");
      f.setCleanupError(true);
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
      f.setCleanupError(false);
      yield* f.controller.checkLost;
      expect(f.calls).toEqual(["cas", "secret", "secret"]);
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
      yield* f.controller.checkLost;
      expect(f.calls).toEqual(["cas", "secret", "secret"]);
    }),
  ),
);

it.effect("P45: a cancelling CAS winner is not overwritten or cleaned by loss handling", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      yield* f.controller.checkLost;
      f.setBeforeCas(
        f.store.transition(id, "scheduled", "cancelling", null, {}).pipe(Effect.asVoid),
      );
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("cancelling");
      expect(f.calls).toEqual(["cas"]);
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(0);
    }),
  ),
);

it.effect("P45: each new leader starts a fresh first-absent grace, with no teardown work", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      const scope = yield* Scope.make();
      const first = yield* f.buildController.pipe(Effect.provideService(Scope.Scope, scope));
      yield* first.checkLost;
      yield* TestClock.adjust("1 minute");
      yield* Scope.close(scope, Exit.void);
      const second = yield* f.buildController;
      yield* second.checkLost;
      yield* TestClock.adjust("1 minute");
      yield* second.checkLost;
      yield* first.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      expect(f.calls).toEqual([]);
      yield* TestClock.adjust("1 minute");
      yield* second.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);

it.effect("P45: startup missing-Job count logs once only after sync", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      const events: { message: unknown; annotations: Readonly<Record<string, unknown>> }[] = [];
      const logger = Logger.make<unknown, void>((event) => {
        events.push({
          message: event.message,
          annotations: event.fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      const observed = f.controller.checkLost.pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      );
      const pending = yield* Effect.forkScoped(observed);
      yield* TestClock.adjust("1 second");
      expect(events).toHaveLength(0);
      yield* f.sync;
      yield* Fiber.join(pending);
      yield* observed;
      expect(events).toHaveLength(1);
      expect(events[0]?.message).toEqual(["Scheduler initial active runs without cached Jobs"]);
      expect(events[0]?.annotations).toEqual({ missingJobs: 1 });
    }),
  ),
);

it.effect("P45: late loss-CAS settlement records cleanup debt before pending interruption", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      yield* TestClock.adjust("2 minutes");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setBeforeCas(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const handler = yield* Effect.forkScoped(f.controller.checkLost);
      yield* Deferred.await(entered);
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(handler));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
      expect(f.calls).toEqual(["cas"]);
      f.setBeforeCas(Effect.void);
      yield* f.controller.checkLost;
      expect(f.calls).toEqual(["cas", "secret"]);
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

it.effect("P45: active result/error accepted during the loss CAS are not overwritten", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      yield* f.sync;
      yield* f.controller.checkLost;
      f.setBeforeCas(
        f.store
          .setResult(id, { concurrent: true })
          .pipe(
            Effect.andThen(
              f.store.setError(id, { source: "function", message: "late owned report" }),
            ),
            Effect.asVoid,
          ),
      );
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      const row = yield* f.store.getRun(id);
      expect(row.result).toEqual({ concurrent: true });
      expect(row.error?.message).toBe("late owned report");
      expect(row.error?.source).toBe("function");
    }),
  ),
);

it.effect(
  "P45: poisoned cleanup across iteration deadlines cannot starve another missing run",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed("running");
        yield* f.sync;
        const other = "0192f000-0000-7000-8000-000000000002";
        yield* f.store.createRun({
          id: other,
          function_name: "echo",
          input: {},
          idempotency_key: null,
          request_hash: "owned-second-hash",
          priority: 0,
          created_by: "krun-test-p45",
          created_at: yield* DateTime.now,
          callback_url: "https://receiver.example.invalid/terminal",
        });
        yield* f.store.setJobToken(other, `krun-${other}`, "owned-second-hash");
        yield* f.store.markScheduled(other);
        yield* f.controller.checkLost;
        yield* TestClock.adjust("2 minutes");
        f.setBeforeCleanup((runId) => (runId === id ? Effect.never : Effect.void));
        const first = yield* Effect.forkScoped(
          f.controller.checkLost.pipe(Effect.timeout("10 seconds")),
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.await(first);
        expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
        const second = yield* Effect.forkScoped(
          f.controller.checkLost.pipe(Effect.timeout("10 seconds")),
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.await(second);
        expect((yield* f.store.getRun(other)).failure_reason).toBe("job_lost");
        expect(f.cleanupIds).toContain(other);
        expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(2);
      }),
    ),
);

it.effect("P45: a queued Job-presence event resets grace even after cache eviction", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      yield* TestClock.adjust("119 seconds");
      // A real ADD/UPDATE can be queued before its following DELETE is consumed.
      yield* f.controller.handle(id, { id, jobSeen: true });
      yield* TestClock.adjust("1 second");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);

const jobStart = DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-26T01:02:03Z"));
for (const complete of [true, false]) {
  it.effect(
    `P44-C2: Job startTime fallback without a Pod for ${complete ? "Complete" : "Failed"}`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          yield* f.seed();
          f.jobs.set(`krun-${id}`, {
            metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
            status: {
              startTime: jobStart,
              conditions: [{ type: complete ? "Complete" : "Failed", status: "True" }],
            },
          });
          yield* f.sync;
          yield* f.controller.handle(id);
          const row = yield* f.store.getRun(id);
          expect(row.state).toBe(complete ? "succeeded" : "failed");
          expect(row.started_at === null ? null : DateTime.formatIso(row.started_at)).toBe(
            "2026-10-26T01:02:03.000Z",
          );
          const [delivery] = yield* f.store.claimDeliveries(yield* DateTime.now, 10);
          expect(delivery?.payload.startTime).toBe("2026-10-26T01:02:03.000Z");
        }),
      ),
  );
}

it.effect(
  "P44-C3: cancelling observations update only changed status, never lifecycle or resources",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed("cancelling");
        f.putJob(false);
        f.putPod({
          phase: "Pending",
          containerStatuses: [
            {
              name: "function",
              ready: false,
              restartCount: 0,
              image: "owned",
              imageID: "owned",
              state: { waiting: { reason: "ImagePullBackOff" } },
            },
          ],
        });
        yield* f.sync;
        yield* f.controller.handle(id);
        expect((yield* f.store.getRun(id)).job_status?.reason).toBe("ImagePullBackOff");
        expect(f.calls).toEqual(["status"]);
        yield* TestClock.adjust("5 minutes");
        yield* f.controller.reconcile;
        expect(f.calls).toEqual(["status"]);
        f.putPod({ phase: "Running" });
        yield* f.controller.handle(id);
        const row = yield* f.store.getRun(id);
        expect(row.state).toBe("cancelling");
        expect(row.job_status?.phase).toBe("Running");
        expect(row.started_at).toBeNull();
        expect(row.finished_at).toBeNull();
        expect(f.calls).toEqual(["status", "status"]);
        expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(0);
      }),
    ),
);

const deletedComplete: InformerEvent = {
  id,
  deletedJob: {
    metadata: { name: `krun-${id}`, namespace, labels: { "krun.io/run-id": id } },
    status: { conditions: [{ type: "Complete", status: "True" }] },
  },
};
it.effect("P44-C1: deleted Complete observed while queued survives markScheduled replay", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("queued");
      yield* f.sync;
      yield* Effect.forkScoped(f.controller.run);
      yield* Queue.offer(f.jobEvents, deletedComplete);
      yield* TestClock.adjust("1 second");
      expect((yield* f.store.getRun(id)).state).toBe("queued");
      yield* f.store.markScheduled(id);
      yield* f.controller.replayCached(yield* f.store.getRun(id));
      const row = yield* f.store.getRun(id);
      expect(row.state).toBe("succeeded");
    }),
  ),
);
it.effect(
  "P44-C1: deleted Complete survives fallible result check until cache reconciliation",
  () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.seed();
        f.putPod({
          phase: "Succeeded",
          containerStatuses: [
            {
              name: "function",
              ready: false,
              restartCount: 0,
              image: "owned",
              imageID: "owned",
              state: { terminated: { exitCode: 0 } },
            },
          ],
        });
        f.setResultError(true);
        yield* f.sync;
        yield* Effect.forkScoped(f.controller.run);
        yield* Queue.offer(f.jobEvents, deletedComplete);
        yield* TestClock.adjust("1 second");
        expect((yield* f.store.getRun(id)).state).toBe("scheduled");
        expect(f.calls.filter((c) => c === "result")).toHaveLength(1);
        f.setResultError(false);
        f.setReference("s3://krun-test-p44-review/result.json");
        yield* TestClock.adjust("5 minutes");
        const row = yield* f.store.getRun(id);
        expect(row.state).toBe("succeeded");
        expect(row.result_ref).toBe("s3://krun-test-p44-review/result.json");
      }),
    ),
);
it.effect("P44-C1: result retry with a retained cached Job remains successful", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed();
      f.putJob();
      yield* f.sync;
      f.setResultError(true);
      yield* Effect.flip(f.controller.handle(id));
      f.setResultError(false);
      yield* f.controller.reconcile;
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
      expect(yield* f.store.claimDeliveries(yield* DateTime.now, 10)).toHaveLength(1);
    }),
  ),
);

for (const complete of [false, true]) {
  it.effect(
    `P45-C1: pending ${complete ? "terminal" : "presence"} ingress survives a cross-run backlog beyond the grace`,
    () =>
      test((f) =>
        Effect.gen(function* () {
          const other = "0192f000-0000-7000-8000-000000000002";
          yield* f.seed("running");
          yield* f.sync;
          yield* f.store.createRun({
            id: other,
            function_name: "echo",
            input: {},
            idempotency_key: null,
            request_hash: "owned-p45-backlog",
            priority: 0,
            created_by: "krun-test-p45-repair",
            created_at: yield* DateTime.now,
            callback_url: "https://receiver.example.invalid/terminal",
          });
          yield* f.store.setJobToken(other, `krun-${other}`, "owned-p45-backlog");
          yield* f.store.markScheduled(other);
          yield* f.store.transition(other, "scheduled", "running", null, {});
          f.putJob();
          yield* f.controller.checkLost;
          yield* TestClock.adjust("119 seconds");
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          f.setBeforeResult(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
          yield* Queue.offer(f.jobEvents, f.ingest({ id, jobSeen: true }));
          const consumer = yield* Effect.forkScoped(f.controller.run);
          yield* Deferred.await(entered);
          const seen = f.ingest({ id: other, jobSeen: true });
          const gone = f.ingest({
            id: other,
            deletedJob: {
              metadata: { name: `krun-${other}`, namespace, labels: { "krun.io/run-id": other } },
              status: complete ? { conditions: [{ type: "Complete", status: "True" }] } : {},
            },
          });
          const drained = yield* Deferred.make<void>();
          f.setAfterAck((event) => {
            if (event === gone) Deferred.doneUnsafe(drained, Effect.void);
          });
          yield* Queue.offer(f.jobEvents, seen);
          yield* Queue.offer(f.jobEvents, gone);
          yield* TestClock.adjust("1 second");
          yield* f.controller.checkLost;
          expect((yield* f.store.getRun(other)).state).toBe("running");
          yield* TestClock.adjust("3 minutes");
          yield* f.controller.checkLost;
          expect((yield* f.store.getRun(other)).state).toBe("running");
          expect(f.source.hasPendingJob(other)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(drained);
          // ACK is inside the event's per-run gate; a bare replay joins its settlement.
          yield* f.controller.handle(other);
          expect(f.source.hasPendingJob(other)).toBe(false);
          yield* f.controller.checkLost;
          expect((yield* f.store.getRun(other)).state).toBe(complete ? "succeeded" : "running");
          yield* Fiber.interrupt(consumer);
          if (!complete) {
            yield* TestClock.adjust("119 seconds");
            yield* f.controller.checkLost;
            expect((yield* f.store.getRun(other)).state).toBe("running");
            yield* TestClock.adjust("1 second");
            yield* f.controller.checkLost;
            expect((yield* f.store.getRun(other)).failure_reason).toBe("job_lost");
          }
        }),
      ),
  );
}

it.effect("P45-C1: pending ingress for another run does not block a genuine loss", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      f.ingest({ id: "0192f000-0000-7000-8000-000000000002", jobSeen: true });
      yield* TestClock.adjust("2 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);

it.effect("P45-C1: terminal handoff stays retained after ingress ACK and failed Store read", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      const event = f.ingest(deletedComplete);
      f.setReadError(true);
      yield* Effect.flip(f.controller.handle(id, event));
      expect(f.source.hasPendingJob(id)).toBe(false);
      f.setReadError(false);
      yield* TestClock.adjust("3 minutes");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* f.controller.reconcile;
      expect((yield* f.store.getRun(id)).state).toBe("succeeded");
    }),
  ),
);

it.effect("P45-C1: ingress during the fresh Store read fences the old loss decision", () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.seed("running");
      yield* f.sync;
      yield* f.controller.checkLost;
      yield* TestClock.adjust("2 minutes");
      let received: InformerEvent | undefined;
      f.setBeforeRead(() =>
        Effect.sync(() => {
          received ??= f.ingest({ id, jobSeen: true });
        }),
      );
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      expect(f.calls).toEqual([]);
      f.setBeforeRead(() => Effect.void);
      if (received === undefined) throw new Error("Expected owned ingress during Store read");
      yield* f.controller.handle(id, received);
      yield* f.controller.checkLost;
      yield* TestClock.adjust("119 seconds");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).state).toBe("running");
      yield* TestClock.adjust("1 second");
      yield* f.controller.checkLost;
      expect((yield* f.store.getRun(id)).failure_reason).toBe("job_lost");
    }),
  ),
);
