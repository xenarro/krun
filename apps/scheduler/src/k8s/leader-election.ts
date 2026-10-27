import { functionMetadataSchema } from "@krun/shared/dist/functions/schema.js";
import { Readiness } from "@krun/shared/dist/health/readiness.js";
import type { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import type { V1Lease } from "@kubernetes/client-node";
import { Clock, Data, DateTime, Effect, Metric, Ref, type Scope } from "effect";
import { z } from "zod";
import { LeaseApi, type LeaseRecord } from "./lease-api.js";

export class LeaderLost extends Data.TaggedError("LeaderLost")<{
  readonly reason: "holder_changed" | "lease_missing" | "renew_deadline";
}> {}
export class LeaderConfigInvalid extends Data.TaggedError("LeaderConfigInvalid")<{
  readonly field: string;
}> {}
const configSchema = z.strictObject({
  namespace: functionMetadataSchema.shape.name,
  podName: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    .refine((value) =>
      value
        .split(".")
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        ),
    ),
});
interface Options {
  readonly namespace: string;
  readonly podName: string;
}
const transient = (e: KubeApiError) =>
  e.status === undefined || e.status === 409 || e.status === 429 || e.status >= 500;

/** Own one election term. The caller joins this effect at the process edge;
 * LeaderLost is a failure, not demotion/reacquisition. All leader-only resource
 * acquisitions/forks belong to the supplied scoped program, not the process.
 */
export const runLeaderElection = <E, R>(
  options: Options,
  leaderWork: Effect.Effect<void, E, R | Scope.Scope>,
  beforeRelease: Effect.Effect<void> = Effect.void,
): Effect.Effect<
  never,
  E | LeaderLost | LeaderConfigInvalid | KubeApiError,
  R | LeaseApi | Readiness
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const valid = configSchema.safeParse(options);
      if (!valid.success)
        return yield* Effect.fail(
          new LeaderConfigInvalid({ field: String(valid.error.issues[0]?.path[0] ?? "identity") }),
        );
      const api = yield* LeaseApi;
      const readiness = yield* Readiness;
      const gauge = Metric.gauge("krun_scheduler_leader");
      const setLeader = (leader: boolean) =>
        Ref.update(readiness.state, (state) => ({ ...state, leader })).pipe(
          Effect.andThen(Metric.update(gauge, leader ? 1 : 0)),
        );
      yield* setLeader(false);
      const owned = yield* Ref.make(false);
      const observed = yield* Ref.make<
        { holder: string; renew: string | undefined; seenAt: number } | undefined
      >(undefined);
      const lastRenew = yield* Ref.make(0);
      const body = (lease: LeaseRecord | undefined, holder: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.nowAsDate;
          return {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: {
              name: "krun-scheduler",
              namespace: options.namespace,
              ...(lease?.metadata?.resourceVersion === undefined
                ? {}
                : { resourceVersion: lease.metadata.resourceVersion }),
            },
            spec: {
              ...lease?.spec,
              holderIdentity: holder,
              leaseDurationSeconds: 15,
              renewTime: now,
            },
          } satisfies V1Lease;
        });
      const release = Effect.gen(function* () {
        if (!(yield* Ref.get(owned))) return;
        const current = yield* api.read(options.namespace);
        if (current.spec?.holderIdentity !== options.podName) return;
        yield* api.replace(options.namespace, yield* body(current, ""));
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.logWarning("Scheduler Lease release could not be confirmed")),
      );
      // This outer finalizer runs only after both racing child programs (including
      // leader resources and their in-flight calls) have settled cancellation.
      yield* Effect.addFinalizer(() =>
        setLeader(false).pipe(Effect.andThen(beforeRelease), Effect.andThen(release)),
      );
      const attempt = Effect.gen(function* () {
        const existing = yield* api
          .read(options.namespace)
          .pipe(
            Effect.catch((e) => (e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e))),
          );
        const now = yield* Clock.currentTimeMillis;
        const holder = existing?.spec?.holderIdentity ?? "";
        const timestamp = existing?.spec?.renewTime;
        const renew = typeof timestamp === "string" ? timestamp : timestamp?.toISOString();
        const previous = yield* Ref.get(observed);
        const observation =
          previous === undefined || previous.holder !== holder || previous.renew !== renew
            ? { holder, renew, seenAt: now }
            : previous;
        yield* Ref.set(observed, observation);
        if (existing !== undefined && holder !== "" && now - observation.seenAt < 15000)
          return false;
        const updated =
          existing === undefined
            ? yield* api.create(options.namespace, yield* body(undefined, options.podName))
            : yield* api.replace(options.namespace, yield* body(existing, options.podName));
        if (updated.spec?.holderIdentity !== options.podName) return false;
        return true;
      }).pipe(Effect.catch((e) => (transient(e) ? Effect.succeed(false) : Effect.fail(e))));
      // Register ownership atomically after a confirmed write, but keep every API
      // wait/retry interruptible. Interrupted unacknowledged writes simply expire.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (!(yield* restore(attempt))) yield* restore(Effect.sleep("2 seconds"));
          yield* Ref.set(owned, true);
          yield* Ref.set(lastRenew, yield* Clock.currentTimeMillis);
        }),
      );
      yield* setLeader(true);
      const checkDeadline = Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) - (yield* Ref.get(lastRenew)) >= 10000)
          return yield* Effect.fail(new LeaderLost({ reason: "renew_deadline" }));
      });
      const renew = Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("2 seconds");
          yield* checkDeadline;
          yield* Effect.gen(function* () {
            const current = yield* api
              .read(options.namespace)
              .pipe(
                Effect.catch(
                  (e): Effect.Effect<never, LeaderLost | KubeApiError> =>
                    e.status === 404
                      ? Effect.fail(new LeaderLost({ reason: "lease_missing" }))
                      : Effect.fail(e),
                ),
              );
            if (current.spec?.holderIdentity !== options.podName)
              return yield* Effect.fail(new LeaderLost({ reason: "holder_changed" }));
            const updated = yield* api.replace(
              options.namespace,
              yield* body(current, options.podName),
            );
            if (updated.spec?.holderIdentity !== options.podName)
              return yield* Effect.fail(new LeaderLost({ reason: "holder_changed" }));
            yield* checkDeadline;
            yield* Ref.set(lastRenew, yield* Clock.currentTimeMillis);
          }).pipe(
            Effect.catch((e) =>
              e._tag === "KubeApiError" && transient(e) ? Effect.void : Effect.fail(e),
            ),
          );
        }),
      );
      const watchdog = Effect.forever(
        Effect.gen(function* () {
          yield* checkDeadline;
          const remaining = (yield* Ref.get(lastRenew)) + 10000 - (yield* Clock.currentTimeMillis);
          yield* Effect.sleep(Math.max(0, remaining));
        }),
      );
      const guardedRenew = Effect.raceFirst(renew, watchdog).pipe(
        Effect.ensuring(setLeader(false)),
      );
      const session = Effect.scoped(
        leaderWork.pipe(Effect.andThen(Effect.never), Effect.ensuring(setLeader(false))),
      );
      return yield* Effect.raceFirst(session, guardedRenew);
    }),
  );
