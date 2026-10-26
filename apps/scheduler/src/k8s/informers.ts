import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { KubeConnection } from "@krun/shared/dist/k8s/config.js";
import { KubeApiError } from "@krun/shared/dist/k8s/errors.js";
import {
  BatchV1Api,
  CoreV1Api,
  type KubernetesListObject,
  type KubernetesObject,
  type V1Job,
  type V1Pod,
  Watch,
} from "@kubernetes/client-node";
import { ListWatch, type ObjectCache } from "@kubernetes/client-node/dist/cache.js";
import { HttpMethod, RequestContext } from "@kubernetes/client-node/dist/gen/http/http.js";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import { Context, Deferred, Effect, Queue, Stream } from "effect";
import { fetch } from "undici";
import { z } from "zod";
import { nativeRequest } from "./request.js";

export interface InformerEvent {
  readonly id: string;
  // Preserve deletion observations after native cache eviction, without spec/env.
  readonly deletedJob?: Pick<V1Job, "metadata" | "status">;
  readonly deletedPod?: Pick<V1Pod, "metadata" | "status">;
}
interface Source {
  readonly jobs: ObjectCache<V1Job>;
  readonly pods: ObjectCache<V1Pod>;
  readonly jobEvents: Stream.Stream<InformerEvent>;
  readonly podEvents: Stream.Stream<InformerEvent>;
  /** Both LISTs have been applied to the native caches, including empty lists. */
  readonly ready: Effect.Effect<void>;
}
export class JobPodSource extends Context.Service<JobPodSource, Source>()(
  "krun/scheduler/JobPodSource",
) {}
const identity = z.uuidv7();
export const runIdOf = (object: KubernetesObject): string | undefined => {
  const parsed = identity.safeParse(object.metadata?.labels?.["krun.io/run-id"]);
  return parsed.success ? parsed.data : undefined;
};
const envelope = z.object({
  type: z.enum(["ADDED", "MODIFIED", "DELETED", "BOOKMARK", "ERROR"]),
  object: z.looseObject({
    metadata: z
      .looseObject({ name: z.string().optional(), resourceVersion: z.string().optional() })
      .optional(),
    code: z.number().optional(),
  }),
});

/** D86: makeInformer's public ListWatch implementation, with an owned native
 * transport. No private fields, global Watch patches, raw Status logging, or
 * initial-sync inference from the pre-LIST connect callback.
 */
