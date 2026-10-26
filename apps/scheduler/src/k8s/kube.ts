import { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import type { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { BatchV1Api, CoreV1Api, type V1Job, type V1Secret } from "@kubernetes/client-node";
import { Context, Effect, Layer } from "effect";
import { type KubeTarget, nativeRequest } from "./request.js";

interface Service {
  readonly createJob: (target: KubeTarget, body: V1Job) => Effect.Effect<V1Job, KubeApiError>;
  readonly createSecret: (
    target: KubeTarget,
    body: V1Secret,
  ) => Effect.Effect<V1Secret, KubeApiError>;
  readonly readSecret: (target: KubeTarget) => Effect.Effect<V1Secret, KubeApiError>;
  readonly deleteJob: (
    target: KubeTarget,
    propagation: "Foreground" | "Background",
  ) => Effect.Effect<void, KubeApiError>;
  readonly deleteSecret: (target: KubeTarget) => Effect.Effect<void, KubeApiError>;
  readonly readPodLog: (target: KubeTarget) => Effect.Effect<string, KubeApiError>;
}
export class Kube extends Context.Service<Kube, Service>()("krun/scheduler/Kube") {}

export const makeKube = () =>
  Effect.gen(function* () {
    const connection = yield* KubeConnection;
    const batch = connection.config.makeApiClient(BatchV1Api);
    const core = connection.config.makeApiClient(CoreV1Api);
    const deleted = (request: Effect.Effect<unknown, KubeApiError>) =>
      request.pipe(
        Effect.asVoid,
        Effect.catch((error) => (error.status === 404 ? Effect.void : Effect.fail(error))),
      );
    return {
      createJob: (target, body) =>
        nativeRequest(
          connection,
          (options) => batch.createNamespacedJob({ namespace: target.namespace, body }, options),
          target,
          "create",
          "jobs",
        ),
      createSecret: (target, body) =>
        nativeRequest(
          connection,
          (options) => core.createNamespacedSecret({ namespace: target.namespace, body }, options),
          target,
          "create",
          "secrets",
        ),
      readSecret: (target) =>
        nativeRequest(
          connection,
          (options) =>
            core.readNamespacedSecret({ namespace: target.namespace, name: target.name }, options),
          target,
          "get",
          "secrets",
        ),
      deleteJob: (target, propagation) =>
        deleted(
          nativeRequest(
            connection,
            (options) =>
              batch.deleteNamespacedJob(
                { namespace: target.namespace, name: target.name, propagationPolicy: propagation },
                options,
              ),
            target,
            "delete",
            "jobs",
          ),
        ),
      deleteSecret: (target) =>
        deleted(
          nativeRequest(
            connection,
            (options) =>
              core.deleteNamespacedSecret(
                { namespace: target.namespace, name: target.name },
                options,
              ),
            target,
            "delete",
            "secrets",
          ),
        ),
      readPodLog: (target) =>
        nativeRequest(
          connection,
          (options) =>
            core.readNamespacedPodLog(
              {
                namespace: target.namespace,
                name: target.name,
                container: "function",
                tailLines: 100,
                limitBytes: 16384,
              },
              options,
            ),
          target,
          "get",
          "pods/log",
        ),
    } satisfies Service;
  });
export const KubeLive = Layer.effect(Kube, makeKube());
