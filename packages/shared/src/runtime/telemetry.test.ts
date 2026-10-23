import { createServer, type Server } from "node:http";
import { expect, it } from "@effect/vitest";
import { ROOT_CONTEXT, SpanKind } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import {
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, Metric } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigLive } from "../config/index.js";
import { makeHealthApp } from "../health/index.js";
import { MetricsReader } from "../health/metrics.js";
import { ReadinessLive } from "../health/readiness.js";
import { makeSampler, TelemetryLive } from "./telemetry.js";

beforeEach(() => {
  // Never send ambient operator resource attributes/headers to a test collector.
  for (const name of [
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const config = (role: "gateway" | "scheduler" = "gateway", env: Record<string, string> = {}) =>
  ConfigLive(role, { env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p0-7", ...env } });
const telemetry = () => TelemetryLive().pipe(Layer.provide(config()));

it.effect(
  "real Effect metrics scrape through admin inject with exact counter/histogram names",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* makeHealthApp;
        yield* Metric.update(
          Metric.withAttributes(Metric.counter("krun_http_requests_total", { incremental: true }), {
            route: "/krun-test",
            code: "200",
          }),
          2,
        );
        yield* Metric.update(
          Metric.histogram("krun_queue_wait_seconds", { boundaries: [0.1, 1, 5] }),
          0.25,
        );
        const response = yield* Effect.promise(() => app.inject("/metrics"));
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.body).toContain("# TYPE krun_http_requests_total counter");
        const counterLine = response.body
          .split("\n")
          .find((line) => line.startsWith("krun_http_requests_total{"));
        expect(counterLine).toMatch(/\} 2$/);
        expect(
          counterLine
            ?.match(/\{([^}]+)\}/)?.[1]
            ?.split(",")
            .sort(),
        ).toEqual(['code="200"', 'route="/krun-test"']);
        expect(response.body).toContain("krun_queue_wait_seconds_bucket");
        expect(response.body).toContain("krun_queue_wait_seconds_sum 0.25");
        expect(response.body).not.toMatch(/_total_total|otel_scope_|target_info/);
        expect((yield* Effect.promise(() => app.inject("/v1/functions"))).statusCode).toBe(404);
      }),
    ).pipe(Effect.provide(Layer.merge(ReadinessLive(Effect.void), telemetry()))),
);

it.effect("telemetry never starts an exporter port and scopes close the real metric reader", () =>
  Effect.gen(function* () {
    const start = vi.spyOn(PrometheusExporter.prototype, "startServer");
    const stop = vi.spyOn(PrometheusExporter.prototype, "onShutdown");
    const reader = yield* Effect.scoped(MetricsReader.pipe(Effect.provide(telemetry())));
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect((yield* Effect.exit(reader.scrape))._tag).toBe("Failure");
  }),
);

it.effect("metric registries are isolated per layer acquisition", () =>
  Effect.gen(function* () {
    for (const record of [true, false]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* MetricsReader;
          if (record)
            yield* Metric.update(
              Metric.counter("krun_test_isolated_total", { incremental: true }),
              7,
            );
          const text = (yield* reader.scrape).body;
          expect(text.includes("krun_test_isolated_total")).toBe(record);
        }),
      ).pipe(Effect.provide(telemetry()));
    }
  }),
);

it.effect("no endpoint means no trace processor factory, even while Effect spans have IDs", () =>
  Effect.gen(function* () {
    let calls = 0;
    const live = TelemetryLive(() => {
      calls++;
      return new SimpleSpanProcessor(new InMemorySpanExporter());
    }).pipe(Layer.provide(config()));
    yield* Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    }).pipe(Effect.withSpan("krun-test-no-export"), Effect.provide(live));
    expect(calls).toBe(0);
  }),
);

it.live(
  "configured tracing honors parsed service/sampler and flushes/shuts down on scope exit",
  () =>
    Effect.gen(function* () {
      const exporter = new InMemorySpanExporter();
      const processor = new SimpleSpanProcessor(exporter);
      const flush = vi.spyOn(processor, "forceFlush");
      const shutdown = vi.spyOn(processor, "shutdown");
      let receivedUrl = "";
      yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan("krun-test-sampled"));
        yield* Effect.promise(() => processor.forceFlush());
        const spans = exporter.getFinishedSpans();
        expect(spans.map((span) => span.name)).toEqual(["krun-test-sampled"]);
        expect(spans[0]?.resource.attributes["service.name"]).toBe("krun-scheduler");
      }).pipe(
        Effect.provide(
          TelemetryLive((url) => {
            receivedUrl = url;
            return processor;
          }).pipe(
            Layer.provide(
              config("scheduler", {
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-collector.invalid:4318/base/",
                OTEL_TRACES_SAMPLER: "always_on",
              }),
            ),
          ),
        ),
      );
      expect(receivedUrl).toBe("http://krun-test-collector.invalid:4318/base/v1/traces");
      expect(flush).toHaveBeenCalled();
      expect(shutdown).toHaveBeenCalledTimes(1);
    }),
);

