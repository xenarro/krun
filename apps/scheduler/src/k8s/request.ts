import type { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import type { CoordinationV1Api } from "@kubernetes/client-node";
import type { RequestContext } from "@kubernetes/client-node/dist/gen/http/http.js";
import { Observable } from "@kubernetes/client-node/dist/gen/rxjsStub.js";
import { Effect } from "effect";

export type NativeOptions = NonNullable<Parameters<CoordinationV1Api["readNamespacedLease"]>[1]>;
export interface KubeTarget {
  readonly namespace: string;
  readonly name: string;
  readonly function?: string;
  readonly runId?: string;
}

/** One authenticated native call; the connection owns the shared permit/timeout.
 * The span includes permit wait, but never arguments, manifests or Status text.
 */
export const nativeRequest = <A>(
  connection: KubeConnection["Service"],
  request: (options: NativeOptions) => Promise<A>,
  target: KubeTarget,
  verb: "get" | "create" | "update" | "delete" | "list" | "patch",
  resource: "leases" | "jobs" | "secrets" | "pods/log" | "pods" | "functions/status",
) =>
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
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          "error.tag": error._tag,
          ...(error.status === undefined ? {} : { "http.status_code": error.status }),
        }),
      ),
      Effect.withSpan(`kube.${verb} ${resource}`, {
        attributes: {
          namespace: target.namespace,
          name: target.name,
          ...(target.function === undefined ? {} : { function: target.function }),
          ...(target.runId === undefined ? {} : { "krun.run_id": target.runId }),
        },
      }),
    );
