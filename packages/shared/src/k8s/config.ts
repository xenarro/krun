import { KubeConfig } from "@kubernetes/client-node";
import { Clock, Context, Effect, Layer, Semaphore } from "effect";
import { z } from "zod";
import { KrunConfig } from "../config/index.js";
import { KubeApiError, KubeConfigError, kubeApiError } from "./errors.js";

interface Connection {
  readonly config: KubeConfig;
  /** Default eight in-flight API acquisitions; permit wait and request share a ten-second budget. */
  readonly call: <A>(
    request: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, KubeApiError>;
}
export class KubeConnection extends Context.Service<KubeConnection, Connection>()(
  "krun/KubeConnection",
) {}

export const makeKubeConnection = (
  options: { readonly load?: (config: KubeConfig) => void; readonly concurrency?: number } = {},
) =>
  Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => {
        const config = new KubeConfig();
        // Native precedence: KUBECONFIG, user config, then service-account configuration.
        (options.load ?? ((config) => config.loadFromDefault()))(config);
        if (!config.getCurrentCluster()) throw new Error("No active cluster");
        return config;
      },
      catch: () => new KubeConfigError({ message: "Kubernetes configuration could not be loaded" }),
    });
    const concurrency = z
      .int()
      .positive()
      .safeParse(options.concurrency ?? 8);
    if (!concurrency.success)
      return yield* Effect.fail(
        new KubeConfigError({ message: "Kubernetes configuration could not be loaded" }),
      );
    const semaphore = yield* Semaphore.make(concurrency.data);
    const call: Connection["call"] = (request) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        return yield* Effect.gen(function* () {
          // A permit can be released in the same clock tick as this waiter's
          // timeout. Do not dispatch native I/O after its total budget expires.
          if ((yield* Clock.currentTimeMillis) - started >= 10_000)
            return yield* Effect.fail(
              new KubeApiError({ operation: "request", reason: "timeout" }),
            );
          return yield* Effect.tryPromise({ try: request, catch: kubeApiError });
        }).pipe(
          Semaphore.withPermit(semaphore),
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new KubeApiError({ operation: "request", reason: "timeout" })),
          ),
        );
      });
    return { config, call } satisfies Connection;
  });

export const KubeConnectionLive = Layer.effect(
  KubeConnection,
  Effect.gen(function* () {
    const value = yield* KrunConfig;
    return yield* makeKubeConnection({
      concurrency: value.role === "scheduler" ? value.config.KRUN_K8S_CONCURRENCY : 8,
    });
  }),
);
