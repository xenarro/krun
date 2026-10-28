import {
  ConfigInvalid,
  ConfigLive,
  KrunConfig,
  type SchedulerConfig,
} from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
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
import { Data, Effect, Exit, Fiber, Layer, Ref, Schedule, Scope } from "effect";
import Fastify from "fastify";
import { makeDeliveriesLoop } from "./deliveries-loop.js";
import { makeFunctionStatusWriter } from "./function-status.js";
import { makeHeartbeatLoop } from "./heartbeat-loop.js";
import { makeJobController } from "./job-controller.js";
import { JobPodSource, makeJobPodSource } from "./k8s/informers.js";
import { KubeLive } from "./k8s/kube.js";
import { runLeaderElection } from "./k8s/leader-election.js";
import { LeaseApiLive } from "./k8s/lease-api.js";
import { makeMainLoop } from "./main-loop.js";
import { checkObjectResult } from "./object-storage.js";
import { makeSweepLoop } from "./sweep-loop.js";

class SchedulerStartupError extends Data.TaggedError("SchedulerStartupError")<{
  readonly operation: "role";
}> {}

const leader = (
  config: SchedulerConfig,
  podName: string,
  cache: Effect.Success<ReturnType<typeof makeFunctions>>,
  objectStore: Effect.Success<ReturnType<typeof makeObjectStore>>,
) =>
  Effect.gen(function* () {
    const source = yield* makeJobPodSource(config.KRUN_JOBS_NAMESPACE);
    yield* Effect.gen(function* () {
      const controller = yield* makeJobController({
        namespace: config.KRUN_JOBS_NAMESPACE,
        maxRunning: config.KRUN_MAX_RUNNING,
        checkResult: checkObjectResult(objectStore),
      });
      const main = yield* makeMainLoop({
        owner: podName,
        config,
        objectStore,
        replayCached: controller.replayCached,
        checkLost: controller.checkLost,
      });
      const heartbeat = yield* makeHeartbeatLoop({ controller });
      const deliveries = yield* makeDeliveriesLoop(config);
      const sweep = yield* makeSweepLoop({
        namespace: config.KRUN_JOBS_NAMESPACE,
        retention: config.KRUN_RETENTION,
      });
      const status = yield* makeFunctionStatusWriter({
        namespace: config.KRUN_NAMESPACE,
        cache: cache.status,
      });
      yield* Effect.all(
        [
          source.ready.pipe(Effect.andThen(cache.synced), Effect.andThen(main.run)),
          controller.run,
          heartbeat.run,
          deliveries.run,
          sweep.run,
          status.run,
          status.reconcile.pipe(Effect.repeat(Schedule.spaced("5 minutes"))),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.provideService(JobPodSource, source), Effect.provideService(Functions, cache));
  });

const scheduler = Effect.gen(function* () {
  const configuration = yield* KrunConfig;
  if (configuration.role !== "scheduler")
    return yield* new SchedulerStartupError({ operation: "role" });
  const config = configuration.config;
  const podName = config.KRUN_POD_NAME;
  if (podName === undefined) return yield* new ConfigInvalid({ variable: "KRUN_POD_NAME" });
  const database =
    config.KRUN_DB_MODE === "embedded"
      ? DatabaseSqlite(config.KRUN_DB_PATH)
      : DatabasePostgres(config.KRUN_DB_DSN ?? "");
  const store = StoreLive.pipe(Layer.provideMerge(database));
  const readiness = Layer.unwrap(
    Effect.map(Store, (store) => ReadinessLive(store.countByState().pipe(Effect.asVoid))),
  );
  const services = Layer.mergeAll(KubeLive, LeaseApiLive, FunctionSourceLive, DnsLookupLive).pipe(
    Layer.provideMerge(KubeConnectionLive),
    Layer.provideMerge(readiness),
    Layer.provideMerge(store),
    Layer.provideMerge(TelemetryLive()),
  );
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
        Effect.andThen(Effect.logFatal("Scheduler shutdown grace exceeded")),
        Effect.andThen(Effect.sync(() => process.exit(1))),
      ),
      { uninterruptible: false },
    );
  });
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
    withPinoLogger(arm.pipe(Effect.andThen(Scope.close(scope, exit))), logger.log),
  );
  yield* withPinoLogger(
    Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(services, scope);
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const objectStore = yield* makeObjectStore(config, config.KRUN_MAX_ACTIVE_DEADLINE);
        const readiness = yield* Readiness;
        // Fail startup on an unmigrated schema; serving replicas never migrate it.
        yield* store.countByState();
        const functionScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
          Scope.close(scope, exit),
        );
        const cache = yield* makeFunctions({
          namespace: config.KRUN_NAMESPACE,
          ceilings: {
            maxActiveDeadline: config.KRUN_MAX_ACTIVE_DEADLINE,
            maxQueued: config.KRUN_MAX_QUEUED,
            allowedRegistries: config.KRUN_ALLOWED_REGISTRIES,
            allowedServiceAccounts: config.KRUN_ALLOWED_SERVICE_ACCOUNTS,
            webhookAllowedHosts: config.KRUN_WEBHOOK_ALLOWED_HOSTS,
          },
        }).pipe(Effect.provideService(Scope.Scope, functionScope));
        yield* Layer.build(AdminServerLive);
        const election = yield* Effect.forkScoped(
          runLeaderElection(
            { namespace: config.KRUN_NAMESPACE, podName },
            leader(config, podName, cache, objectStore),
            Scope.close(functionScope, Exit.void),
          ),
          { uninterruptible: false },
        );
        yield* Effect.addFinalizer(() =>
          Ref.update(readiness.state, (state) => ({ ...state, draining: true })),
        );
        yield* Ref.update(readiness.state, (state) => ({ ...state, ready: true }));
        yield* Effect.logInfo("Scheduler admin listener started");
        // Joining, not fire-and-forget: leader loss and elected-work failures reach
        // the process edge while all resources retain their owned release order.
        return yield* Fiber.join(election);
      }).pipe(Effect.provide(context), Effect.provideService(Scope.Scope, scope));
    }),
    logger.log,
  );
});

export const SchedulerProcessLive: Layer.Layer<never, unknown> = Layer.effectDiscard(
  scheduler,
).pipe(Layer.provide(ConfigLive("scheduler")));
