import type { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { leaderRunStore, TerminalExitAt } from "@krun/shared/dist/runtime/run-metrics.js";
import type { DatabaseError, JobStatus, Run } from "@krun/shared/dist/store/index.js";
import { Store } from "@krun/shared/dist/store/index.js";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { Clock, Data, DateTime, Effect, Option, Schedule, Semaphore, Stream } from "effect";
import { type InformerEvent, JobPodSource, runIdOf } from "./k8s/informers.js";
import { Kube } from "./k8s/kube.js";

/** Required P6.2 boundary: return null only for a disabled store/absent object.
 * Transport/configuration failures must fail, never silently mean not-found.
 */
export class ResultCheckError extends Data.TaggedError("ResultCheckError")<{
  readonly reason: "request_failed";
}> {}
type HandlerError = DatabaseError | KubeApiError | ResultCheckError;
interface HeartbeatPolicy {
  readonly functionName: string;
  readonly before: DateTime.Utc;
  readonly timeout: string;
}
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
  readonly maxRunning: number;
  readonly checkResult: (run: Run) => Effect.Effect<string | null, ResultCheckError>;
}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const lifecycle = leaderRunStore(store);
    const kube = yield* Kube;
    const source = yield* JobPodSource;
    // A gate lives only while a handler or its waiters own it; no per-history map.
    const gates = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    const tails = new Map<string, string | null>();
    const exitTimes = new Map<string, DateTime.Utc>();
    // D88: one entry per unresolved terminal deletion. No timer/cap may silently
    // discard a completion; cleanup/disposition prunes it, scope close forgets it.
    const knownDeleted = new Map<string, { job: V1Job; pod: V1Pod | undefined }>();
    const firstAbsent = new Map<string, number>();
    const lostCleanup = new Map<string, Pick<Run, "id" | "job_name" | "function_name">>();
    const heartbeatDebt = new Map<
      string,
      {
        run: Pick<Run, "id" | "job_name" | "function_name">;
        tail: string | null;
        message: string;
        committed: boolean;
      }
    >();
    const lostGate = yield* Semaphore.make(1);
    let lastLostId: string | undefined;
    let startupReported = false;
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        knownDeleted.clear();
        tails.clear();
        exitTimes.clear();
        firstAbsent.clear();
        lostCleanup.clear();
        heartbeatDebt.clear();
        lastLostId = undefined;
      }),
    );
    const jobFor = (id: string) =>
      source.jobs.list(options.namespace).find((job) => runIdOf(job) === id);
    const hasJob = (id: string) => source.jobs.get(`krun-${id}`, options.namespace) !== undefined;
    const hasObservation = (id: string) =>
      hasJob(id) || source.hasPendingJob(id) || knownDeleted.has(id) || heartbeatDebt.has(id);
    const podFor = (id: string) =>
      source.pods.list(options.namespace).find((pod) => runIdOf(pod) === id);
    const target = (id: string, name: string, run?: Pick<Run, "function_name">) => ({
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
        exitTimes.delete(id);
        knownDeleted.delete(id);
        lostCleanup.delete(id);
      });
    const readLogTail = (id: string, name: string, run: Run) =>
      kube.readPodLog(target(id, name, run)).pipe(
        Effect.timeout("10 seconds"),
        Effect.map((value) =>
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            Buffer.from(value).subarray(0, 16384),
            { stream: true },
          ),
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
    const captureTail = (id: string, pod: V1Pod | undefined, finalFailure: boolean, run: Run) =>
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
        const tail = yield* readLogTail(id, pod.metadata.name, run);
        tails.set(id, tail);
      });
    const captureDiagnostics = (
      id: string,
      pod: V1Pod | undefined,
      finalFailure: boolean,
      run: Run,
    ) =>
      Effect.gen(function* () {
        const exitedAt = time(container(pod)?.state?.terminated?.finishedAt);
        if (exitedAt !== undefined && !exitTimes.has(id)) exitTimes.set(id, exitedAt);
        yield* captureTail(id, pod, finalFailure, run);
      });
    const process = (id: string, event?: InformerEvent) =>
      Effect.gen(function* () {
        if (closed) return;
        if (event?.jobSeen || hasJob(id)) firstAbsent.delete(id);
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
        // Transfer ingress ownership only after presence/terminal knowledge is
        // incorporated. No yield or fallible operation may precede this handoff.
        if (event !== undefined) source.acknowledgeJob(event);
        // A successful foreground heartbeat deletion owns its pending CAS/Secret
        // stage. Watch events must not reclassify that deletion as exit_code/lost.
        if (heartbeatDebt.has(id)) return;
        const retained = knownDeleted.get(id);
        const job = retained?.job ?? jobFor(id) ?? event?.deletedJob;
        const run = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (run === undefined) {
          tails.delete(id);
          exitTimes.delete(id);
          if (job?.metadata?.name) yield* cleanup(id, job.metadata.name);
          else knownDeleted.delete(id);
          return;
        }
        yield* Effect.annotateCurrentSpan("function", run.function_name);
        if (terminal(run)) {
          firstAbsent.delete(id);
          yield* cleanup(id, run.job_name ?? job?.metadata?.name ?? `krun-${id}`, run);
          return;
        }
        const pod = podFor(id) ?? retained?.pod ?? event?.deletedPod;
        // Provisioning may create a failing Pod before markScheduled. Retain only
        // bounded diagnostics here; the main loop still owns queued publication.
        if (run.state === "queued") {
          if (run.job_token_hash !== null)
            yield* captureDiagnostics(id, pod, trueCondition(job, "Failed") !== undefined, run);
          return;
        }
        // Cancelling runs remain status-only; cancellation step 5 owns lifecycle.
        const status = statusOf(job, pod, yield* DateTime.now);
        if (!sameStatus(run.job_status, status)) yield* store.setJobStatus(id, status);
        if (run.state === "cancelling") {
          firstAbsent.delete(id);
          knownDeleted.delete(id);
          tails.delete(id);
          exitTimes.delete(id);
          return;
        }
        const complete = trueCondition(job, "Complete") !== undefined;
        const failed = trueCondition(job, "Failed") !== undefined;
        yield* captureDiagnostics(id, pod, failed, run);
        if (!job || (!complete && !failed)) {
          if (run.state === "scheduled" && pod?.status?.phase === "Running")
            yield* lifecycle.transition(id, "scheduled", "running", null, {});
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
          log_tail: complete ? null : (tails.get(id) ?? null),
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
        const changed = yield* lifecycle
          .transition(id, run.state, complete ? "succeeded" : "failed", reason, patch)
          .pipe(Effect.provideService(TerminalExitAt, exitTimes.get(id)));
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
          exitTimes.delete(id);
        }
      });
    const serialized = <E>(id: string, work: Effect.Effect<void, E>) =>
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
        (gate) => work.pipe(Semaphore.withPermit(gate.semaphore)),
        (gate) =>
          Effect.sync(() => {
            if (--gate.users === 0) gates.delete(id);
          }),
      );
    const clearHeartbeat = (id: string) => {
      heartbeatDebt.delete(id);
      tails.delete(id);
      exitTimes.delete(id);
      firstAbsent.delete(id);
      knownDeleted.delete(id);
    };
    const resumeHeartbeat = (id: string): Effect.Effect<void, DatabaseError | KubeApiError> =>
      Effect.gen(function* () {
        const debt = heartbeatDebt.get(id);
        if (closed || debt === undefined) return;
        if (!debt.committed) {
          const row = yield* store
            .getRun(id)
            .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
          if (row?.state === "running") {
            // Settle SQL and publish only in-memory debt in the same mask. No
            // Kubernetes request is made uninterruptible.
            const changed = yield* Effect.gen(function* () {
              const changed = yield* lifecycle
                .transition(id, "running", "failed", "heartbeat_timeout", {
                  failure_reason: "heartbeat_timeout",
                  log_tail: debt.tail,
                  error: { source: "krun", message: debt.message },
                })
                .pipe(Effect.provideService(TerminalExitAt, exitTimes.get(id)));
              if (changed) debt.committed = true;
              return changed;
            }).pipe(Effect.uninterruptible);
            if (!changed) {
              const winner = yield* store
                .getRun(id)
                .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
              if (winner?.state === "failed" && winner.failure_reason === "heartbeat_timeout")
                debt.committed = true;
              else {
                clearHeartbeat(id);
                return;
              }
            }
          } else if (row?.state === "failed" && row.failure_reason === "heartbeat_timeout")
            debt.committed = true;
          else {
            clearHeartbeat(id);
            return;
          }
        }
        yield* kube.deleteSecret(target(id, debt.run.job_name ?? `krun-${id}`, debt.run));
        clearHeartbeat(id);
      });
    const heartbeatCandidate = (id: string, policy: Effect.Effect<HeartbeatPolicy | undefined>) =>
      Effect.gen(function* () {
        if (closed || source.hasPendingJob(id) || knownDeleted.has(id)) return undefined;
        const job = jobFor(id);
        if (trueCondition(job, "Complete") || trueCondition(job, "Failed")) return undefined;
        const pod = podFor(id);
        if (pod?.status?.phase !== "Running") return undefined;
        const row = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (closed || row?.state !== "running" || row.started_at === null) return undefined;
        // Refresh Function policy after the Store I/O, inside the same per-run
        // gate and again after log capture. Old batch cutoffs never authorize a
        // first DELETE; acknowledged post-DELETE debt does not rejudge policy.
        const currentPolicy = yield* policy;
        if (
          closed ||
          currentPolicy === undefined ||
          currentPolicy.functionName !== row.function_name
        )
          return undefined;
        // The Store/policy reads yield; terminal native ingress may have arrived meanwhile.
        const latestJob = jobFor(id);
        if (
          source.hasPendingJob(id) ||
          knownDeleted.has(id) ||
          trueCondition(latestJob, "Complete") ||
          trueCondition(latestJob, "Failed")
        )
          return undefined;
        const latestPod = podFor(id);
        if (latestPod?.status?.phase !== "Running") return undefined;
        const lastAt =
          row.runtime_status !== null &&
          DateTime.toEpochMillis(row.runtime_status.at) > DateTime.toEpochMillis(row.started_at)
            ? row.runtime_status.at
            : row.started_at;
        return DateTime.toEpochMillis(lastAt) < DateTime.toEpochMillis(currentPolicy.before)
          ? { row, pod: latestPod, lastAt, timeout: currentPolicy.timeout }
          : undefined;
      });
    const heartbeat = (id: string, policy: Effect.Effect<HeartbeatPolicy | undefined>) =>
      source.ready.pipe(
        Effect.andThen(
          serialized(
            id,
            Effect.gen(function* () {
              if (closed) return;
              if (heartbeatDebt.has(id)) return yield* resumeHeartbeat(id);
              const candidate = yield* heartbeatCandidate(id, policy);
              if (candidate === undefined) return;
              const tail = tails.has(id)
                ? (tails.get(id) ?? null)
                : candidate.pod.metadata?.name === undefined
                  ? null
                  : yield* readLogTail(id, candidate.pod.metadata.name, candidate.row);
              // Logs may take ten seconds. Re-read both caches and current Store
              // freshness immediately before the destructive request.
              const current = yield* heartbeatCandidate(id, policy);
              if (current === undefined) return;
              const run = {
                id,
                job_name: current.row.job_name,
                function_name: current.row.function_name,
              };
              const debt = {
                run,
                tail,
                message: `no status for ${current.timeout}, last at ${DateTime.formatIso(current.lastAt)}`,
                committed: false,
              };
              yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  kube.deleteJob(target(id, run.job_name ?? `krun-${id}`, run), "Foreground"),
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      heartbeatDebt.set(id, debt);
                    }),
                  ),
                ),
              );
              yield* resumeHeartbeat(id);
            }),
          ),
        ),
        Effect.withSpan("scheduler.heartbeat", { attributes: { "krun.run_id": id } }),
      );
    const retryHeartbeats = Effect.gen(function* () {
      const attempted = new Set<string>();
      for (const id of [...heartbeatDebt.keys()]) {
        if (closed) break;
        if (gates.has(id)) continue;
        attempted.add(id);
        yield* serialized(id, resumeHeartbeat(id)).pipe(
          Effect.withSpan("scheduler.heartbeat", { attributes: { "krun.run_id": id } }),
          Effect.catch((error) =>
            error._tag === "KubeApiError" && error.status === 429
              ? Effect.fail(error)
              : Effect.logWarning(
                  "Scheduler heartbeat cleanup failed; retaining work for retry",
                ).pipe(Effect.annotateLogs({ "krun.run_id": id, errorTag: error._tag })),
          ),
        );
      }
      return attempted;
    });
    const handle = (id: string, event?: InformerEvent): Effect.Effect<void, HandlerError> =>
      source.ready.pipe(
        Effect.andThen(serialized(id, process(id, event))),
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
    const deleteLostSecret = (
      run: Pick<Run, "id" | "job_name" | "function_name">,
      attempted: Set<string>,
    ) =>
      Effect.gen(function* () {
        if (closed) return;
        attempted.add(run.id);
        // Advance before interruptible I/O, so a poisoned deletion cannot pin
        // the front of known cleanup debt across iteration deadlines.
        lostCleanup.delete(run.id);
        lostCleanup.set(run.id, run);
        yield* kube.deleteSecret(target(run.id, run.job_name ?? `krun-${run.id}`, run));
        lostCleanup.delete(run.id);
        firstAbsent.delete(run.id);
        tails.delete(run.id);
        exitTimes.delete(run.id);
      });
    const lostOne = (id: string, attempted: Set<string>) =>
      Effect.gen(function* () {
        if (closed) return;
        if (hasObservation(id)) {
          firstAbsent.delete(id);
          return;
        }
        const row = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (closed) return;
        if (row === undefined || (row.state !== "scheduled" && row.state !== "running")) {
          firstAbsent.delete(id);
          tails.delete(id);
          exitTimes.delete(id);
          return;
        }
        // Cache/event work may have progressed during the Store read.
        if (hasObservation(id)) {
          firstAbsent.delete(id);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const since = firstAbsent.get(id);
        if (since === undefined) {
          firstAbsent.set(id, now);
          return;
        }
        if (now - since < 120_000) return;
        const debt = { id, job_name: row.job_name, function_name: row.function_name };
        const changed = yield* Effect.gen(function* () {
          if (closed || hasObservation(id)) {
            firstAbsent.delete(id);
            return false;
          }
          const changed = yield* lifecycle
            .transition(id, row.state, "failed", "job_lost", {
              failure_reason: "job_lost",
              log_tail: tails.get(id) ?? null,
              error: {
                source: "krun",
                message: "Kubernetes Job absent from informer cache for 2 minutes",
              },
            })
            .pipe(Effect.provideService(TerminalExitAt, exitTimes.get(id)));
          // The Store write settles before cancellation. Publish only known cleanup
          // ownership in the same mask, never perform Kubernetes I/O in it.
          if (changed) {
            lostCleanup.set(id, debt);
            firstAbsent.delete(id);
          }
          return changed;
        }).pipe(Effect.uninterruptible);
        if (changed) return yield* deleteLostSecret(debt, attempted);
        const winner = yield* store
          .getRun(id)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
        if (winner === undefined || (winner.state !== "scheduled" && winner.state !== "running"))
          firstAbsent.delete(id);
        if (winner?.state === "failed" && winner.failure_reason === "job_lost") {
          lostCleanup.set(id, debt);
          yield* deleteLostSecret(debt, attempted);
        }
      }).pipe(Effect.withSpan("scheduler.job_lost", { attributes: { "krun.run_id": id } }));
    const isolatedLost = (id: string, work: Effect.Effect<void, DatabaseError | KubeApiError>) =>
      work.pipe(
        Effect.catch((error) =>
          error._tag === "KubeApiError" && error.status === 429
            ? Effect.fail(error)
            : Effect.logWarning("Scheduler lost-Job check failed; retaining work for retry").pipe(
                Effect.annotateLogs({ "krun.run_id": id, errorTag: error._tag }),
              ),
        ),
      );
    const lostPass = Effect.gen(function* () {
      if (closed) return;
      const attempted = new Set<string>();
      const rows = yield* store.listByState(["scheduled", "running"], options.maxRunning);
      if (closed) return;
      const active = new Set(rows.map((row) => row.id));
      for (const id of firstAbsent.keys()) if (!active.has(id)) firstAbsent.delete(id);
      if (!startupReported) {
        const missingJobs = rows.filter((row) => !hasJob(row.id)).length;
        yield* Effect.logInfo("Scheduler initial active runs without cached Jobs").pipe(
          Effect.annotateLogs({ missingJobs }),
        );
        startupReported = true;
      }
      const pivot = rows.findIndex((row) => row.id === lastLostId);
      const ordered = [...rows.slice(pivot + 1), ...rows.slice(0, pivot + 1)];
      for (const row of ordered) {
        if (closed) return;
        if (!gates.has(row.id)) {
          lastLostId = row.id;
          yield* isolatedLost(row.id, serialized(row.id, lostOne(row.id, attempted)));
        }
      }
      // Fresh active work precedes terminal cleanup debt. A Secret delete that
      // consumes the caller's deadline cannot prevent later runs being examined.
      for (const [id, debt] of [...lostCleanup]) {
        if (!attempted.has(id) && !gates.has(id))
          yield* isolatedLost(id, serialized(id, deleteLostSecret(debt, attempted)));
      }
    }).pipe(Effect.withSpan("scheduler.check_lost_jobs"));
    const checkLost: Effect.Effect<void, DatabaseError | KubeApiError> = Effect.suspend(() =>
      closed
        ? Effect.void
        : source.ready.pipe(Effect.andThen(lostPass), Semaphore.withPermit(lostGate)),
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
    const reconcileLost = reconcile.pipe(
      Effect.andThen(checkLost),
      Effect.catch((error) =>
        Effect.logWarning("Scheduler lost-Job reconciliation failed; will retry").pipe(
          Effect.annotateLogs({ errorTag: error._tag }),
        ),
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
        reconcileLost.pipe(Effect.repeat(Schedule.spaced("5 minutes"))),
      ],
      { concurrency: "unbounded", discard: true },
    );
    return {
      handle,
      replayCached,
      checkLost,
      heartbeat,
      retryHeartbeats,
      reconcile: reconcileLost,
      run,
    };
  });
