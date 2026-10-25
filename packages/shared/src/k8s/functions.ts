import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { CustomObjectsApi } from "@kubernetes/client-node";
import { HttpMethod, RequestContext } from "@kubernetes/client-node/dist/gen/http/http.js";
import { Observable } from "@kubernetes/client-node/dist/gen/rxjsStub.js";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import { type Dispatcher, fetch } from "undici";
import { z } from "zod";
import { functionMetadataSchema } from "../functions/schema.js";
import { KubeConnection } from "./config.js";
import { KubeApiError, kubeApiError } from "./errors.js";

export type FunctionEvent =
  | { readonly type: "sync"; readonly items: readonly unknown[] }
  | { readonly type: "add" | "update" | "delete"; readonly object: unknown };
export class FunctionSource extends Context.Service<
  FunctionSource,
  {
    readonly watch: (namespace: string) => Stream.Stream<FunctionEvent, KubeApiError>;
  }
>()("krun/FunctionSource") {}

const listSchema = z.looseObject({
  metadata: z.looseObject({ resourceVersion: z.string().min(1) }),
  items: z.array(z.unknown()),
});
const watchSchema = z.looseObject({
  type: z.enum(["ADDED", "MODIFIED", "DELETED", "BOOKMARK", "ERROR"]),
  object: z.unknown(),
});
const watchErrorSchema = z.looseObject({ code: z.number().int().min(100).max(599).optional() });
const invalid = () => new KubeApiError({ operation: "functions", reason: "invalid_response" });

/** One owned LIST+WATCH session. Every reconnect re-LISTs, including after HTTP 404/410.
 * Native ListWatch cannot signal successful empty LIST and stop() cannot abort a pending
 * LIST/watch handshake. Use the installed client's authenticated request context and API,
 * but own stream cancellation, dispatcher release and the authoritative snapshot marker.
 */
export const makeFunctionSource = Effect.gen(function* () {
  const connection = yield* KubeConnection;
  const api = connection.config.makeApiClient(CustomObjectsApi);
  return {
    watch: (namespace: string) =>
      Stream.callback<FunctionEvent, KubeApiError>((queue) =>
        Effect.gen(function* () {
          if (!functionMetadataSchema.shape.name.safeParse(namespace).success)
            return yield* Effect.fail(invalid());
          const path = `/apis/krun.io/v1alpha1/namespaces/${namespace}/functions`;
          const response = yield* connection.call(async (signal) => {
            let dispatcher: Dispatcher | undefined;
            try {
              return await api.listNamespacedCustomObject(
                { group: "krun.io", version: "v1alpha1", namespace, plural: "functions" },
                {
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
                },
              );
            } finally {
              await dispatcher?.destroy();
            }
          });
          const listed = listSchema.safeParse(response);
          if (!listed.success) return yield* Effect.fail(invalid());
          yield* Queue.offer(queue, { type: "sync", items: listed.data.items });

          const controller = new AbortController();
          let dispatcher: Dispatcher | undefined;
          let body: import("undici").Response["body"];
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              controller.abort();
              // The reader may own/close the body already; cancellation of a locked body rejects.
              await body?.cancel().catch(() => {});
              await dispatcher?.destroy();
            }),
          );
          const watched = yield* connection.call(async (requestSignal) => {
            const cluster = connection.config.getCurrentCluster();
            if (cluster === null) throw invalid();
            const url = new URL(`${cluster.server}${path}`);
            url.searchParams.set("watch", "true");
            url.searchParams.set("resourceVersion", listed.data.metadata.resourceVersion);
            url.searchParams.set("allowWatchBookmarks", "true");
            const context = new RequestContext(url.toString(), HttpMethod.GET);
            const signal = AbortSignal.any([controller.signal, requestSignal]);
            try {
              await connection.config.applySecurityAuthentication(context);
              dispatcher = context.getDispatcher();
              signal.throwIfAborted();
              const response = await fetch(url, {
                method: "GET",
                headers: context.getHeaders(),
                ...(dispatcher === undefined ? {} : { dispatcher }),
                signal,
              });
              body = response.body;
              if (response.status !== 200)
                throw new KubeApiError({
                  operation: "functions",
                  reason: "request_failed",
                  status: response.status,
                });
              return response;
            } finally {
              // Authentication may finish after interruption; never open a late request or agent.
              if (signal.aborted) await dispatcher?.destroy();
            }
          });
          const watchedBody = watched.body;
          if (watchedBody === null) return yield* Effect.fail(invalid());
          yield* Effect.forkScoped(
            Effect.tryPromise({
              try: async (signal) => {
                const input = Readable.fromWeb(watchedBody, {
                  signal: AbortSignal.any([controller.signal, signal]),
                });
                const lines = createInterface({ input, crlfDelay: Infinity });
                try {
                  for await (const line of lines) {
                    if (line.trim() === "") continue;
                    let value: unknown;
                    try {
                      value = JSON.parse(line);
                    } catch {
                      throw invalid();
                    }
                    const event = watchSchema.safeParse(value);
                    if (!event.success) throw invalid();
                    if (event.data.type === "ERROR") {
                      const error = watchErrorSchema.safeParse(event.data.object);
                      throw new KubeApiError({
                        operation: "functions",
                        reason: "request_failed",
                        ...(error.success && error.data.code !== undefined
                          ? { status: error.data.code }
                          : {}),
                      });
                    }
                    if (event.data.type === "BOOKMARK") continue;
                    const type =
                      event.data.type === "ADDED"
                        ? "add"
                        : event.data.type === "MODIFIED"
                          ? "update"
                          : "delete";
                    Queue.offerUnsafe(queue, { type, object: event.data.object });
                  }
                  throw new KubeApiError({ operation: "functions", reason: "disconnected" });
                } finally {
                  lines.close();
                  input.destroy();
                }
              },
              catch: kubeApiError,
            }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
          );
        }),
      ),
  } satisfies FunctionSource["Service"];
});

export const FunctionSourceLive = Layer.effect(FunctionSource, makeFunctionSource);
