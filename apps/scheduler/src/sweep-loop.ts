import { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { CoreV1Api } from "@kubernetes/client-node";
import { DateTime, Duration, Effect, Metric, Option, Schedule, Semaphore } from "effect";
import { z } from "zod";
import { JobPodSource, runIdOf } from "./k8s/informers.js";
import { nativeRequest } from "./k8s/request.js";

const deleted = Metric.counter("krun_sweep_deleted_total", { incremental: true });
const pageSchema = z.object({
  items: z.array(z.unknown()),
  metadata: z.object({ _continue: z.string().optional() }).optional(),
});

/** Acquire and run in the elected leader scope. P4.11 owns process assembly. */
export const makeSweepLoop = (options: {
  readonly namespace: string;
  readonly retention: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const connection = yield* KubeConnection;
    const source = yield* JobPodSource;
    const core = connection.config.makeApiClient(CoreV1Api);
    const gate = yield* Semaphore.make(1);
    const secretSchema = z.object({
      metadata: z.object({
        name: z.string().min(1),
        namespace: z.literal(options.namespace),
        uid: z.string().min(1),
        resourceVersion: z.string().min(1),
        creationTimestamp: z.date(),
        labels: z.record(z.string(), z.string()),
      }),
    });
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }),
    );
    const hasJob = (id: string) =>
      source.hasPendingJob(id) ||
      source.jobs.list(options.namespace).some((job) => runIdOf(job) === id);
    const work = Effect.gen(function* () {
      if (closed) return;
      const now = yield* DateTime.now;
      const before = DateTime.subtract(now, { milliseconds: Duration.toMillis(options.retention) });
      const orphanBefore = DateTime.subtract(now, { hours: 1 });
      let removed: number;
      do {
        if (closed) return;
        // The Store write already settles commit/rollback uninterruptibly. Keep
        // its exact committed count in the same interruption-safe publication.
        removed = yield* store.sweep(before, 1000).pipe(
          Effect.tap((count) => Metric.update(deleted, count)),
          Effect.uninterruptible,
        );
      } while (removed >= 1000);
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        if (closed) return;
        const response = yield* nativeRequest(
          connection,
          (nativeOptions) =>
            core.listNamespacedSecret(
              {
                namespace: options.namespace,
                labelSelector: "krun.io/run-id",
                limit: 1000,
                ...(cursor === undefined ? {} : { _continue: cursor }),
              },
              nativeOptions,
            ),
          { namespace: options.namespace, name: "" },
          "list",
          "secrets",
        );
        const parsed = pageSchema.safeParse(response);
        if (!parsed.success)
          return yield* Effect.fail(
            new KubeApiError({ operation: "request", reason: "invalid_response" }),
          );
        for (const item of parsed.data.items) {
          if (closed) return;
          // Drop token/data fields before retaining a cleanup candidate.
          const candidate = secretSchema.safeParse(item);
          if (!candidate.success) continue;
          const metadata = candidate.data.metadata;
          const id = runIdOf(candidate.data);
          const created = DateTime.make(metadata.creationTimestamp);
          if (
            id === undefined ||
            Option.isNone(created) ||
            DateTime.toEpochMillis(created.value) >= DateTime.toEpochMillis(orphanBefore) ||
            hasJob(id)
          )
            continue;
          yield* nativeRequest(
            connection,
            // A permit wait may yield while native Job ingress fills the cache.
            (nativeOptions) =>
              closed || hasJob(id)
                ? Promise.resolve({})
                : core.deleteNamespacedSecret(
                    {
                      namespace: options.namespace,
                      name: metadata.name,
                      body: {
                        preconditions: {
                          uid: metadata.uid,
                          resourceVersion: metadata.resourceVersion,
                        },
                      },
                    },
                    nativeOptions,
                  ),
            { namespace: options.namespace, name: metadata.name, runId: id },
            "delete",
            "secrets",
          ).pipe(
            Effect.catchTag("KubeApiError", (error) =>
              error.status === 404 || error.status === 409
                ? Effect.void
                : error.status === 429
                  ? Effect.fail(error)
                  : Effect.logWarning("Orphan Secret cleanup failed; will retry").pipe(
                      Effect.annotateLogs({
                        "krun.run_id": id,
                        errorTag: error._tag,
                        code: error.status ?? 0,
                      }),
                    ),
            ),
          );
        }
        cursor = parsed.data.metadata?._continue || undefined;
        if (cursor !== undefined) {
          if (seen.has(cursor))
            return yield* Effect.fail(
              new KubeApiError({ operation: "request", reason: "invalid_response" }),
            );
          seen.add(cursor);
        }
      } while (cursor !== undefined);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Scheduler sweep failed; will retry on the next pass").pipe(
          Effect.annotateLogs({ errorTag: error._tag }),
        ),
      ),
    );
    const iterate = Effect.suspend(() =>
      closed
        ? Effect.void
        : source.ready.pipe(
            Effect.andThen(work.pipe(Effect.withSpan("scheduler.sweep"))),
            Semaphore.withPermit(gate),
          ),
    );
    return {
      iterate,
      run: Effect.suspend(() =>
        closed
          ? Effect.void
          : iterate.pipe(Effect.repeat(Schedule.spaced("10 minutes")), Effect.asVoid),
      ),
    };
  });
