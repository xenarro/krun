import { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import { CoordinationV1Api, type V1Lease } from "@kubernetes/client-node";
import type { RequestContext } from "@kubernetes/client-node/dist/gen/http/http.js";
import { Observable } from "@kubernetes/client-node/dist/gen/rxjsStub.js";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";

// client-node 2.0.1 leaves unknown V1MicroTime values as wire strings.
// Keep their exact precision; native Date values remain useful for stubs.
export type LeaseRecord = Omit<V1Lease, "spec"> & {
  spec?: Omit<NonNullable<V1Lease["spec"]>, "renewTime"> & { renewTime?: Date | string };
};
export class LeaseApi extends Context.Service<
  LeaseApi,
  {
    readonly read: (namespace: string) => Effect.Effect<LeaseRecord, KubeApiError>;
    readonly create: (namespace: string, body: V1Lease) => Effect.Effect<LeaseRecord, KubeApiError>;
    readonly replace: (
      namespace: string,
      body: V1Lease,
    ) => Effect.Effect<LeaseRecord, KubeApiError>;
  }
>()("krun/LeaseApi") {}

type Client = Pick<
  CoordinationV1Api,
  "readNamespacedLease" | "createNamespacedLease" | "replaceNamespacedLease"
>;
type Options = NonNullable<Parameters<Client["readNamespacedLease"]>[1]>;
const response = z.looseObject({
  metadata: z.looseObject({ resourceVersion: z.string().min(1) }),
  spec: z
    .looseObject({
      holderIdentity: z.string().optional(),
      renewTime: z.union([z.date(), z.iso.datetime({ offset: true })]).optional(),
    })
    .optional(),
});
// The optional native client is a narrow constructor seam for stubbed API tests.
// Authentication/limiting/timeouts still belong to the shared connection.
export const makeLeaseApi = (client?: Client) =>
  Effect.gen(function* () {
    const connection = yield* KubeConnection;
    const api = client ?? connection.config.makeApiClient(CoordinationV1Api);
    const call = (
      request: (options: Options) => Promise<V1Lease>,
    ): Effect.Effect<LeaseRecord, KubeApiError> =>
      connection
        .call(async (signal) => {
          let dispatcher: ReturnType<RequestContext["getDispatcher"]>;
          try {
            return await request({
              middlewareMergeStrategy: "append",
              middleware: [
                {
                  pre: (context) => {
                    dispatcher = context.getDispatcher();
                    context.setSignal(signal);
                    signal.throwIfAborted();
                    return new Observable(Promise.resolve(context));
                  },
                  post: (context) => new Observable(Promise.resolve(context)),
                },
              ],
            });
          } finally {
            await dispatcher?.destroy();
          }
        })
        .pipe(
          Effect.flatMap((value) =>
            response.safeParse(value).success
              ? Effect.succeed(value)
              : Effect.fail(new KubeApiError({ operation: "request", reason: "invalid_response" })),
          ),
        );
    return {
      read: (namespace) =>
        call((options) => api.readNamespacedLease({ namespace, name: "krun-scheduler" }, options)),
      create: (namespace, body) =>
        call((options) => api.createNamespacedLease({ namespace, body }, options)),
      replace: (namespace, body) =>
        call((options) =>
          api.replaceNamespacedLease({ namespace, name: "krun-scheduler", body }, options),
        ),
    } satisfies LeaseApi["Service"];
  });
export const LeaseApiLive = Layer.effect(LeaseApi, makeLeaseApi());
