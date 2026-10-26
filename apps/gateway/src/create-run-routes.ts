import { Transform } from "node:stream";
import { durationToMilliseconds } from "@krun/shared/dist/config/duration.js";
import type { GatewayConfig } from "@krun/shared/dist/config/index.js";
import type { FunctionEntry } from "@krun/shared/dist/functions/cache.js";
import { Store, toRun } from "@krun/shared/dist/store/index.js";
import { requestHash } from "@krun/shared/dist/store/request-hash.js";
import { newRunId } from "@krun/shared/dist/store/run-id.js";
import { DnsLookup, makeWebhookPolicy, resolveAndCheck } from "@krun/shared/dist/webhook/index.js";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Metric,
  Option,
  Queue,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError, errorEnvelope } from "./errors.js";
import { publicContracts, publicSchemas } from "./public-contracts.js";
import { GatewayShutdown } from "./shutdown.js";

type Config = Pick<
  GatewayConfig,
  | "KRUN_MAX_INPUT_BYTES"
  | "KRUN_MAX_WAIT"
  | "KRUN_RATE_LIMIT_RPS"
  | "KRUN_RATE_LIMIT_BURST"
  | "KRUN_WEBHOOK_ALLOWED_HOSTS"
  | "KRUN_WEBHOOK_ALLOWED_CIDRS"
>;
const rejections = Metric.counter("krun_admission_rejections_total", { incremental: true });
const reject = (reason: "rate_limit" | "max_queued" | "input_size" | "schema") =>
  Metric.update(Metric.withAttributes(rejections, { reason }), 1);
const terminal = (state: string) =>
  state === "succeeded" || state === "failed" || state === "cancelled";

