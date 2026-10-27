import { expect, it } from "@effect/vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DateTime, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeHeartbeatLoop } from "../../../../apps/scheduler/src/heartbeat-loop.js";
import { makeJobController } from "../../../../apps/scheduler/src/job-controller.js";
import { JobPodSource } from "../../../../apps/scheduler/src/k8s/informers.js";
import { Kube } from "../../../../apps/scheduler/src/k8s/kube.js";
import { ConfigLive } from "../config/index.js";
import { Functions } from "../functions/cache.js";
import { functionSpecSchema } from "../functions/schema.js";
import { validateFunction } from "../functions/validation.js";
import { DatabaseError, Store } from "../store/index.js";
import { StoreSqlite } from "../store/live.js";
import { TelemetryLive } from "./telemetry.js";

const id = "0192f000-0000-7000-8000-000000000049";
const namespace = "krun-test-p49-trace";
const fn = "p49-trace";
for (const mode of ["empty", "fresh", "stale", "query-error", "debt"] as const) {
  it.effect(`heartbeat aggregate span includes ${mode} passes and parents current work`, () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.migrate();
      if (mode !== "empty") {
        yield* store.createRun({
          id,
          function_name: fn,
          input: {},
          idempotency_key: null,
          request_hash: "a".repeat(64),
          priority: 0,
          created_by: namespace,
          created_at: yield* DateTime.now,
          callback_url: null,
        });
        yield* store.setJobToken(id, `krun-${id}`, "owned-test-hash");
        yield* store.markScheduled(id);
        yield* store.transition(id, "scheduled", "running", null, {});
      }
      let failCommit = mode === "debt";
      const controlled: Store["Service"] = {
        ...store,
        listStale: (...args) =>
          mode === "query-error"
            ? Effect.fail(new DatabaseError({ operation: "listStale" }))
            : store.listStale(...args),
        transition: (...args) =>
          Effect.suspend(() =>
            failCommit
              ? Effect.fail(new DatabaseError({ operation: "transition" }))
              : store.transition(...args),
          ),
      };
      const source: JobPodSource["Service"] = {
        ready: Effect.void,
        jobEvents: Stream.empty,
        podEvents: Stream.empty,
        hasPendingJob: () => false,
        acknowledgeJob: () => {},
        jobs: { get: () => undefined, list: () => [] },
        pods: {
          get: () => undefined,
          list: () => [
            {
              metadata: { name: "krun-test-p49-trace-pod", labels: { "krun.io/run-id": id } },
              status: { phase: "Running" },
            },
          ],
        },
      };
      const kube: Kube["Service"] = {
        createJob: () => Effect.succeed({}),
        createSecret: () => Effect.succeed({}),
        readSecret: () => Effect.succeed({}),
        readPodLog: () => Effect.succeed("krun-test-p49-trace-private-tail"),
        deleteJob: () => Effect.void,
        deleteSecret: () => Effect.void,
      };
      const spec = functionSpecSchema.parse({
        image: `ghcr.io/krun-test/function@sha256:${"a".repeat(64)}`,
        inputSchema: { type: "object" },
        heartbeatTimeout: "30s",
      });
      const entry = {
        name: fn,
        uid: namespace,
        generation: 1,
        resourceVersion: "1",
        spec,
        status: undefined,
        result: validateFunction(spec, {
          maxActiveDeadline: 86400,
          maxQueued: 1000,
          allowedRegistries: ["ghcr.io"],
          allowedServiceAccounts: ["krun-job-default"],
          webhookAllowedHosts: [],
        }),
      };
      let disabled = false;
      const functions: Functions["Service"] = {
        get: () => Effect.succeed(disabled ? undefined : entry),
        getAny: () => Effect.succeed(entry),
        list: Effect.sync(() => (mode === "empty" || disabled ? [] : [entry])),
        synced: Effect.void,
        isSynced: Effect.succeed(true),
      };
      const controller = yield* makeJobController({
        namespace,
        maxRunning: 8,
        checkResult: () => Effect.succeed(null),
      }).pipe(
        Effect.provideService(Store, controlled),
        Effect.provideService(JobPodSource, source),
        Effect.provideService(Kube, kube),
      );
      const loop = yield* makeHeartbeatLoop({ controller }).pipe(
        Effect.provideService(Store, controlled),
        Effect.provideService(Functions, functions),
        Effect.provideService(JobPodSource, source),
      );
      if (mode === "stale" || mode === "debt") yield* TestClock.adjust("31 seconds");
      if (mode === "debt") {
        yield* loop.iterate;
        failCommit = false;
        disabled = true;
      }
      const before = exporter.getFinishedSpans().length;
      yield* loop.iterate;
      const spans = exporter.getFinishedSpans().slice(before);
      const aggregate = spans.filter((span) => span.name === "scheduler.heartbeat_loop");
      expect(aggregate).toHaveLength(1);
      const pass = aggregate[0];
      expect(pass?.attributes).not.toHaveProperty("krun.run_id");
      if (mode === "fresh" || mode === "stale") {
        const query = spans.find((span) => span.name === "store.listStale");
        expect(query?.parentSpanContext?.spanId).toBe(pass?.spanContext().spanId);
      }
      if (mode === "stale" || mode === "debt") {
        const run = spans.find((span) => span.name === "scheduler.heartbeat");
        expect(run?.parentSpanContext?.spanId).toBe(pass?.spanContext().spanId);
        expect(run?.attributes["krun.run_id"]).toBe(id);
        const write = spans.find((span) => span.name === "store.transition");
        expect(write?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
      }
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(
        /private-tail|owned-test-hash/,
      );
    }).pipe(
      Effect.provide(StoreSqlite(":memory:")),
      Effect.provide(
        TelemetryLive(() => processor).pipe(
          Layer.provide(
            ConfigLive("scheduler", {
              env: {
                KRUN_DB_MODE: "embedded",
                KRUN_NAMESPACE: namespace,
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-trace.invalid",
                OTEL_TRACES_SAMPLER: "always_on",
              },
            }),
          ),
        ),
      ),
    );
  });
}
