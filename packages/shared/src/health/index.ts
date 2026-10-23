import { Context, Data, Effect, Exit, Layer, Ref } from "effect";
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { KrunConfig } from "../config/index.js";
import { MetricsReader } from "./metrics.js";
import { Readiness } from "./readiness.js";

export class AdminServerError extends Data.TaggedError("AdminServerError")<{
  readonly operation: "register" | "listen";
}> {}

class AdminRequestClosed extends Data.TaggedError("AdminRequestClosed") {}

const healthPlugin = Effect.gen(function* () {
  const readiness = yield* Readiness;
  const metrics = yield* MetricsReader;
  // Preserve the owning fiber's services, including TestClock, at the Fastify
  // callback boundary. Track roots separately from their captured context.
  const context = yield* Effect.context();
  const run = Effect.runPromiseWith(context);
  const active = new Map<AbortController, Promise<unknown>>();
  let stopping = false;
  const runRequest = async <A, E>(
    request: FastifyRequest,
    reply: FastifyReply,
    effect: Effect.Effect<A, E>,
  ): Promise<A> => {
    if (stopping) throw new AdminRequestClosed();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!reply.raw.writableFinished) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    // Register before starting the root, even if its first action wakes shutdown.
    const pending = Promise.resolve().then(() => run(effect, { signal: controller.signal }));
    active.set(controller, pending);
    try {
      return await pending;
    } catch (error) {
      if (controller.signal.aborted) throw new AdminRequestClosed();
      throw error;
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
      active.delete(controller);
    }
  };
  const stop = Effect.promise(async () => {
    stopping = true;
    const pending = [...active.values()];
    for (const controller of active.keys()) controller.abort();
    // Settle cancellation/finalizers before the listener's dependencies close.
    await Promise.allSettled(pending);
  });
  const plugin: FastifyPluginAsync = async (app) => {
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async (request, reply) => {
      const result = await runRequest(request, reply, readiness.check);
      return reply.code(result.status === "ok" ? 200 : 503).send(result);
    });
    app.get("/metrics", async (request, reply) => {
      const result = await runRequest(request, reply, Effect.exit(metrics.scrape));
      if (Exit.isFailure(result)) return reply.code(503).send({ status: "unavailable" });
      return reply.type(result.value.contentType).send(result.value.body);
    });
  };
  return { plugin, stop };
});

// Separate from every public/internal Fastify instance. Importing this module
// opens nothing; the owning Effect scope registers and closes the app.
export const makeHealthApp = Effect.gen(function* () {
  const readiness = yield* Readiness;
  const { plugin, stop } = yield* healthPlugin;
  const app = yield* Effect.acquireRelease(
    Effect.sync(() => Fastify({ logger: false })),
    (app) =>
      Effect.gen(function* () {
        yield* Ref.update(readiness.state, (state) => ({ ...state, draining: true }));
        yield* stop;
        yield* Effect.promise(() => app.close()).pipe(Effect.ignoreCause);
      }),
  );
  app.setErrorHandler((error, request, reply) => {
    const closed = error instanceof AdminRequestClosed;
    const body =
      closed && request.routeOptions.url === "/readyz"
        ? { status: "unavailable", leader: Ref.getUnsafe(readiness.state).leader }
        : { status: "unavailable" };
    return reply.code(closed ? 503 : 500).send(body);
  });
  app.register(plugin);
  yield* Effect.tryPromise({
    try: () => app.ready(),
    catch: () => new AdminServerError({ operation: "register" }),
  });
  return app;
});

export class AdminServer extends Context.Service<AdminServer, { readonly app: FastifyInstance }>()(
  "krun/AdminServer",
) {}

export const AdminServerLive = Layer.effect(
  AdminServer,
  Effect.gen(function* () {
    const { config } = yield* KrunConfig;
    const app = yield* makeHealthApp;
    const address = config.KRUN_ADMIN_LISTEN_ADDR.match(/^(.*):([0-9]+)$/);
    const host = address?.[1] || "0.0.0.0";
    const port = Number(address?.[2]);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      return yield* Effect.fail(new AdminServerError({ operation: "listen" }));
    }
    yield* Effect.tryPromise({
      try: () => app.listen({ host: host.replace(/^\[|\]$/g, ""), port }),
      catch: () => new AdminServerError({ operation: "listen" }),
    });
    return { app };
  }),
);