// Acquire in the same owning scope as Store/Keys/Functions and the eventual app.
// The plugin imports no ambient configuration and creates no listener or process.
export const createRunRoutes = (input: Config) =>
  Effect.gen(function* () {
    const observe = Effect.runSyncWith(yield* Effect.context());
    const store = yield* Store;
    const shutdown = yield* Effect.serviceOption(GatewayShutdown);
    const dns = yield* DnsLookup;
    const policy = yield* makeWebhookPolicy(input);
    const config = {
      maxBytes: input.KRUN_MAX_INPUT_BYTES,
      maxWait: Duration.toMillis(input.KRUN_MAX_WAIT),
      rps: input.KRUN_RATE_LIMIT_RPS,
      burst: input.KRUN_RATE_LIMIT_BURST,
    };
    const buckets = new Map<string, { at: number; tokens: number }>();
    const locks = new Map<string, Semaphore.Semaphore>();
    const waiters = new Map<string, Set<Queue.Queue<void>>>();
    const register = (id: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<void>(1);
          const group = waiters.get(id) ?? new Set<Queue.Queue<void>>();
          group.add(queue);
          waiters.set(id, group);
          return queue;
        }),
        (queue) =>
          Effect.sync(() => {
            const group = waiters.get(id);
            group?.delete(queue);
            if (group?.size === 0) waiters.delete(id);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
      );
    // Exactly one consumer per owned plugin; hints coalesce and never replace a DB read.
    const notifier = yield* store.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.forEach(waiters.get(event.id) ?? [], (queue) => Queue.offer(queue, undefined), {
          discard: true,
        }),
      ),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        buckets.clear();
        locks.clear();
        waiters.clear();
      }),
    );
    const wait = (id: string, queue: Queue.Queue<void>, millis: number) =>
      Effect.gen(function* () {
        const watch = Effect.gen(function* () {
          while (!terminal((yield* store.getRun(id)).state))
            yield* Effect.raceFirst(Queue.take(queue), Effect.sleep("1 second"));
        });
        yield* Effect.raceFirst(
          Effect.raceFirst(watch, Effect.sleep(Duration.millis(millis))),
          Option.isSome(shutdown) ? shutdown.value.closing : Effect.never,
        );
        return yield* store.getRun(id);
      });
    const consume = (name: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const bucket = buckets.get(name) ?? { at: now, tokens: config.burst };
        bucket.tokens = Math.min(
          config.burst,
          bucket.tokens + (Math.max(0, now - bucket.at) * config.rps) / 1000,
        );
        bucket.at = now;
        buckets.set(name, bucket);
        if (bucket.tokens < 1) {
          yield* reject("rate_limit");
          return yield* new ApiError({ reason: "RATE_LIMITED" });
        }
        bucket.tokens--;
      });
    const entries = new WeakMap<FastifyRequest, FunctionEntry>();
    const plugin: FastifyPluginAsync = async (app) => {
      // Native JSON.parse retains opaque own keys without assigning prototypes.
      // Unknown/null krun-owned members are still rejected by the strict Zod root.
      app.removeContentTypeParser("application/json");
      app.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        app.getDefaultJsonParser("ignore", "ignore"),
      );
      app.addHook("onClose", async () => {
        await Effect.runPromise(Fiber.interrupt(notifier));
      });
      app.withTypeProvider<ZodTypeProvider>().route({
        ...publicContracts.CreateRun,
        // Defer Function/glob checks until after this method's rate admission.
        config: { krun: { scope: "runs:write" } },
        bodyLimit: Math.max(1, config.maxBytes),
        onRequest: async (request, reply) => {
          await app.runEffect(
            request,
            reply,
            Effect.gen(function* () {
              const key = request.principal;
              if (!key) return yield* new ApiError({ reason: "INTERNAL" });
              yield* consume(key.name);
              if (!(yield* app.functions.isSynced))
                return yield* new ApiError({ reason: "NOT_READY" });
              const entry = yield* app.functions.get(request.params.function);
              if (!entry?.result.ok || !entry.spec || !key.allowsFunction(request.params.function))
                return yield* new ApiError({ reason: "FUNCTION_NOT_FOUND" });
              entries.set(request, entry);
            }),
          );
        },
        preParsing: async (request, _reply, payload) => {
          const length = request.headers["content-length"];
          if (length !== undefined && Number(length) > config.maxBytes)
            throw new ApiError({ reason: "INPUT_TOO_LARGE" });
          let bytes = 0;
          const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > config.maxBytes) done(new ApiError({ reason: "INPUT_TOO_LARGE" }));
              else done(null, chunk);
            },
          });
          Object.defineProperty(counted, "receivedEncodedLength", { get: () => bytes });
          payload.on("error", (error) => counted.destroy(error));
          return payload.pipe(counted);
        },
        onError: async (_request, _reply, error) => {
          if (errorEnvelope(error).error.details[0]?.reason === "INPUT_TOO_LARGE")
            observe(reject("input_size"));
        },
        handler: async (request, reply) =>
          app.runEffect(
            request,
            reply,
            Effect.scoped(
              Effect.gen(function* () {
                const key = request.principal,
                  entry = entries.get(request);
                if (!key || !entry?.result.ok || !entry.spec)
                  return yield* new ApiError({ reason: "INTERNAL" });
                const spec = entry.spec,
                  validator = entry.result.validate;
                if (request.body.priority > 0 && !key.hasScope("runs:priority"))
                  return yield* new ApiError({
                    reason: "SCOPE_MISSING",
                    metadata: { scope: "runs:priority" },
                  });
                const fingerprint = yield* requestHash({
                  input: request.body.input,
                  priority: request.body.priority,
                  ...(request.body.callback === undefined
                    ? {}
                    : { callback: request.body.callback }),
                }).pipe(Effect.mapError(() => new ApiError({ reason: "REQUEST_INVALID" })));
                const requested =
                  request.query.wait === undefined ? 0 : durationToMilliseconds(request.query.wait);
                if (requested === undefined)
                  return yield* new ApiError({ reason: "REQUEST_INVALID" });
                const millis = Math.min(requested, config.maxWait);
                // Own the response before lock acquisition or any durable work,
                // including replays and non-waiting admission. Shutdown seals
                // registration before its snapshot and keeps the Store alive
                // until accepted responses settle. Real disconnects still abort.
                if (Option.isSome(shutdown) && !shutdown.value.track(reply.raw))
                  return yield* new ApiError({ reason: "NOT_READY" });
                const lock = yield* Effect.sync(() => {
                  let current = locks.get(entry.name);
                  if (!current) {
                    current = Semaphore.makeUnsafe(1);
                    locks.set(entry.name, current);
                  }
                  return current;
                });
                const admitted = yield* lock.withPermit(
                  Effect.gen(function* () {
                    const previous =
                      request.query.requestId === undefined
                        ? undefined
                        : yield* store.findRunByRequestId(
                            entry.name,
                            key.name,
                            request.query.requestId,
                          );
                    if (previous) {
                      if (previous.request_hash !== fingerprint)
                        return yield* new ApiError({ reason: "IDEMPOTENCY_CONFLICT" });
                      const queue = millis > 0 ? yield* register(previous.id) : undefined;
                      return { run: previous, created: false, queue };
                    }
                    if (!validator(request.body.input)) {
                      const violations = (validator.errors ?? []).map((error) => ({
                        field:
                          "input" +
                          error.instancePath
                            .split("/")
                            .slice(1)
                            .map((part) => "." + part.replace(/~1/g, "/").replace(/~0/g, "~"))
                            .join(""),
                        description: error.message ?? "Input is invalid",
                      }));
                      yield* reject("schema");
                      return yield* new ApiError({
                        reason: "INPUT_SCHEMA_VIOLATION",
                        metadata: { function: entry.name },
                        fieldViolations: violations,
                      });
                    }
                    const callback = request.body.callback?.url ?? spec.callback?.url;
                    if (callback !== undefined)
                      yield* resolveAndCheck(callback, policy).pipe(
                        Effect.provideService(DnsLookup, dns),
                        Effect.mapError(
                          () =>
                            new ApiError({
                              reason: "CALLBACK_NOT_ALLOWED",
                              fieldViolations: [
                                { field: "callback.url", description: "Callback is not allowed" },
                              ],
                            }),
                        ),
                      );
                    if ((yield* store.countQueued(entry.name)) >= spec.maxQueued) {
                      yield* reject("max_queued");
                      return yield* new ApiError({
                        reason: "QUEUE_FULL",
                        metadata: { limit: "function" },
                      });
                    }
                    if (
                      key.maxQueued !== undefined &&
                      (yield* store.countQueuedBy(entry.name, key.name)) >= key.maxQueued
                    ) {
                      yield* reject("max_queued");
                      return yield* new ApiError({
                        reason: "QUEUE_FULL",
                        metadata: { limit: "key" },
                      });
                    }
                    const at = yield* DateTime.now,
                      id = yield* newRunId(at);
                    // Registration precedes the only mutation. Store owns uninterruptible DB commit/release.
                    const ownQueue = millis > 0 ? yield* register(id) : undefined;
                    const result = yield* store.createRun({
                      id,
                      idempotency_key: request.query.requestId ?? null,
                      request_hash: fingerprint,
                      function_name: entry.name,
                      input: request.body.input,
                      priority: request.body.priority,
                      callback_url: callback ?? null,
                      created_by: key.name,
                      created_at: at,
                    });
                    const queue =
                      millis > 0 && result.run.id !== id
                        ? yield* register(result.run.id)
                        : ownQueue;
                    return { ...result, queue };
                  }),
                );
                Reflect.set(request, "audit", {
                  run_id: admitted.run.id,
                  function: admitted.run.function_name,
                  ...(request.query.requestId === undefined
                    ? {}
                    : { idempotency_key: request.query.requestId }),
                });
                const row = admitted.queue
                  ? yield* wait(admitted.run.id, admitted.queue, millis)
                  : admitted.run;
                const resource = toRun(row);
                reply.code(201).header("Location", `/v1/${resource.name}`);
                if (!admitted.created) reply.header("Idempotent-Replay", "true");
                return publicSchemas.Run.parse(resource);
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ApiError
                    ? error
                    : new ApiError({
                        reason:
                          error._tag === "ConflictError" ? "IDEMPOTENCY_CONFLICT" : "INTERNAL",
                      }),
                ),
              ),
            ),
          ),
      });
    };
    return plugin;
  });
