import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  type Sampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { Data, Effect, Layer, Metric, Option } from "effect";
import { KrunConfig } from "../config/index.js";
import { MetricsReader } from "../health/metrics.js";

class TelemetryUnavailable extends Data.TaggedError("TelemetryUnavailable") {}

// P0.5 supplies defaults as strings. Do not delegate their interpretation to
// the SDK's ambient environment or its different parentbased_always_on default.
export const makeSampler = (name: string, argument: string): Effect.Effect<Sampler> =>
  Effect.gen(function* () {
    const value = argument.trim() === "" ? Number.NaN : Number(argument);
    const valid = Number.isFinite(value) && value >= 0 && value <= 1;
    if (!valid) yield* Effect.logWarning("Invalid OTEL_TRACES_SAMPLER_ARG; using default 0.1");
    const ratio = valid ? value : 0.1;
    switch (name) {
      case "always_on":
        return new AlwaysOnSampler();
      case "always_off":
        return new AlwaysOffSampler();
      case "traceidratio":
        return new TraceIdRatioBasedSampler(ratio);
      case "parentbased_always_on":
        return new ParentBasedSampler({ root: new AlwaysOnSampler() });
      case "parentbased_always_off":
        return new ParentBasedSampler({ root: new AlwaysOffSampler() });
      case "parentbased_traceidratio":
        return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
      default:
        yield* Effect.logWarning(
          "Invalid OTEL_TRACES_SAMPLER; using default parentbased_traceidratio",
        );
        return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
    }
  });

const makeProcessor = (url: string): SpanProcessor =>
  new BatchSpanProcessor(new OTLPTraceExporter({ url }));

const traceUrl = (endpoint: string) => {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/traces`;
  return url.toString();
};

// Factory injection permits real in-memory processor tests without network or
// module mocks. The default is the real OTLP/HTTP batch processor. No endpoint
// means the factory is never called. Nothing is acquired at module import.
export const TelemetryLive = (processorFactory: (url: string) => SpanProcessor = makeProcessor) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { config } = yield* KrunConfig;
      const exporter = new PrometheusExporter({
        preventServerStart: true,
        withoutScopeInfo: true,
        withoutTargetInfo: true,
      });
      const serializer = new PrometheusSerializer("", false, undefined, true, true);
      let tracing: Pick<NodeSdk.Configuration, "spanProcessor" | "tracerConfig"> = {};
      if (config.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined) {
        const sampler = yield* makeSampler(
          config.OTEL_TRACES_SAMPLER,
          config.OTEL_TRACES_SAMPLER_ARG,
        );
        const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
        const processor = yield* Effect.try({
          try: () => processorFactory(traceUrl(endpoint)),
          catch: () => new TelemetryUnavailable(),
        }).pipe(Effect.option);
        if (Option.isSome(processor)) {
          tracing = { spanProcessor: processor.value, tracerConfig: { sampler } };
        } else {
          // These variables are deliberately nonfatal, and their values/cause
          // must never reach logs. An invalid exporter cannot disable metrics.
          yield* Effect.logWarning("Invalid OTEL_EXPORTER_OTLP_ENDPOINT; traces disabled");
        }
      }
      const sdk = NodeSdk.layer(() => ({
        resource: { serviceName: config.OTEL_SERVICE_NAME },
        metricReader: exporter,
        shutdownTimeout: "3 seconds",
        ...tracing,
      }));
      const reader = Layer.succeed(MetricsReader, {
        scrape: Effect.tryPromise({
          try: async () => {
            const result = await exporter.collect();
            if (result.errors.length > 0) throw new TelemetryUnavailable();
            return {
              contentType: "text/plain; version=0.0.4; charset=utf-8",
              body: serializer.serialize(result.resourceMetrics),
            };
          },
          catch: () => new TelemetryUnavailable(),
        }),
      });
      // The SDK owns reader/provider finalizers (including tracer forceFlush).
      // A process-local registry is shared by the producer and its consumers,
      // never Effect's default global Map or an ambient OpenTelemetry provider.
      return Layer.merge(sdk, reader).pipe(
        Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, new Map())),
      );
    }),
  );
