import { expect, it } from "@effect/vitest";
import { CoreV1Api } from "@kubernetes/client-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DateTime, Duration, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import { JobPodSource } from "../../../../apps/scheduler/src/k8s/informers.js";
import { makeSweepLoop } from "../../../../apps/scheduler/src/sweep-loop.js";
import { ConfigLive } from "../config/index.js";
import { MetricsReader } from "../health/metrics.js";
import { KubeConnection, makeKubeConnection } from "../k8s/config.js";
import { DatabaseError, Store } from "../store/index.js";
import { StoreSqlite } from "../store/live.js";
import { TelemetryLive } from "./telemetry.js";

const namespace = "krun-test-p410-trace";
const id = "0192f000-0000-7000-8000-000000000410";
afterEach(() => vi.restoreAllMocks());
for (const mode of ["empty", "deletes", "query-error"] as const) {
  it.effect(`sweep spans and exact Prometheus counter cover ${mode} without private data`, () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.migrate();
      if (mode === "deletes") {
        yield* store.createRun({
          id,
          function_name: "p410-trace",
          input: { private: "private-sweep-input" },
          idempotency_key: null,
          request_hash: "a".repeat(64),
          priority: 0,
          created_by: namespace,
          created_at: yield* DateTime.now,
          callback_url: null,
        });
        yield* store.transition(id, "queued", "failed", "queue_timeout", {});
      }
      vi.spyOn(CoreV1Api.prototype, "listNamespacedSecret").mockResolvedValue({
        items:
          mode === "deletes"
            ? [
                {
                  metadata: {
                    name: "krun-test-orphan",
                    namespace,
                    uid: "uid",
                    resourceVersion: "1",
                    labels: { "krun.io/run-id": id },
                    creationTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
                  },
                  data: { token: "private-sweep-token" },
                },
              ]
            : [],
      });
      vi.spyOn(CoreV1Api.prototype, "deleteNamespacedSecret").mockRejectedValue({
        code: 503,
        body: { message: "private-sweep-status" },
      });
      const connection = yield* makeKubeConnection({
        load: (config) =>
          config.loadFromClusterAndUser(
            { name: namespace, server: "http://krun-test-p410.invalid", skipTLSVerify: true },
            { name: namespace },
          ),
      });
      const source: JobPodSource["Service"] = {
        ready: Effect.void,
        jobs: { get: () => undefined, list: () => [] },
        pods: { get: () => undefined, list: () => [] },
        hasPendingJob: () => false,
        acknowledgeJob: () => {},
        jobEvents: Stream.empty,
        podEvents: Stream.empty,
      };
      const loop = yield* makeSweepLoop({ namespace, retention: Duration.hours(1) }).pipe(
        Effect.provideService(
          Store,
          mode === "query-error"
            ? { ...store, sweep: () => Effect.fail(new DatabaseError({ operation: "sweep" })) }
            : store,
        ),
        Effect.provideService(KubeConnection, connection),
        Effect.provideService(JobPodSource, source),
      );
      yield* TestClock.adjust("2 hours");
      const before = exporter.getFinishedSpans().length;
      yield* loop.iterate;
      const spans = exporter.getFinishedSpans().slice(before);
      const aggregate = spans.filter((span) => span.name === "scheduler.sweep");
      expect(aggregate).toHaveLength(1);
      const pass = aggregate[0];
      expect(pass?.attributes).not.toHaveProperty("krun.run_id");
      if (mode !== "query-error") {
        expect(spans.find((span) => span.name === "store.sweep")?.parentSpanContext?.spanId).toBe(
          pass?.spanContext().spanId,
        );
        expect(
          spans.find((span) => span.name === "kube.list secrets")?.parentSpanContext?.spanId,
        ).toBe(pass?.spanContext().spanId);
        const metrics = (yield* (yield* MetricsReader).scrape).body;
        expect(metrics).toContain("# TYPE krun_sweep_deleted_total counter");
        expect(metrics).not.toContain("krun_sweep_deleted_total_total");
        expect(metrics).toMatch(
          new RegExp(
            `krun_sweep_deleted_total(?:\\{[^}]*\\})? ${mode === "deletes" ? 1 : 0}(?:\\n|$)`,
          ),
        );
        expect(metrics).not.toMatch(/private-sweep|krun.run_id/);
      }
      if (mode === "deletes") {
        const remove = spans.find((span) => span.name === "kube.delete secrets");
        expect(remove?.parentSpanContext?.spanId).toBe(pass?.spanContext().spanId);
        expect(remove?.attributes["krun.run_id"]).toBe(id);
      }
      expect(
        JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events }))),
      ).not.toMatch(/private-sweep/);
    }).pipe(
      Effect.provide(StoreSqlite(":memory:")),
      Effect.provide(
        TelemetryLive(() => processor).pipe(
          Layer.provide(
            ConfigLive("scheduler", {
              env: {
                KRUN_DB_MODE: "embedded",
                KRUN_NAMESPACE: namespace,
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-p410.invalid",
                OTEL_TRACES_SAMPLER: "always_on",
              },
            }),
          ),
        ),
      ),
    );
  });
}
