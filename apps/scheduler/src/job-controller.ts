import type { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import type { DatabaseError, JobStatus, Run } from "@krun/shared/dist/store/index.js";
import { Store } from "@krun/shared/dist/store/index.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { Data, DateTime, Effect, Option, Schedule, Semaphore, Stream } from "effect";
import { type InformerEvent, JobPodSource, runIdOf } from "./k8s/informers.js";
import { Kube } from "./k8s/kube.js";

/** Required P6.2 boundary: return null only for a disabled store/absent object.
 * Transport/configuration failures must fail, never silently mean not-found.
 */
export class ResultCheckError extends Data.TaggedError("ResultCheckError")<{
  readonly reason: "request_failed";
}> {}
type HandlerError = DatabaseError | KubeApiError | ResultCheckError;
const terminal = (run: Run) =>
  run.state === "succeeded" || run.state === "failed" || run.state === "cancelled";
const container = (pod: V1Pod | undefined) =>
  pod?.status?.containerStatuses?.find((status) => status.name === "function");
const trueCondition = (job: V1Job | undefined, type: string) =>
  job?.status?.conditions?.find(
    (condition) => condition.type === type && condition.status === "True",
  );
const time = (value: Date | undefined) =>
  value === undefined ? undefined : Option.getOrUndefined(DateTime.make(value));
const sameStatus = (a: JobStatus | null, b: JobStatus) =>
  a !== null &&
  a.podName === b.podName &&
  a.phase === b.phase &&
  a.reason === b.reason &&
  a.message === b.message &&
  a.exitCode === b.exitCode;
const statusOf = (
  job: V1Job | undefined,
  pod: V1Pod | undefined,
  observedAt: DateTime.Utc,
): JobStatus => {
  const state = container(pod)?.state;
  const condition =
    pod?.status?.conditions?.find((c) => c.type === "DisruptionTarget" && c.status === "True") ??
    pod?.status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
  const jobCondition = trueCondition(job, "Failed") ?? trueCondition(job, "Complete");
  const reason =
    state?.terminated?.reason ??
    state?.waiting?.reason ??
    condition?.reason ??
    pod?.status?.reason ??
    jobCondition?.reason;
  const message =
    state?.terminated?.message ??
    state?.waiting?.message ??
    condition?.message ??
    pod?.status?.message ??
    jobCondition?.message;
  const name = pod?.metadata?.name;
  const phase = pod?.status?.phase;
  const exit = state?.terminated?.exitCode;
  return {
    observedAt,
    ...(name === undefined ? {} : { podName: name }),
    ...(phase === undefined ? {} : { phase }),
    ...(reason === undefined ? {} : { reason }),
    ...(message === undefined ? {} : { message }),
    ...(exit === undefined ? {} : { exitCode: exit }),
  };
};
const failure = (job: V1Job, pod: V1Pod | undefined): NonNullable<Run["failure_reason"]> => {
  const exited = container(pod)?.state?.terminated;
  if (exited?.reason === "OOMKilled") return "oom_killed";
  if (trueCondition(job, "Failed")?.reason === "DeadlineExceeded") return "deadline_exceeded";
  if (pod?.status?.reason === "Evicted") return "evicted";
  if (
    !exited ||
    pod?.status?.conditions?.some((c) => c.type === "DisruptionTarget" && c.status === "True")
  )
    return "disrupted";
  return "exit_code";
};

// Retained work is a compact observation, not a second historical informer cache.
const compactJob = (job: V1Job): V1Job => ({
  metadata: job.metadata?.name === undefined ? {} : { name: job.metadata.name },
  status: {
    conditions: [trueCondition(job, "Complete"), trueCondition(job, "Failed")]
      .filter((condition) => condition !== undefined)
      .map((condition) => ({ ...condition })),
    ...(job.status?.startTime === undefined ? {} : { startTime: job.status.startTime }),
  },
});
const compactPod = (pod: V1Pod | undefined): V1Pod | undefined => {
  if (pod === undefined) return undefined;
  const status = pod.status;
  const functionStatus = container(pod);
  return {
    metadata: {
      ...(pod.metadata?.name === undefined ? {} : { name: pod.metadata.name }),
      ...(pod.metadata?.deletionTimestamp === undefined
        ? {}
        : { deletionTimestamp: pod.metadata.deletionTimestamp }),
    },
    status: {
      ...(status?.phase === undefined ? {} : { phase: status.phase }),
      ...(status?.reason === undefined ? {} : { reason: status.reason }),
      ...(status?.message === undefined ? {} : { message: status.message }),
      conditions: [
        status?.conditions?.find(
          (condition) => condition.type === "DisruptionTarget" && condition.status === "True",
        ),
        status?.conditions?.find(
          (condition) => condition.type === "PodScheduled" && condition.status === "False",
        ),
      ]
        .filter((condition) => condition !== undefined)
        .map((condition) => ({ ...condition })),
      containerStatuses: functionStatus === undefined ? [] : [{ ...functionStatus }],
    },
  };
};

export const makeJobController = (options: {
  readonly namespace: string;
  readonly checkResult: (run: Run) => Effect.Effect<string | null, ResultCheckError>;
}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const kube = yield* Kube;
    const source = yield* JobPodSource;
    // A gate lives only while a handler or its waiters own it; no per-history map.
    const gates = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    const tails = new Map<string, string | null>();
    // D88: one entry per unresolved terminal deletion. No timer/cap may silently
    // discard a completion; cleanup/disposition prunes it, scope close forgets it.
    const knownDeleted = new Map<string, { job: V1Job; pod: V1Pod | undefined }>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        knownDeleted.clear();
        tails.clear();
      }),
    );
    const jobFor = (id: string) =>
      source.jobs.list(options.namespace).find((job) => runIdOf(job) === id);
    const podFor = (id: string) =>
      source.pods.list(options.namespace).find((pod) => runIdOf(pod) === id);
    const target = (id: string, name: string, run?: Run) => ({
      namespace: options.namespace,
      name,
      runId: id,
      ...(run === undefined ? {} : { function: run.function_name }),
    });
    const cleanup = (id: string, name: string, run?: Run) =>
      Effect.gen(function* () {
        yield* kube.deleteSecret(target(id, name, run));
        yield* kube.deleteJob(target(id, name, run), "Background");
        tails.delete(id);
        knownDeleted.delete(id);
      });
    const captureTail = (id: string, pod: V1Pod | undefined, finalFailure: boolean) =>
      Effect.gen(function* () {
        const exited = container(pod)?.state?.terminated;
        if (!pod?.metadata?.name || tails.has(id) || exited?.exitCode === 0) return;
        if (
          !finalFailure &&
          !pod.metadata.deletionTimestamp &&
          !(exited && (exited.exitCode !== 0 || exited.reason === "OOMKilled"))
        )
          return;
        tails.set(id, null);
        const tail = yield* kube.readPodLog(target(id, pod.metadata.name)).pipe(
          Effect.map((value) => Buffer.from(value).subarray(0, 16384).toString("utf8")),
          Effect.catch(() => Effect.succeed(null)),
        );
        tails.set(id, tail);
      });
    const process = (id: string, event?: InformerEvent) =>
      Effect.gen(function* () {
        if (closed) return;
        const previous = knownDeleted.get(id);
        if (
          event?.deletedJob &&
          (trueCondition(event.deletedJob, "Complete") || trueCondition(event.deletedJob, "Failed"))
        ) {
          knownDeleted.set(id, {
            job: compactJob(event.deletedJob),
            pod: compactPod(event.deletedPod ?? podFor(id) ?? previous?.pod),
          });
        } else if (previous !== undefined && event?.deletedPod !== undefined) {
          knownDeleted.set(id, { job: previous.job, pod: compactPod(event.deletedPod) });
        }
        const retained = knownDeleted.get(id);
        const job = retained?.job ?? jobFor(id) ?? event?.deletedJob;
        const run = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (run === undefined) {
          if (job?.metadata?.name) yield* cleanup(id, job.metadata.name);
          else knownDeleted.delete(id);
          return;
        }
        yield* Effect.annotateCurrentSpan("function", run.function_name);
        if (terminal(run)) {
          yield* cleanup(id, run.job_name ?? job?.metadata?.name ?? `krun-${id}`, run);
          return;
        }
        // Queued terminal observations survive for the main-loop replay. Cancelling
        // runs remain eligible for status only; cancellation step 5 owns lifecycle.
        if (run.state === "queued") return;
        const pod = podFor(id) ?? retained?.pod ?? event?.deletedPod;
        const status = statusOf(job, pod, yield* DateTime.now);
        if (!sameStatus(run.job_status, status)) yield* store.setJobStatus(id, status);
        if (run.state === "cancelling") {
          knownDeleted.delete(id);
          tails.delete(id);
          return;
        }
        const complete = trueCondition(job, "Complete") !== undefined;
        const failed = trueCondition(job, "Failed") !== undefined;
        yield* captureTail(id, pod, failed);
        if (!job || (!complete && !failed)) {
          if (run.state === "scheduled" && pod?.status?.phase === "Running")
            yield* store.transition(id, "scheduled", "running", null, {});
          return;
        }
        // No stale function report/result is copied back over concurrent writes. The
        // Store CAS coalesces errors and checks inline-result precedence atomically.
        const resultRef = complete && run.result === null ? yield* options.checkResult(run) : null;
        const reason = complete ? null : failure(job, pod);
        const startedAt =
          time(container(pod)?.state?.terminated?.startedAt) ?? time(job.status?.startTime);
        const patch: Partial<Run> = {
          job_status: status,
          log_tail: tails.get(id) ?? null,
          ...(resultRef === null ? {} : { result_ref: resultRef }),
          ...(run.started_at !== null || startedAt === undefined ? {} : { started_at: startedAt }),
          ...(complete
            ? {}
            : {
                failure_reason: reason,
                error: {
                  source: "kubernetes",
                  message: status.message ?? status.reason ?? "Kubernetes Job failed",
                  ...(status.reason === undefined ? {} : { type: status.reason }),
                },
              }),
        };
        const changed = yield* store.transition(
          id,
          run.state,
          complete ? "succeeded" : "failed",
          reason,
          patch,
        );
        if (changed) {
          yield* cleanup(id, run.job_name ?? job.metadata?.name ?? `krun-${id}`, run);
          return;
        }
        const winner = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (winner !== undefined && terminal(winner))
          yield* cleanup(id, winner.job_name ?? job.metadata?.name ?? `krun-${id}`, winner);
        else if (winner?.state === "cancelling") {
          knownDeleted.delete(id);
          tails.delete(id);
        }
      });
    const handle = (id: string, event?: InformerEvent): Effect.Effect<void, HandlerError> =>
      source.ready.pipe(
        Effect.andThen(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              let gate = gates.get(id);
              if (gate === undefined) {
                gate = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
                gates.set(id, gate);
              }
              gate.users++;
              return gate;
            }),
            (gate) => process(id, event).pipe(Semaphore.withPermit(gate.semaphore)),
            (gate) =>
              Effect.sync(() => {
                if (--gate.users === 0) gates.delete(id);
              }),
          ),
        ),
        Effect.withSpan("scheduler.observe_run", { attributes: { "krun.run_id": id } }),
      );
    const guarded = (id: string, event?: InformerEvent) =>
      handle(id, event).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Scheduler cached observation failed; will retry").pipe(
            Effect.annotateLogs({ "krun.run_id": id, errorTag: error._tag }),
          ),
        ),
      );
    const reconcile = source.ready.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const ids = new Set<string>();
          for (const object of [
            ...source.jobs.list(options.namespace),
            ...source.pods.list(options.namespace),
          ]) {
            const id = runIdOf(object);
            if (id !== undefined && !gates.has(id)) ids.add(id);
          }
          for (const id of knownDeleted.keys()) if (!gates.has(id)) ids.add(id);
          return Effect.forEach(ids, (id) => guarded(id), { discard: true });
        }),
      ),
    );
    const replayCached = (run: Run): Effect.Effect<void, DatabaseError | KubeApiError> =>
      handle(run.id).pipe(
        // A result HEAD failure leaves cached/retained terminal work for retry, not
        // a provisioning failure that could reclassify a successfully created Job.
        Effect.catchTag("ResultCheckError", () =>
          Effect.logWarning("Scheduler result check failed; terminal observation retained").pipe(
            Effect.annotateLogs({ "krun.run_id": run.id }),
          ),
        ),
      );
    const run = Effect.all(
      [
        Stream.runForEach(source.jobEvents, (event) => guarded(event.id, event)),
        Stream.runForEach(source.podEvents, (event) => guarded(event.id, event)),
        reconcile.pipe(Effect.repeat(Schedule.spaced("5 minutes"))),
      ],
      { concurrency: "unbounded", discard: true },
    );
    return { handle, replayCached, reconcile, run };
  });
