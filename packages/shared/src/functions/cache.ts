import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Metric,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { z } from "zod";
import { durationToMilliseconds } from "../config/duration.js";
import { KrunConfig } from "../config/index.js";
import { Readiness } from "../health/readiness.js";
import { KubeApiError } from "../k8s/errors.js";
import { type FunctionEvent, FunctionSource } from "../k8s/functions.js";
import {
  type FunctionSpec,
  functionMetadataSchema,
  functionSpecSchema,
  functionStatusSchema,
} from "./schema.js";
import { type FunctionCeilings, type FunctionValidation, validateFunction } from "./validation.js";

export interface FunctionEntry {
  readonly name: string;
  readonly uid: string;
  readonly generation: number;
  readonly resourceVersion: string;
  readonly spec: FunctionSpec | undefined;
  readonly status: z.infer<typeof functionStatusSchema> | undefined;
  readonly result: FunctionValidation;
}
// Explicit scheduler-only port; gateway consumers keep the read-only service.
interface FunctionStatusCache {
  readonly all: Effect.Effect<readonly FunctionEntry[]>;
  readonly changes: Stream.Stream<void>;
  readonly getAny: (name: string) => Effect.Effect<FunctionEntry | undefined>;
}
interface Cache {
  readonly get: (name: string) => Effect.Effect<FunctionEntry | undefined>;
  readonly getAny: (name: string) => Effect.Effect<FunctionEntry | undefined>;
  readonly list: Effect.Effect<readonly FunctionEntry[]>;
  readonly synced: Effect.Effect<void>;
  readonly isSynced: Effect.Effect<boolean>;
}
export class Functions extends Context.Service<Functions, Cache>()("krun/Functions") {}
const metadataSchema = functionMetadataSchema.extend({
  namespace: functionMetadataSchema.shape.name,
  uid: z.string().min(1),
  generation: z.int().positive(),
  resourceVersion: z.string().min(1),
});
const objectSchema = z.looseObject({
  metadata: metadataSchema,
  spec: z.unknown(),
  status: z.unknown().optional(),
});
const queueSchema = functionSpecSchema.pick({ queueTimeout: true }).loose();
const freezeJson = <T>(value: T): T => {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (item !== null && typeof item === "object") {
      // Schema width is untrusted even when validation already returned SchemaTooLarge.
      // Push one child at a time: argument expansion can throw before isolation publishes.
      for (const child of Object.values(item)) stack.push(child);
      Object.freeze(item);
    }
  }
  return value;
};
const syncedGauge = Metric.gauge("krun_functions_synced");
const functionGauge = (ready: boolean) =>
  Metric.withAttributes(Metric.gauge("krun_functions"), { ready: String(ready) });

