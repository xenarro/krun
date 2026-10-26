import { randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { z } from "zod";
import { makePublicApp } from "../../../../apps/gateway/src/app.js";
import { createRunRoutes } from "../../../../apps/gateway/src/create-run-routes.js";
import { makeJobController } from "../../../../apps/scheduler/src/job-controller.js";
import { JobPodSource, makeJobPodSource } from "../../../../apps/scheduler/src/k8s/informers.js";
import { Kube, makeKube } from "../../../../apps/scheduler/src/k8s/kube.js";
import { makeMainLoop } from "../../../../apps/scheduler/src/main-loop.js";
import { startJobKube } from "../../../../test/fake-kube/jobs.js";
import { Keys, makeKeys } from "../auth/keys.js";
import { ConfigLive, parseGatewayConfig, parseSchedulerConfig } from "../config/index.js";
import { Functions } from "../functions/cache.js";
import { functionResourceSchema } from "../functions/schema.js";
import { validateFunction } from "../functions/validation.js";
import { makeHealthApp } from "../health/index.js";
import { ReadinessLive } from "../health/readiness.js";
import { KubeConnection, makeKubeConnection } from "../k8s/config.js";
import { Store } from "../store/index.js";
import { StoreSqlite } from "../store/live.js";
import { DnsLookup } from "../webhook/index.js";
import { TelemetryLive } from "./telemetry.js";

it.effect(
  "P4.6 native fake Job lifecycle exposes exact leader metrics and correlates create/per-run/Kube spans",
  () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const namespace = "krun-test-p46-jobs";
    const configLayer = ConfigLive("scheduler", {
      env: {
        KRUN_DB_MODE: "embedded",
        KRUN_NAMESPACE: namespace,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-collector.invalid",
        OTEL_TRACES_SAMPLER: "always_on",
        KRUN_LOG_LEVEL: "error",
      },
    });
    const telemetry = TelemetryLive(() => processor).pipe(Layer.provide(configLayer));
    return Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* Effect.acquireRelease(
          Effect.promise(() => startJobKube(namespace)),
          (fake) => Effect.promise(() => fake.close()),
        );
        const connection = yield* makeKubeConnection({
          load: (c) =>
            c.loadFromClusterAndUser(
              { name: "krun-test-p46", server: fake.address, skipTLSVerify: true },
              { name: "krun-test-p46" },
            ),
        });
        const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
        const source = yield* makeJobPodSource(namespace).pipe(
          Effect.provideService(KubeConnection, connection),
        );
        yield* source.ready;
        yield* Effect.promise(() => fake.watching);
        const actual = yield* Store;
        yield* actual.migrate();
        const running = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        const store: Store["Service"] = {
          ...actual,
          transition: (...args) =>
            actual
              .transition(...args)
              .pipe(
                Effect.tap((changed) =>
                  changed && args[2] === "running"
                    ? Deferred.succeed(running, undefined)
                    : changed && args[2] === "succeeded"
                      ? Deferred.succeed(complete, undefined)
                      : Effect.void,
                ),
              ),
        };
        const resource = functionResourceSchema.parse({
          apiVersion: "krun.io/v1alpha1",
          kind: "Function",
          metadata: { name: "echo" },
          spec: {
            image: `example.invalid/echo@sha256:${"a".repeat(64)}`,
            inputSchema: { type: "object" },
          },
        });
        const entry = {
          name: "echo",
          uid: "owned",
          generation: 1,
          resourceVersion: "1",
          spec: resource.spec,
          status: undefined,
          result: validateFunction(resource.spec, {
            maxActiveDeadline: 86400,
            maxQueued: 1000,
            allowedRegistries: [],
            allowedServiceAccounts: ["krun-job-default"],
            webhookAllowedHosts: [],
          }),
        };
        const functions: Functions["Service"] = {
          get: () => Effect.succeed(entry),
          getAny: () => Effect.succeed(entry),
          list: Effect.succeed([entry]),
          synced: Effect.void,
          isSynced: Effect.succeed(true),
        };
        const token = randomBytes(32).toString("hex");
        const keys = yield* makeKeys({
          path: "krun-test-p46-memory",
          read: Effect.succeed(
            Buffer.from(
              JSON.stringify({
                keys: [{ name: "creator", key: token, scopes: ["runs:write"], functions: ["*"] }],
              }),
            ),
          ),
        });
        const gatewayConfig = yield* parseGatewayConfig({
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: namespace,
        });
        const routes = yield* createRunRoutes(gatewayConfig).pipe(
          Effect.provideService(DnsLookup, { lookup: () => Effect.succeed([]) }),
        );
        const app = yield* makePublicApp({ routes }).pipe(
          Effect.provideService(Keys, keys),
          Effect.provideService(Functions, functions),
        );
        const admin = yield* makeHealthApp;
        const response = yield* Effect.promise(() =>
          app.inject({
            method: "POST",
            url: "/v1/functions/echo/runs",
            headers: {
              authorization: `Bearer ${token}`,
              traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
            },
            payload: { input: { private: "krun-test-p46-private-input" } },
          }),
        );
        expect(response.statusCode).toBe(201);
        const name = z.object({ name: z.string() }).parse(response.json()).name;
        const id = z.string().parse(name.split("/").at(-1));
        const controller = yield* makeJobController({
          namespace,
          maxRunning: 10,
          checkResult: () => Effect.succeed(null),
        }).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Kube, kube),
          Effect.provideService(JobPodSource, source),
        );
        const schedulerConfig = yield* parseSchedulerConfig({
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: namespace,
          KRUN_JOBS_NAMESPACE: namespace,
        });
        const loop = yield* makeMainLoop({
          owner: "krun-test-p46-leader",
          config: schedulerConfig,
          replayCached: controller.replayCached,
          checkLost: controller.checkLost,
        }).pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Kube, kube),
          Effect.provideService(Functions, functions),
        );
        const consumer = yield* Effect.forkScoped(
          Effect.all(
            [
              Stream.runForEach(source.jobEvents, (event) => controller.handle(event.id, event)),
              Stream.runForEach(source.podEvents, (event) => controller.handle(event.id, event)),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* TestClock.adjust("2 seconds");
        yield* loop.iterate;
        expect((yield* actual.getRun(id)).state).toBe("scheduled");
        yield* TestClock.adjust("3 seconds");
        fake.running(id);
        yield* Deferred.await(running);
        yield* TestClock.adjust("5 seconds");
        fake.complete(id);
        yield* Deferred.await(complete);
        yield* Fiber.interrupt(consumer);
        yield* loop.iterate;
        const metrics = yield* Effect.promise(() => admin.inject("/metrics"));
        expect(metrics.statusCode).toBe(200);
        const text = metrics.body;
        for (const to of ["scheduled", "running", "succeeded"])
          expect(text).toContain(`krun_runs_transitions_total{function="echo",to="${to}"} 1`);
        for (const [metric, sum] of [
          ["krun_queue_wait_seconds", 2],
          ["krun_cold_start_seconds", 3],
          ["krun_run_duration_seconds", 5],
        ] as const) {
          expect(text).toContain(`# TYPE ${metric} histogram`);
          expect(text).toContain(`${metric}_bucket{`);
          const line = text.split("\n").find((line) => line.startsWith(`${metric}_sum{`));
          expect(line).toMatch(new RegExp(`} ${sum}$`));
        }
        expect(text).toContain('krun_runs_current{function="echo",state="queued"} 0');
        expect(text).not.toMatch(
          /_total_total|otel_scope_|target_info|krun-test-p46-private|time_unit|milliseconds/,
        );
        expect(text).not.toContain(id);
        yield* Effect.promise(() => processor.forceFlush());
        const spans = exporter.getFinishedSpans();
        const create = spans.find((s) => s.name === "POST /v1/functions/:function/runs");
        const perRun = spans.find((s) => s.name === "scheduler.schedule_run");
        const native = spans.filter(
          (s) => s.name === "kube.create jobs" || s.name === "kube.create secrets",
        );
        expect(create?.spanContext().traceId).toBe("1".repeat(32));
        expect(create?.parentSpanContext?.spanId).toBe("2".repeat(16));
        for (const span of [create, perRun, ...native])
          expect(span?.attributes["krun.run_id"]).toBe(id);
        expect(native).toHaveLength(2);
        expect(
          spans.find((s) => s.spanContext().spanId === perRun?.parentSpanContext?.spanId)?.name,
        ).toBe("scheduler.iteration");
        expect(perRun?.spanContext().traceId).not.toBe(create?.spanContext().traceId);
        expect(
          JSON.stringify(
            spans.map((s) => ({ attributes: s.attributes, events: s.events, status: s.status })),
          ),
        ).not.toMatch(/krun-test-p46-private/);
        expect(fake.calls).toContain("POST jobs");
        expect((yield* actual.getRun(id)).finished_at).toEqual(DateTime.makeUnsafe(10000));
      }),
    ).pipe(
      Effect.provide(StoreSqlite(":memory:")),
      Effect.provide(ReadinessLive(Effect.void)),
      Effect.provide(telemetry),
      Effect.provide(configLayer),
    );
  },
);