it.live("parsed sampler overrides conflicting ambient SDK environment", () =>
  Effect.gen(function* () {
    vi.stubEnv("OTEL_TRACES_SAMPLER", "always_on");
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    yield* Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("krun-test-must-not-export"));
      yield* Effect.promise(() => processor.forceFlush());
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        TelemetryLive(() => processor).pipe(
          Layer.provide(
            config("gateway", {
              OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-collector.invalid:4318",
              OTEL_TRACES_SAMPLER: "always_off",
            }),
          ),
        ),
      ),
    );
  }),
);

for (const [name, expected] of [
  ["always_on", 2],
  ["always_off", 0],
  ["parentbased_always_on", 2],
  ["parentbased_always_off", 0],
] as const) {
  it.effect(`explicit sampler policy: ${name}`, () =>
    Effect.gen(function* () {
      const sampler = yield* makeSampler(name, "0.1");
      const result = sampler.shouldSample(
        ROOT_CONTEXT,
        "00000000000000000000000000000001",
        "krun-test",
        SpanKind.INTERNAL,
        {},
        [],
      );
      expect(result.decision).toBe(
        expected === 2 ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
      );
    }),
  );
}
for (const name of ["traceidratio", "parentbased_traceidratio"]) {
  it.effect(`explicit ratio sampler: ${name}`, () =>
    Effect.gen(function* () {
      expect((yield* makeSampler(name, "0.25")).toString()).toContain("TraceIdRatioBased{0.25}");
    }),
  );
}
for (const value of ["krun-test-invalid-ratio", "-1", "2", "Infinity", " "]) {
  it.effect(`invalid sampler argument falls back nonfatally: ${value}`, () =>
    Effect.gen(function* () {
      expect((yield* makeSampler("parentbased_traceidratio", value)).toString()).toContain(
        "TraceIdRatioBased{0.1}",
      );
    }),
  );
}
it.effect("unknown sampler falls back nonfatally to the parsed default policy", () =>
  Effect.gen(function* () {
    expect((yield* makeSampler("krun-test-invalid-sampler", "0.1")).toString()).toContain(
      "TraceIdRatioBased{0.1}",
    );
  }),
);

it.effect("invalid OTLP endpoint is nonfatal and leaves real metrics available", () =>
  Effect.gen(function* () {
    let called = false;
    yield* Effect.gen(function* () {
      const reader = yield* MetricsReader;
      yield* Metric.update(Metric.counter("krun_test_endpoint_total", { incremental: true }), 1);
      expect((yield* reader.scrape).body).toContain("krun_test_endpoint_total 1");
    }).pipe(
      Effect.provide(
        TelemetryLive(() => {
          called = true;
          return new SimpleSpanProcessor(new InMemorySpanExporter());
        }).pipe(
          Layer.provide(
            config("gateway", { OTEL_EXPORTER_OTLP_ENDPOINT: "krun-test-invalid-url" }),
          ),
        ),
      ),
    );
    expect(called).toBe(false);
  }),
);

it.effect("a real reader collection failure returns redacted 503 through the admin route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* makeHealthApp;
      vi.spyOn(PrometheusExporter.prototype, "collect").mockRejectedValue(
        new Error("krun-test-sensitive-exporter-cause"),
      );
      const response = yield* Effect.promise(() => app.inject("/metrics"));
      expect(response.statusCode).toBe(503);
      expect(response.body).toBe('{"status":"unavailable"}');
      expect((yield* Effect.promise(() => app.inject("/healthz"))).statusCode).toBe(200);
    }),
  ).pipe(Effect.provide(Layer.merge(ReadinessLive(Effect.void), telemetry()))),
);

it.effect("real metric reader finalizes when its owning effect fails", () =>
  Effect.gen(function* () {
    const shutdown = vi.spyOn(PrometheusExporter.prototype, "onShutdown");
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        yield* MetricsReader;
        return yield* Effect.fail("krun-test-owner-failed");
      }).pipe(Effect.provide(telemetry())),
    );
    expect(result._tag).toBe("Failure");
    expect(shutdown).toHaveBeenCalledTimes(1);
  }),
);

it.live(
  "default BatchSpanProcessor exports actual OTLP JSON to a disposable local collector on scope close",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: { path: string | undefined; body: string }[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<Server>((resolve, reject) => {
                const server = createServer((request, response) => {
                  const chunks: Buffer[] = [];
                  request.on("data", (chunk: Buffer) => chunks.push(chunk));
                  request.on("end", () => {
                    requests.push({ path: request.url, body: Buffer.concat(chunks).toString() });
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end("{}");
                  });
                });
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("krun test collector failed to bind");
        yield* Effect.void.pipe(
          Effect.withSpan("krun-test-real-otlp"),
          Effect.provide(
            TelemetryLive().pipe(
              Layer.provide(
                config("gateway", {
                  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}/krun-test/`,
                  OTEL_TRACES_SAMPLER: "always_on",
                }),
              ),
            ),
          ),
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.path).toBe("/krun-test/v1/traces");
        const payload = JSON.parse(requests[0]?.body ?? "{}");
        expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("krun-test-real-otlp");
      }),
    ),
);
