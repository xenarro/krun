import { createHash, randomBytes } from "node:crypto";
import type { SchedulerConfig } from "@krun/shared/dist/config/index.js";
import { type FunctionEntry, Functions } from "@krun/shared/dist/functions/cache.js";
import type { FunctionResource } from "@krun/shared/dist/functions/schema.js";
import { KubeApiError, kubeApiStatus } from "@krun/shared/dist/k8s/errors.js";
import type { DatabaseError } from "@krun/shared/dist/store/errors.js";
import { type Run, Store } from "@krun/shared/dist/store/index.js";
import {
  Clock,
  Data,
  DateTime,
  Duration,
  Effect,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import { z } from "zod";
import {
  type CreationDecision,
  makeCreationPolicy,
  retryAfterSeconds,
} from "./k8s/create-policy.js";
import { Kube } from "./k8s/kube.js";
import { buildJob, buildSecret } from "./k8s/manifests.js";

class IterationExpired extends Data.TaggedError("IterationExpired") {}
class MainLoopInvalid extends Data.TaggedError("MainLoopInvalid") {}
type CancellationTarget = Pick<Run, "id" | "job_name" | "function_name">;
interface CancellationScan {
  readonly pending: readonly CancellationTarget[];
  readonly cursor: string | null;
  readonly done: boolean;
}
type Config = Pick<
  SchedulerConfig,
  | "KRUN_MAX_RUNNING"
  | "KRUN_JOBS_NAMESPACE"
  | "KRUN_GATEWAY_INTERNAL_URL"
  | "KRUN_MAX_RESULT_BYTES"
  | "KRUN_TTL_AFTER_FINISHED"
  | "KRUN_JOB_HOST_USERS"
>;
interface Options {
  readonly owner: string;
  readonly config: Config;
  // P4.4 supplies its cache-backed handler; no default/no-op or API re-read.
  readonly replayCached: (run: Run) => Effect.Effect<void, DatabaseError | KubeApiError>;
}
const isExisting = (error: KubeApiError) =>
  error.status === 409 && kubeApiStatus(error).reason === "AlreadyExists";
const encodedToken = z
  .string()
  .refine((value) => Buffer.from(value, "base64").toString("base64") === value);

/** Construct within one leader term; run owns its ticker/subscription fibers.
 * Only steps 1-5 live here. Informers/lost Jobs and process assembly
 * are separate PLAN tasks. Existing Store writes settle before cancellation.
 */
export const makeMainLoop = (options: Options) =>
  Effect.gen(function* () {
    if (!z.string().min(1).safeParse(options.owner).success)
      return yield* Effect.fail(new MainLoopInvalid());
    const owner = options.owner,
      config = { ...options.config },
      replay = options.replayCached;
    const store = yield* Store,
      functions = yield* Functions,
      kube = yield* Kube;
    const policy = yield* makeCreationPolicy;
    const gate = yield* Semaphore.make(1);
    const cleanupDebt = yield* Ref.make<ReadonlyMap<string, Run>>(new Map());
    const replayDebt = yield* Ref.make<ReadonlyMap<string, Run>>(new Map());
    const cancellationScan = yield* Ref.make<CancellationScan | undefined>(undefined);
    const replayKnown = (run: Run) =>
      replay(run).pipe(
        Effect.andThen(
          Ref.update(replayDebt, (map) => {
            const next = new Map(map);
            next.delete(run.id);
            return next;
          }),
        ),
      );
    const rememberCleanup = (runs: readonly Run[]) =>
      Ref.update(cleanupDebt, (map) => {
        const next = new Map(map);
        for (const run of runs) next.set(run.id, run);
        return next;
      });
    const target = (run: CancellationTarget) => ({
      namespace: config.KRUN_JOBS_NAMESPACE,
      name: run.job_name ?? `krun-${run.id}`,
      function: run.function_name,
      runId: run.id,
    });
    const removeResources = (run: Run) =>
      Effect.gen(function* () {
        yield* kube.deleteJob(target(run), "Foreground");
        yield* kube.deleteSecret(target(run));
        yield* Ref.update(cleanupDebt, (map) => {
          const next = new Map(map);
          next.delete(run.id);
          return next;
        });
      });
    const iteration = Effect.gen(function* () {
      const pending = yield* Ref.make<ReadonlyMap<string, Run>>(new Map());
      const forget = (id: string) =>
        Ref.update(pending, (map) => {
          const next = new Map(map);
          next.delete(id);
          return next;
        });
      const release = (run: Run) =>
        store.releaseLease(run.id).pipe(
          Effect.timeout("5 seconds"),
          Effect.catch((error) =>
            Effect.logWarning("Scheduler claim release failed").pipe(
              Effect.annotateLogs({ "krun.run_id": run.id, errorTag: error._tag }),
            ),
          ),
          Effect.andThen(forget(run.id)),
        );
      const releasePending = Effect.flatMap(Ref.get(pending), (map) =>
        Effect.forEach(map.values(), release, { discard: true }),
      );
      const started = yield* Clock.currentTimeMillis;
      const checkDeadline = Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) - started >= 10_000)
          return yield* Effect.fail(new IterationExpired());
      });
      const schedule = (
        run: Run,
        fn: FunctionEntry & { spec: NonNullable<FunctionEntry["spec"]> },
      ) =>
        Effect.gen(function* () {
          let secretPresent = false;
          let creating = true;
          const provision = Effect.gen(function* () {
            yield* checkDeadline;
            const fresh = yield* Effect.sync(() => randomBytes(32).toString("base64url"));
            const secret = yield* Effect.fromResult(buildSecret({ run, config, token: fresh }));
            const adopted = yield* kube.createSecret(target(run), secret).pipe(
              Effect.as<string | undefined>(undefined),
              Effect.catch((error) => {
                if (!isExisting(error)) return Effect.fail(error);
                creating = false;
                return kube.readSecret(target(run)).pipe(
                  Effect.flatMap((existing) => {
                    const raw = encodedToken.safeParse(existing.data?.token);
                    if (!raw.success)
                      return Effect.fail(
                        new KubeApiError({ operation: "request", reason: "invalid_response" }),
                      );
                    const token = Buffer.from(raw.data, "base64").toString("utf8");
                    const validated = buildSecret({ run, config, token });
                    return validated._tag === "Success"
                      ? Effect.succeed(token)
                      : Effect.fail(
                          new KubeApiError({
                            operation: "request",
                            reason: "invalid_response",
                          }),
                        );
                  }),
                );
              }),
            );
            creating = true;
            secretPresent = true;
            yield* checkDeadline;
            const hash = yield* Effect.sync(() =>
              createHash("sha256")
                .update(adopted ?? fresh)
                .digest("hex"),
            );
            yield* store.setJobToken(run.id, `krun-${run.id}`, hash);
            yield* checkDeadline;
            const resource: FunctionResource = {
              apiVersion: "krun.io/v1alpha1",
              kind: "Function",
              metadata: { name: fn.name },
              spec: fn.spec,
            };
            const job = yield* Effect.fromResult(buildJob({ run, function: resource, config }));
            yield* kube
              .createJob(target(run), job)
              .pipe(
                Effect.catch((error) =>
                  isExisting(error) ? Effect.succeed(job) : Effect.fail(error),
                ),
              );
          });
          const decision = yield* provision.pipe(
            Effect.as<CreationDecision | undefined>(undefined),
            // Adoption reads retain their operation provenance: no creation
            // counters/backoff, and GET429 reaches the loop's rate-limit path.
            Effect.catchTag("KubeApiError", (error) =>
              !creating
                ? Effect.fail(error)
                : policy.failed(
                    fn.name,
                    isExisting(error)
                      ? new KubeApiError({ operation: error.operation, reason: "invalid_response" })
                      : error,
                  ),
            ),
          );
          if (decision?.kind === "permanent") {
            if (secretPresent) yield* kube.deleteSecret(target(run));
            yield* checkDeadline;
            yield* store.transition(run.id, "queued", "failed", decision.failureReason, {
              error: decision.error,
              failure_reason: decision.failureReason,
            });
            yield* release(run);
          } else if (decision?.kind === "transient") {
            yield* release(run);
            return decision;
          } else {
            yield* checkDeadline;
            // Preserve a committed scheduling result before pending interruption can
            // trigger cleanup. The Store itself already settles its transaction.
            const scheduled = yield* Effect.gen(function* () {
              const changed = yield* store.markScheduled(run.id);
              if (changed) {
                yield* Ref.update(replayDebt, (map) => new Map(map).set(run.id, run));
                yield* policy.succeeded(fn.name);
                yield* forget(run.id);
              } else yield* rememberCleanup([run]);
              return changed;
            }).pipe(Effect.uninterruptible);
            if (scheduled) {
              yield* checkDeadline;
              yield* replayKnown(run);
            } else {
              yield* removeResources(run);
              yield* release(run);
            }
          }
          return undefined;
        }).pipe(
          Effect.withSpan("scheduler.schedule_run", {
            attributes: { "krun.run_id": run.id, "krun.function": run.function_name },
          }),
        );
      const body = Effect.gen(function* () {
        const counts = yield* store.countByState();
        yield* checkDeadline;
        // Successful scheduling is already committed. Replay only in an active
        // iteration, never in a teardown finalizer or uninterruptible handler.
        for (const run of (yield* Ref.get(replayDebt)).values()) {
          yield* checkDeadline;
          yield* replayKnown(run);
        }
        // Terminal expiry removes rows from the next count snapshot. Keep only
        // known failed/interrupted cleanup, not a second Job list/scanner.
        for (const run of (yield* Ref.get(cleanupDebt)).values()) {
          yield* checkDeadline;
          yield* removeResources(run);
        }
        for (const [name, states] of counts) {
          if ((states.get("queued") ?? 0) === 0) continue;
          const entry = yield* functions.getAny(name);
          const timeout = entry?.result.queueTimeout ?? Duration.hours(1);
          const expired = yield* Effect.gen(function* () {
            const rows = yield* store.expireQueued(
              name,
              DateTime.subtract(yield* DateTime.now, { milliseconds: Duration.toMillis(timeout) }),
            );
            yield* rememberCleanup(rows.filter((run) => run.job_token_hash !== null));
            return rows;
          }).pipe(Effect.uninterruptible);
          for (const run of expired) {
            yield* checkDeadline;
            if (run.job_token_hash !== null) yield* removeResources(run);
          }
          yield* checkDeadline;
        }
        const inFlight = (states: Map<string, number> | undefined) =>
          (states?.get("scheduled") ?? 0) + (states?.get("running") ?? 0);
        let globalSlots = Math.max(
          0,
          config.KRUN_MAX_RUNNING -
            [...counts.values()].reduce((n, states) => n + inFlight(states), 0),
        );
        const claims: {
          run: Run;
          fn: FunctionEntry & { spec: NonNullable<FunctionEntry["spec"]> };
        }[] = [];
        for (const fn of yield* functions.list) {
          yield* checkDeadline;
          if (
            !fn.result.ok ||
            fn.spec === undefined ||
            globalSlots === 0 ||
            (yield* policy.isBackingOff(fn.name))
          )
            continue;
          const slots = Math.max(
            0,
            Math.min(globalSlots, fn.spec.maxConcurrency - inFlight(counts.get(fn.name))),
          );
          if (slots === 0) continue;
          // A database write may commit even after an interrupt is requested.
          // Register all returned claims atomically before observing cancellation.
          const rows = yield* Effect.gen(function* () {
            const rows = yield* store.claimQueued(
              fn.name,
              owner,
              DateTime.add(yield* DateTime.now, { seconds: 30 }),
              slots,
            );
            yield* Ref.update(pending, (map) => {
              const next = new Map(map);
              for (const run of rows) next.set(run.id, run);
              return next;
            });
            return rows;
          }).pipe(Effect.uninterruptible);
          globalSlots -= rows.length;
          for (const run of rows) claims.push({ run, fn: { ...fn, spec: fn.spec } });
        }
        for (const { run, fn } of claims) {
          yield* checkDeadline;
          if (yield* policy.isBackingOff(fn.name)) continue;
          const decision = yield* schedule(run, fn);
          if (decision?.pauseSeconds !== undefined) return decision.pauseSeconds;
        }
        // Step 5 normally drains the active prefix. On an isolated failure,
        // keyset traversal passes retained rows without an unbounded query or
        // repeatedly retrying the same poisoned prefix. Keep one page across
        // deadlines so a slow sweep can progress in later active iterations.
        const attempted = new Set<string>();
        const beginScan = Ref.update(
          cancellationScan,
          (scan) => scan ?? { pending: [], cursor: null, done: false },
        );
        const cancelOne = (run: CancellationTarget) =>
          Effect.gen(function* () {
            attempted.add(run.id);
            yield* checkDeadline;
            yield* kube.deleteJob(target(run), "Foreground");
            yield* checkDeadline;
            yield* kube.deleteSecret(target(run));
            yield* checkDeadline;
            yield* store.transition(run.id, "cancelling", "cancelled", null, {});
          }).pipe(
            Effect.withSpan("scheduler.cancel_run", {
              attributes: { "krun.run_id": run.id, "krun.function": run.function_name },
            }),
            Effect.catchTags({
              KubeApiError: (error) =>
                error.status === 429 ? Effect.fail(error) : isolatedFailure(run, error),
              DatabaseError: (error) => isolatedFailure(run, error),
            }),
          );
        const isolatedFailure = (run: CancellationTarget, error: KubeApiError | DatabaseError) =>
          beginScan.pipe(
            Effect.andThen(
              Effect.logWarning("Scheduler cancellation failed; retaining run for retry"),
            ),
            Effect.annotateLogs({ "krun.run_id": run.id, errorTag: error._tag }),
          );
        while (true) {
          yield* checkDeadline;
          const scan = yield* Ref.get(cancellationScan);
          if (scan === undefined) {
            const cancelling = yield* store.listByState(["cancelling"], config.KRUN_MAX_RUNNING);
            if (cancelling.length === 0) break;
            for (const run of cancelling) {
              yield* checkDeadline;
              if (attempted.has(run.id)) yield* beginScan;
              else yield* cancelOne(run);
            }
          } else if (scan.pending.length === 0) {
            if (scan.done) {
              yield* Ref.set(cancellationScan, undefined);
              break;
            }
            // Store reads settle on interruption. Publish the returned page
            // atomically, but never mask the subsequent resource operations.
            yield* Effect.gen(function* () {
              const page = yield* store.listRuns(
                { terms: [{ field: "state", operator: "=", value: "cancelling" }] },
                scan.cursor,
                config.KRUN_MAX_RUNNING,
              );
              yield* Ref.set(cancellationScan, {
                pending: page.runs.map((summary) => {
                  // The Store's canonical BASIC resource name, not API input.
                  const parts = summary.name.split("/");
                  return {
                    id: z.string().parse(parts[3]),
                    function_name: z.string().parse(parts[1]),
                    job_name: summary.jobName ?? null,
                  };
                }),
                cursor: page.next,
                done: page.next === null,
              });
            }).pipe(Effect.uninterruptible);
          } else {
            for (const run of scan.pending) {
              yield* checkDeadline;
              // A failed/interrupted attempt is retried next sweep; retaining
              // the remaining page avoids losing later rows at the deadline.
              yield* Ref.update(cancellationScan, (current) =>
                current === undefined ? current : { ...current, pending: current.pending.slice(1) },
              );
              if (!attempted.has(run.id)) yield* cancelOne(run);
            }
          }
        }
        return undefined;
      });
      return yield* body.pipe(
        Effect.timeout("10 seconds"),
        Effect.ensuring(releasePending),
        Effect.catch((error) =>
          error._tag === "KubeApiError" && error.status === 429
            ? retryAfterSeconds(error)
            : Effect.logWarning("Scheduler iteration ended without completing all work").pipe(
                Effect.annotateLogs({ errorTag: error._tag }),
                Effect.as<number | undefined>(undefined),
              ),
        ),
        Effect.withSpan("scheduler.iteration"),
      );
    });
    const iterate = iteration.pipe(
      Effect.flatMap((decision) =>
        decision === undefined
          ? Effect.void
          : Effect.logWarning("Kubernetes rate limited scheduler").pipe(
              Effect.andThen(Effect.sleep(decision * 1000)),
            ),
      ),
      Semaphore.withPermit(gate),
    );
    const run = Effect.scoped(
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1);
        yield* Effect.addFinalizer(() => Queue.shutdown(wake));
        yield* Effect.forkScoped(
          store.subscribe().pipe(
            Stream.filter((notice) => notice.kind === "state"),
            Stream.retry(Schedule.spaced("1 second")),
            Stream.runForEach(() => Queue.offer(wake, undefined)),
          ),
        );
        yield* Effect.forkScoped(
          Queue.offer(wake, undefined).pipe(Effect.repeat(Schedule.spaced("1 second"))),
        );
        return yield* Queue.take(wake).pipe(Effect.andThen(iterate), Effect.forever);
      }),
    );
    return { iterate, run };
  });
