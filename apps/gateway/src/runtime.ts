import { KeysLive } from "@krun/shared/dist/auth/keys.js";
import { ConfigInvalid, ConfigLive, KrunConfig } from "@krun/shared/dist/config/index.js";
import { FunctionsLive } from "@krun/shared/dist/functions/cache.js";
import { AdminServerLive } from "@krun/shared/dist/health/index.js";
import { Readiness, ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { KubeConnectionLive } from "@krun/shared/dist/k8s/config.js";
import { FunctionSourceLive } from "@krun/shared/dist/k8s/functions.js";
import { DatabasePostgres, DatabaseSqlite } from "@krun/shared/dist/runtime/database.js";
import {
  LogDestination,
  loggingOptions,
  withPinoLogger,
} from "@krun/shared/dist/runtime/logging.js";
import { makeObjectStore } from "@krun/shared/dist/runtime/object-store.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreLive } from "@krun/shared/dist/store/live.js";
import { DnsLookupLive } from "@krun/shared/dist/webhook/index.js";
import { Cause, Data, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect";
import Fastify, { type FastifyInstance } from "fastify";
import { makePublicApp } from "./app.js";
import { cancelRunRoutes } from "./cancel-run-routes.js";
import { createRunRoutes } from "./create-run-routes.js";
import { functionReadRoutes } from "./function-routes.js";
import { makeInternalApp } from "./internal-app.js";
import { runReadRoutes } from "./run-read-routes.js";
import { runResultRoutes } from "./run-result-routes.js";
import { GatewayShutdown, GatewayShutdownLive } from "./shutdown.js";

class GatewayStartupError extends Data.TaggedError("GatewayStartupError")<{
  readonly operation: "role" | "public_listen" | "internal_listen";
}> {}
const listen = Effect.fnUntraced(function* (
  app: FastifyInstance,
  address: string,
  operation: "public_listen" | "internal_listen",
) {
  const parsed = /^(.*):([0-9]+)$/.exec(address);
  const port = parsed ? Number(parsed[2]) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    return yield* new GatewayStartupError({ operation });
  yield* Effect.tryPromise({
    try: () => app.listen({ host: (parsed?.[1] || "0.0.0.0").replace(/^\[|\]$/g, ""), port }),
    catch: () => new GatewayStartupError({ operation }),
  });
});

// One memoized service graph per process, never per request/listener. The
// supplied scope owns every resource even if construction only partly succeeds.
const gateway = Layer.unwrap(
  Effect.gen(function* () {
    const configuration = yield* KrunConfig;
    if (configuration.role !== "gateway")
      return yield* new GatewayStartupError({ operation: "role" });
    const config = configuration.config;
    if (config.KRUN_DB_MODE === "postgres" && config.KRUN_DB_DSN === undefined)
      return yield* new ConfigInvalid({ variable: "KRUN_DB_DSN" });
    const database =
      config.KRUN_DB_MODE === "embedded"
        ? DatabaseSqlite(config.KRUN_DB_PATH)
        : DatabasePostgres(config.KRUN_DB_DSN ?? "");
    const objectStore = yield* makeObjectStore(config);
    const store = StoreLive.pipe(Layer.provideMerge(database));
    const readiness = Layer.unwrap(
      Effect.map(Store, (store) => ReadinessLive(store.countByState().pipe(Effect.asVoid))),
    );
    const functions = FunctionSourceLive.pipe(Layer.provide(KubeConnectionLive));
    const services = Layer.mergeAll(FunctionsLive, KeysLive, GatewayShutdownLive).pipe(
      Layer.provideMerge(functions),
      Layer.provideMerge(readiness),
      Layer.provideMerge(store),
    );
    const publicServer = Layer.effectDiscard(
      Effect.gen(function* () {
        const create = yield* createRunRoutes(config).pipe(Effect.provide(DnsLookupLive));
        const app = yield* makePublicApp({
          routes: async (server) => {
            server.register(functionReadRoutes(config));
            server.register(create);
            server.register(runReadRoutes);
            server.register(cancelRunRoutes);
            server.register(runResultRoutes(objectStore));
          },
        });
        yield* listen(app, config.KRUN_LISTEN_ADDR, "public_listen");
      }),
    );
    const internalServer = Layer.effectDiscard(
      Effect.gen(function* () {
        const app = yield* makeInternalApp({ maxResultBytes: config.KRUN_MAX_RESULT_BYTES });
        yield* listen(app, config.KRUN_INTERNAL_LISTEN_ADDR, "internal_listen");
      }),
    );
    const drain = Layer.effectDiscard(
      Effect.gen(function* () {
        const store = yield* Store;
        const readiness = yield* Readiness;
        const shutdown = yield* GatewayShutdown;
        // Migrations are an explicit init/hook operation (SPEC13), never a racing
        // serving replica side effect. Refuse readiness on an unusable schema.
        yield* store.countByState();
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            yield* Ref.update(readiness.state, (state) => ({ ...state, draining: true }));
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
              yield* Effect.sleep(config.KRUN_SHUTDOWN_DELAY);
            yield* shutdown.finish.pipe(Effect.orDie);
          }),
        );
        yield* Ref.update(readiness.state, (state) => ({ ...state, ready: true }));
        yield* Effect.logInfo("Gateway listeners started");
      }),
    );
    return drain.pipe(
      Layer.provideMerge(Layer.mergeAll(publicServer, internalServer, AdminServerLive)),
      Layer.provide(services),
    );
  }),
);

export const GatewayProcessLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* KrunConfig;
    const destination = yield* LogDestination;
    const logger = yield* Effect.acquireRelease(
      Effect.sync(() => Fastify({ logger: loggingOptions(config.KRUN_LOG_LEVEL, destination) })),
      (holder) => Effect.promise(() => holder.close()).pipe(Effect.orDie),
    );
    let watchdog: Fiber.Fiber<never> | undefined;
    yield* Effect.addFinalizer(() => (watchdog ? Fiber.interrupt(watchdog) : Effect.void));
    const arm = Effect.gen(function* () {
      watchdog = yield* Effect.forkDetach(
        Effect.sleep("25 seconds").pipe(
          Effect.andThen(Effect.logFatal("Gateway shutdown grace exceeded")),
          Effect.andThen(Effect.sync(() => process.exit(1))),
        ),
        { uninterruptible: false },
      );
    });
    // Register cleanup BEFORE building the graph. This arms the same watchdog on
    // partial startup failure as on SIGTERM and keeps telemetry alive until last.
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      withPinoLogger(arm.pipe(Effect.andThen(Scope.close(scope, exit))), logger.log),
    );
    yield* withPinoLogger(
      Layer.buildWithScope(gateway.pipe(Layer.provide(TelemetryLive())), scope),
      logger.log,
    );
  }),
).pipe(Layer.provide(ConfigLive("gateway")));