export const makeJobPodSource = (namespace: string) =>
  Effect.gen(function* () {
    const connection = yield* KubeConnection;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const root = new AbortController();
    const pending = new Set<Promise<unknown>>();
    const track = <A>(promise: Promise<A>): Promise<A> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const jobEvents = yield* Queue.unbounded<InformerEvent>();
    const podEvents = yield* Queue.unbounded<InformerEvent>();
    const jobSync = yield* Deferred.make<void>();
    const podSync = yield* Deferred.make<void>();
    const batch = connection.config.makeApiClient(BatchV1Api);
    const core = connection.config.makeApiClient(CoreV1Api);
    const informers: { stop: () => Promise<void> }[] = [];
    const detach: (() => void)[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        root.abort();
        for (const off of detach) off();
        await Promise.all(informers.map((informer) => informer.stop()));
        await Promise.allSettled([...pending]);
      }),
    );
    const make = <T extends KubernetesObject>(
      resource: "jobs" | "pods",
      path: string,
      type: "V1Job" | "V1Pod",
      list: () => Effect.Effect<KubernetesListObject<T>, KubeApiError>,
      events: Queue.Queue<InformerEvent>,
      synced: Deferred.Deferred<void>,
      deleted: (id: string, object: T) => InformerEvent,
    ) =>
      Effect.gen(function* () {
        const errors = yield* Queue.sliding<void>(1);
        let healthy = false;
        const onChange = (object: T) => {
          const id = runIdOf(object);
          if (!root.signal.aborted && id !== undefined) Queue.offerUnsafe(events, { id });
        };
        const onDelete = (object: T) => {
          const id = runIdOf(object);
          if (!root.signal.aborted && id !== undefined)
            Queue.offerUnsafe(events, deleted(id, object));
        };
        class ScopedWatch extends Watch {
          override async watch(
            watchPath: string,
            query: Record<string, string | number | boolean | undefined>,
            callback: (phase: string, object: unknown, watchObject?: unknown) => void,
            done: (error: unknown) => void,
          ): Promise<AbortController> {
            const controller = new AbortController();
            if (root.signal.aborted) {
              controller.abort();
              return controller;
            }
            // ListWatch invokes watch only after its LIST cache mutations finish.
            Deferred.doneUnsafe(synced, Effect.void);
            let ended = false;
            let status: number | undefined;
            let dispatcher: ReturnType<RequestContext["getDispatcher"]>;
            const end = (error: unknown) => {
              if (ended || root.signal.aborted) return;
              ended = true;
              controller.abort();
              done(error);
            };
            try {
              const response = await track(
                run(
                  connection
                    .call(async (signal) => {
                      const cluster = connection.config.getCurrentCluster();
                      if (!cluster)
                        throw new KubeApiError({ operation: "request", reason: "request_failed" });
                      const url = new URL(cluster.server + watchPath);
                      url.searchParams.set("watch", "true");
                      for (const [key, value] of Object.entries(query))
                        if (value !== undefined) url.searchParams.set(key, String(value));
                      const request = new RequestContext(url.toString(), HttpMethod.GET);
                      let handedOff = false;
                      try {
                        await connection.config.applySecurityAuthentication(request);
                        dispatcher = request.getDispatcher();
                        const combined = AbortSignal.any([root.signal, controller.signal, signal]);
                        combined.throwIfAborted();
                        const response = await fetch(url, {
                          headers: request.getHeaders(),
                          ...(dispatcher === undefined ? {} : { dispatcher }),
                          signal: combined,
                        });
                        if (response.status !== 200 || !response.body) {
                          status = response.status;
                          await response.body?.cancel();
                          throw new KubeApiError({
                            operation: "request",
                            reason: "request_failed",
                            status,
                          });
                        }
                        healthy = true;
                        handedOff = true;
                        return response.body;
                      } finally {
                        // Authentication can finish after interruption. Destroy its
                        // late dispatcher here too, before any aborted fetch dispatch.
                        if (!handedOff) await (dispatcher ?? request.getDispatcher())?.destroy();
                      }
                    })
                    .pipe(Effect.withSpan(`kube.watch ${resource}`, { attributes: { namespace } })),
                  { signal: root.signal },
                ),
              );
              const body = Readable.fromWeb(response);
              body.on("error", () =>
                end(new KubeApiError({ operation: "request", reason: "disconnected" })),
              );
              const lines = createInterface({ input: body });
              const pump = (async () => {
                try {
                  for await (const line of lines) {
                    if (root.signal.aborted || controller.signal.aborted) break;
                    let raw: unknown;
                    try {
                      raw = JSON.parse(line);
                    } catch {
                      throw new KubeApiError({ operation: "request", reason: "invalid_response" });
                    }
                    const event = envelope.safeParse(raw);
                    if (!event.success)
                      throw new KubeApiError({ operation: "request", reason: "invalid_response" });
                    if (event.data.type === "ERROR") {
                      end(
                        event.data.object.code === 410
                          ? { code: 410 }
                          : new KubeApiError({ operation: "request", reason: "request_failed" }),
                      );
                      return;
                    }
                    const object: unknown = ObjectSerializer.deserialize(event.data.object, type);
                    callback(event.data.type, object, raw);
                  }
                  end(new KubeApiError({ operation: "request", reason: "disconnected" }));
                } catch {
                  end(new KubeApiError({ operation: "request", reason: "disconnected" }));
                } finally {
                  lines.close();
                  body.destroy();
                  await dispatcher?.destroy();
                }
              })();
              track(pump);
            } catch {
              await dispatcher?.destroy();
              end(
                status === 410
                  ? { code: 410 }
                  : new KubeApiError({
                      operation: "request",
                      reason: "request_failed",
                      ...(status === undefined ? {} : { status }),
                    }),
              );
            }
            return controller;
          }
        }
        const informer = new ListWatch<T>(
          path,
          new ScopedWatch(connection.config),
          () => track(run(list(), { signal: root.signal })),
          false,
          "krun.io/run-id",
          undefined,
          {
            delayFn: (ms) => run(Effect.sleep(ms), { signal: root.signal }).catch(() => {}),
          },
        );
        const onError = () => {
          if (!root.signal.aborted) Queue.offerUnsafe(errors, undefined);
        };
        for (const verb of ["add", "update"] as const) informer.on(verb, onChange);
        informer.on("delete", onDelete);
        informer.on("error", onError);
        detach.push(() => {
          for (const verb of ["add", "update"] as const) informer.off(verb, onChange);
          informer.off("delete", onDelete);
          informer.off("error", onError);
        });
        informers.push(informer);
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            let delay = 1000;
            while (!root.signal.aborted) {
              yield* Effect.tryPromise({
                try: (signal) => {
                  const abort = () => root.abort();
                  signal.addEventListener("abort", abort, { once: true });
                  return informer.start().finally(() => signal.removeEventListener("abort", abort));
                },
                catch: () => new KubeApiError({ operation: "request", reason: "request_failed" }),
              }).pipe(Effect.catch(() => Effect.sync(onError)));
              yield* Queue.take(errors);
              yield* Effect.logWarning("Kubernetes informer disconnected; retrying").pipe(
                Effect.annotateLogs({ namespace, resource }),
              );
              if (healthy) {
                delay = 1000;
                healthy = false;
              }
              yield* Effect.sleep(delay);
              delay = Math.min(delay * 2, 30_000);
            }
          }),
        );
        return informer;
      });
    const jobs = yield* make<V1Job>(
      "jobs",
      `/apis/batch/v1/namespaces/${namespace}/jobs`,
      "V1Job",
      () =>
        nativeRequest(
          connection,
          (options) =>
            batch.listNamespacedJob({ namespace, labelSelector: "krun.io/run-id" }, options),
          { namespace, name: namespace },
          "list",
          "jobs",
        ),
      jobEvents,
      jobSync,
      (id, job) => ({
        id,
        deletedJob: {
          ...(job.metadata === undefined ? {} : { metadata: job.metadata }),
          ...(job.status === undefined ? {} : { status: job.status }),
        },
      }),
    );
    const pods = yield* make<V1Pod>(
      "pods",
      `/api/v1/namespaces/${namespace}/pods`,
      "V1Pod",
      () =>
        nativeRequest(
          connection,
          (options) =>
            core.listNamespacedPod({ namespace, labelSelector: "krun.io/run-id" }, options),
          { namespace, name: namespace },
          "list",
          "pods",
        ),
      podEvents,
      podSync,
      (id, pod) => ({
        id,
        deletedPod: {
          ...(pod.metadata === undefined ? {} : { metadata: pod.metadata }),
          ...(pod.status === undefined ? {} : { status: pod.status }),
        },
      }),
    );
    return {
      jobs,
      pods,
      jobEvents: Stream.fromQueue(jobEvents),
      podEvents: Stream.fromQueue(podEvents),
      ready: Effect.all([Deferred.await(jobSync), Deferred.await(podSync)], {
        concurrency: "unbounded",
      }).pipe(Effect.asVoid),
    } satisfies Source;
  });
