import { createServer } from "node:http";
import { expect, it } from "@effect/vitest";
import { ConfigLive } from "@krun/shared/dist/config/index.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import { makeCreationPolicy } from "./create-policy.js";
import { makeKube } from "./kube.js";

beforeEach(() => {
  for (const name of [
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

it.live(
  "real Prometheus counters and OTLP failure spans have exact labels/correlation but no private Status/manifest",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const payloads: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = createServer((req, res) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => {
                res.setHeader("content-type", "application/json");
                if (req.url === "/v1/traces") {
                  payloads.push(Buffer.concat(chunks).toString());
                  res.end("{}");
                } else {
                  res.statusCode = 403;
                  res.setHeader("private-header", "krun-test-private-header");
                  res.end(
                    JSON.stringify({
                      kind: "Status",
                      apiVersion: "v1",
                      code: 403,
                      reason: "Forbidden",
                      message: "exceeded quota: krun-test-private-status",
                    }),
                  );
                }
              });
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  server.closeAllConnections();
                }),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          return yield* Effect.die("Owned receiver failed");
        const url = `http://127.0.0.1:${address.port}`;
        const connection = yield* makeKubeConnection({
          load: (config) =>
            config.loadFromOptions({
              clusters: [{ name: "krun-test-api", server: url, skipTLSVerify: true }],
              users: [{ name: "krun-test-api" }],
              contexts: [
                { name: "krun-test-api", cluster: "krun-test-api", user: "krun-test-api" },
              ],
              currentContext: "krun-test-api",
            }),
        });
        const telemetry = TelemetryLive().pipe(
          Layer.provide(
            ConfigLive("scheduler", {
              env: {
                KRUN_DB_MODE: "embedded",
                KRUN_NAMESPACE: "krun-test-api",
                OTEL_EXPORTER_OTLP_ENDPOINT: url,
                OTEL_TRACES_SAMPLER: "always_on",
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const kube = yield* makeKube();
          const policy = yield* makeCreationPolicy;
          const error = yield* Effect.flip(
            kube.createJob(
              {
                namespace: "krun-test-api",
                name: "krun-test-job",
                function: "worker",
                runId: "01900000-0000-7000-8000-000000000001",
              },
              { metadata: { annotations: { private: "krun-test-private-manifest" } } },
            ),
          );
          expect(yield* policy.failed("worker", error)).toMatchObject({
            kind: "transient",
            quota: true,
          });
          const reader = yield* MetricsReader;
          const text = (yield* reader.scrape).body;
          const counter = text
            .split("\n")
            .find((line) => line.startsWith("krun_job_create_errors_total{"));
          expect(counter).toMatch(/\} 1$/);
          expect(
            counter
              ?.match(/\{([^}]+)\}/)?.[1]
              ?.split(",")
              .sort(),
          ).toEqual(['code="403"', 'function="worker"']);
          expect(text).toContain('krun_quota_rejections_total{function="worker"} 1');
          expect(text).not.toMatch(/_total_total|krun-test-private/);
        }).pipe(Effect.provide(telemetry), Effect.provideService(KubeConnection, connection));
        expect(payloads.length).toBeGreaterThan(0);
        const exported = payloads.join("\n");
        expect(exported).toContain('"name":"kube.create jobs"');
        expect(exported).toContain('"key":"krun.run_id"');
        expect(exported).toContain('"key":"http.status_code"');
        expect(exported).toContain('"key":"error.tag"');
        expect(exported).toContain('"code":2');
        expect(exported).not.toContain("krun-test-private");
      }),
    ),
);
