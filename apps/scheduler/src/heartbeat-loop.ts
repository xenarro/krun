import { Functions } from "@krun/shared/dist/functions/cache.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { DateTime, Duration, Effect, Schedule, Semaphore } from "effect";
import type { makeJobController } from "./job-controller.js";
import { JobPodSource } from "./k8s/informers.js";

interface HeartbeatLoopOptions {
  readonly controller: Pick<
    Effect.Success<ReturnType<typeof makeJobController>>,
    "heartbeat" | "retryHeartbeats"
  >;
}
/** Leader-scoped component; P4.11 owns starting it alongside the shared controller. */
export const makeHeartbeatLoop = (options: HeartbeatLoopOptions) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const functions = yield* Functions;
    const source = yield* JobPodSource;
    const gate = yield* Semaphore.make(1);
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }),
    );
    const pass = Effect.gen(function* () {
      if (closed) return;
      const attempted = yield* options.controller.retryHeartbeats;
      for (const listed of yield* functions.list) {
        if (closed) return;
        const entry = yield* functions.get(listed.name);
        if (
          entry?.spec?.heartbeatTimeout === undefined ||
          !entry.result.ok ||
          entry.result.heartbeatTimeout === undefined
        )
          continue;
        // The SQL selection is only a hint. Each new candidate, and its final
        // pre-DELETE check, reads this effect afresh under the controller gate.
        const currentPolicy = Effect.gen(function* () {
          const current = yield* functions.get(entry.name);
          if (
            current?.name !== entry.name ||
            current.uid !== entry.uid ||
            current.spec?.heartbeatTimeout === undefined ||
            !current.result.ok ||
            current.result.heartbeatTimeout === undefined
          )
            return undefined;
          return {
            functionName: current.name,
            timeout: current.spec.heartbeatTimeout,
            before: DateTime.subtract(yield* DateTime.now, {
              milliseconds: Duration.toMillis(current.result.heartbeatTimeout),
            }),
          };
        });
        const before = DateTime.subtract(yield* DateTime.now, {
          milliseconds: Duration.toMillis(entry.result.heartbeatTimeout),
        });
        yield* Effect.gen(function* () {
          for (const row of yield* store.listStale(entry.name, before)) {
            if (closed) return;
            if (attempted.has(row.id)) continue;
            yield* options.controller
              .heartbeat(row.id, currentPolicy)
              .pipe(
                Effect.catch((error) =>
                  error._tag === "KubeApiError" && error.status === 429
                    ? Effect.fail(error)
                    : Effect.logWarning("Scheduler heartbeat check failed; will retry").pipe(
                        Effect.annotateLogs({ "krun.run_id": row.id, errorTag: error._tag }),
                      ),
                ),
              );
          }
        }).pipe(
          Effect.catch((error) =>
            error._tag === "KubeApiError" && error.status === 429
              ? Effect.fail(error)
              : Effect.logWarning("Scheduler stale-run query failed; will retry").pipe(
                  Effect.annotateLogs({ function: entry.name, errorTag: error._tag }),
                ),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Scheduler heartbeat pass yielded; will retry").pipe(
          Effect.annotateLogs({ errorTag: error._tag }),
        ),
      ),
    );
    const iterate = Effect.suspend(() =>
      closed
        ? Effect.void
        : Effect.all([source.ready, functions.synced]).pipe(
            Effect.andThen(pass.pipe(Effect.withSpan("scheduler.heartbeat_loop"))),
            Semaphore.withPermit(gate),
          ),
    );
    return {
      iterate,
      run: iterate.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.asVoid),
    };
  });