export const makeFunctions = (options: {
  readonly namespace: string;
  readonly ceilings: FunctionCeilings;
}) =>
  Effect.gen(function* () {
    const source = yield* FunctionSource;
    const readiness = yield* Readiness;
    const synced = yield* Deferred.make<void>();
    const isSynced = yield* Ref.make(false);
    const entries = yield* Ref.make<ReadonlyMap<string, FunctionEntry>>(new Map());
    const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    // Own the installation policy as well as event documents; caller mutation cannot change validation.
    const ceilings = freezeJson({
      ...options.ceilings,
      allowedRegistries: [...options.ceilings.allowedRegistries],
      allowedServiceAccounts: [...options.ceilings.allowedServiceAccounts],
      webhookAllowedHosts: [...options.ceilings.webhookAllowedHosts],
    });
    const publish = (map: ReadonlyMap<string, FunctionEntry>) =>
      Effect.gen(function* () {
        yield* Ref.set(entries, map);
        let valid = 0;
        for (const entry of map.values()) if (entry.result.ok) valid++;
        yield* Metric.update(functionGauge(true), valid);
        yield* Metric.update(functionGauge(false), map.size - valid);
        yield* PubSub.publish(changes, undefined);
      });
    const reset = Effect.gen(function* () {
      yield* publish(new Map());
      yield* Ref.set(isSynced, false);
      yield* Metric.update(syncedGauge, 0);
      yield* Ref.update(readiness.state, (state) => ({ ...state, functionsSynced: false }));
    });
    yield* reset;
    yield* Effect.addFinalizer(() => reset);
    const decode = (
      input: unknown,
      previous: ReadonlyMap<string, FunctionEntry>,
    ): FunctionEntry | undefined => {
      const object = objectSchema.parse(JSON.parse(JSON.stringify(input)));
      if (object.metadata.namespace !== options.namespace) return undefined;
      const { name, uid, generation, resourceVersion } = object.metadata;
      const before = previous.get(name);
      const status = functionStatusSchema.safeParse(object.status);
      const reuse = before?.uid === uid && before.generation === generation;
      const spec = functionSpecSchema.safeParse(object.spec);
      const parsed = reuse ? before.spec : spec.success ? spec.data : undefined;
      const queue = queueSchema.safeParse(object.spec);
      const timeout = queue.success ? durationToMilliseconds(queue.data.queueTimeout) : undefined;
      const result: FunctionValidation = reuse
        ? before.result
        : parsed === undefined
          ? {
              ok: false,
              reason: "SchemaInvalid",
              message: "spec: does not match the Function schema",
              ...(timeout === undefined ? {} : { queueTimeout: Duration.millis(timeout) }),
            }
          : validateFunction(parsed, ceilings);
      return Object.freeze({
        name,
        uid,
        generation,
        resourceVersion,
        spec: parsed === undefined ? undefined : freezeJson(parsed),
        status: status.success ? freezeJson(status.data) : undefined,
        result: Object.freeze(result),
      });
    };
    const apply = (event: FunctionEvent) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(entries);
        const next = yield* Effect.try({
          try: () => {
            if (event.type === "sync") {
              const map = new Map<string, FunctionEntry>();
              for (const object of event.items) {
                const entry = decode(object, current);
                if (entry !== undefined) map.set(entry.name, entry);
              }
              return map;
            }
            const map = new Map(current);
            if (event.type === "delete") {
              const object = z
                .looseObject({
                  metadata: metadataSchema.pick({ name: true, namespace: true, uid: true }),
                })
                .parse(event.object);
              if (
                object.metadata.namespace === options.namespace &&
                map.get(object.metadata.name)?.uid === object.metadata.uid
              )
                map.delete(object.metadata.name);
            } else {
              const entry = decode(event.object, current);
              if (entry !== undefined) map.set(entry.name, entry);
            }
            return map;
          },
          catch: () => new KubeApiError({ operation: "functions", reason: "invalid_response" }),
        });
        yield* publish(next);
        if (event.type === "sync") {
          yield* Ref.set(isSynced, true);
          yield* Metric.update(syncedGauge, 1);
          yield* Ref.update(readiness.state, (state) => ({ ...state, functionsSynced: true }));
          yield* Deferred.succeed(synced, undefined);
        }
      });
    const retry = Schedule.exponential("100 millis").pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.millis(Math.min(Duration.toMillis(duration), 30000))),
      ),
    );
    yield* Effect.forkScoped(
      source.watch(options.namespace).pipe(
        Stream.mapEffect(apply),
        Stream.tapError((error) =>
          Effect.logWarning("Function informer disconnected; retrying").pipe(
            Effect.annotateLogs({ reason: error.reason, status: error.status ?? 0 }),
          ),
        ),
        Stream.retry(retry),
        Stream.runDrain,
      ),
    );
    const getAny = (name: string) => Ref.get(entries).pipe(Effect.map((map) => map.get(name)));
    return {
      getAny,
      get: (name) =>
        getAny(name).pipe(Effect.map((entry) => (entry?.result.ok ? entry : undefined))),
      list: Ref.get(entries).pipe(
        Effect.map((map) =>
          Object.freeze(
            [...map.values()]
              .filter((entry) => entry.result.ok)
              .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          ),
        ),
      ),
      synced: Deferred.await(synced),
      isSynced: Ref.get(isSynced),
      status: {
        all: Deferred.await(synced).pipe(
          Effect.andThen(Ref.get(entries)),
          Effect.map((map) =>
            Object.freeze([...map.values()].sort((a, b) => a.name.localeCompare(b.name))),
          ),
        ),
        changes: Stream.fromPubSub(changes),
        getAny,
      },
    } satisfies Cache & { readonly status: FunctionStatusCache };
  });

export const FunctionsLive = Layer.effect(
  Functions,
  Effect.gen(function* () {
    const { config } = yield* KrunConfig;
    return yield* makeFunctions({
      namespace: config.KRUN_NAMESPACE,
      ceilings: {
        maxActiveDeadline: config.KRUN_MAX_ACTIVE_DEADLINE,
        maxQueued: config.KRUN_MAX_QUEUED,
        allowedRegistries: config.KRUN_ALLOWED_REGISTRIES,
        allowedServiceAccounts: config.KRUN_ALLOWED_SERVICE_ACCOUNTS,
        webhookAllowedHosts: config.KRUN_WEBHOOK_ALLOWED_HOSTS,
      },
    });
  }),
);
