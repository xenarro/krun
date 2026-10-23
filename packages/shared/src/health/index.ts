import { Context, Data, Effect, Exit, Layer } from "effect";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { KrunConfig } from "../config/index.js";
import { MetricsReader } from "./metrics.js";
import { Readiness } from "./readiness.js";

export class AdminServerError extends Data.TaggedError("AdminServerError")<{
  readonly operation: "register" | "listen";
}> {}

const healthPlugin = Effect.gen(function* () {
  const readiness = yield* Readiness;
  const metrics = yield* MetricsReader;
  // Preserve the owning fiber's services, including TestClock, at the Fastify
  // callback boundary. A fresh runPromise here would lose the injected clock.
  const context = yield* Effect.context();
  const run = Effect.runPromiseWith(context);
  const plugin: FastifyPluginAsync = async (app) => {
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async (_request, reply) => {
      const result = await run(readiness.check);
      return reply.code(result.status === "ok" ? 200 : 503).send(result);
    });
    app.get("/metrics", async (_request, reply) => {
      const result = await run(Effect.exit(metrics.scrape));
      if (Exit.isFailure(result)) return reply.code(503).send({ status: "unavailable" });
      return reply.type(result.value.contentType).send(result.value.body);
    });
  };
  return plugin;
});

// Separate from every public/internal Fastify instance. Importing this module
// opens nothing; the owning Effect scope registers and closes the app.
export const makeHealthApp = Effect.gen(function* () {
  const plugin = yield* healthPlugin;
  const app = yield* Effect.acquireRelease(
    Effect.sync(() => Fastify({ logger: false })),
    (app) => Effect.promise(() => app.close()).pipe(Effect.ignoreCause),
  );
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ status: "unavailable" }));
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
