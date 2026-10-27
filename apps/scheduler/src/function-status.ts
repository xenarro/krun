import type { FunctionEntry, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import {
  functionMetadataSchema,
  functionStatusSchema,
} from "@krun/shared/dist/functions/schema.js";
import { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { CustomObjectsApi, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import { Effect, Semaphore, Stream } from "effect";
import { nativeRequest } from "./k8s/request.js";

const desired = (entry: FunctionEntry) =>
  functionStatusSchema.parse({
    observedGeneration: entry.generation,
    conditions: [
      {
        type: "Ready",
        status: entry.result.ok ? "True" : "False",
        reason: entry.result.reason,
        message: entry.result.message,
      },
    ],
  });
const matches = (entry: FunctionEntry) => {
  const condition = entry.status?.conditions?.[0];
  return (
    entry.status?.observedGeneration === entry.generation &&
    condition?.type === "Ready" &&
    condition.status === (entry.result.ok ? "True" : "False") &&
    condition.reason === entry.result.reason &&
    condition.message === entry.result.message
  );
};
type Observation = Pick<FunctionEntry, "uid" | "generation" | "resourceVersion">;
const same = (a: Observation | undefined, b: Observation) =>
  a?.uid === b.uid && a.generation === b.generation && a.resourceVersion === b.resourceVersion;

/** Acquire inside the elected leader term, never the process/gateway scope.
 * P4.11 supplies this cache capability and forks run in runLeaderElection's work.
 * reconcile is also safe for that leader's explicit full reconciliation pass.
 */
export const makeFunctionStatusWriter = (options: {
  readonly namespace: string;
  readonly cache: Effect.Success<ReturnType<typeof makeFunctions>>["status"];
}) =>
  Effect.gen(function* () {
    if (!functionMetadataSchema.shape.name.safeParse(options.namespace).success)
      return yield* Effect.fail(
        new KubeApiError({ operation: "functions", reason: "invalid_response" }),
      );
    const connection = yield* KubeConnection;
    const api = connection.config.makeApiClient(CustomObjectsApi);
    const gate = yield* Semaphore.make(1);
    // Acknowledgement is only for an identical pre-echo input, not inferred status.
    // New resourceVersions always re-check actual cached status, including erasure.
    const acknowledged = new Map<string, Observation>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        acknowledged.clear();
      }),
    );
    const reconcile = Effect.gen(function* () {
      if (closed) return;
      const entries = yield* options.cache.all;
      const present = new Map(entries.map((entry) => [entry.name, entry]));
      for (const [name, observation] of acknowledged) {
        const current = present.get(name);
        if (current === undefined || !same(observation, current)) acknowledged.delete(name);
      }
      for (const observed of entries) {
        // Another Function's patch may have awaited I/O. Never dispatch this
        // snapshot's stale validation after its deletion/replacement/update.
        const entry = yield* options.cache.getAny(observed.name);
        if (closed) return;
        if (entry === undefined) continue;
        if (matches(entry)) {
          acknowledged.delete(entry.name);
          continue;
        }
        if (same(acknowledged.get(entry.name), entry)) continue;
        yield* nativeRequest(
          connection,
          (nativeOptions) =>
            api.patchNamespacedCustomObjectStatus(
              {
                group: "krun.io",
                version: "v1alpha1",
                namespace: options.namespace,
                plural: "functions",
                name: entry.name,
                body: {
                  metadata: { uid: entry.uid, resourceVersion: entry.resourceVersion },
                  status: desired(entry),
                },
              },
              setHeaderOptions("Content-Type", PatchStrategy.MergePatch, nativeOptions),
            ),
          { namespace: options.namespace, name: entry.name, function: entry.name },
          "patch",
          "functions/status",
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!closed)
                acknowledged.set(entry.name, {
                  uid: entry.uid,
                  generation: entry.generation,
                  resourceVersion: entry.resourceVersion,
                });
            }),
          ),
          Effect.catchTag("KubeApiError", (error) =>
            Effect.logWarning("Function status patch failed").pipe(
              Effect.annotateLogs({ name: entry.name, code: error.status ?? 0 }),
            ),
          ),
        );
      }
    }).pipe(Semaphore.withPermit(gate));
    return {
      reconcile,
      // Replay-one bounded invalidations provide a promotion snapshot and cannot
      // lose an update between subscribing and the first complete-cache read.
      run: Effect.suspend(() =>
        closed ? Effect.void : Stream.runForEach(options.cache.changes, () => reconcile),
      ),
    };
  });
