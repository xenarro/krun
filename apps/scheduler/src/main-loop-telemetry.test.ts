import { createServer } from "node:http";
import { expect, it } from "@effect/vitest";
import { ConfigLive, parseSchedulerConfig } from "@krun/shared/dist/config/index.js";
import { Functions } from "@krun/shared/dist/functions/cache.js";
import { functionResourceSchema } from "@krun/shared/dist/functions/schema.js";
import { validateFunction } from "@krun/shared/dist/functions/validation.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { KubeConnection, makeKubeConnection } from "@krun/shared/dist/k8s/config.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { DateTime, Effect, Layer } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";
import { Kube, makeKube } from "./k8s/kube.js";
import { makeMainLoop } from "./main-loop.js";

beforeEach(() => {
  for (const name of [
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());
const spanSchema = z.looseObject({
  name: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
});
const payloadSchema = z.object({
  resourceSpans: z.array(
    z.object({ scopeSpans: z.array(z.object({ spans: z.array(spanSchema) })) }),
  ),
});

it.live(
  "actual loop/run/native span hierarchy and Prometheus counters exclude input,env,token and private Status",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const payloads: string[] = [],
          tokens: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = createServer((req, res) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => {
                res.setHeader("content-type", "application/json");
                const text = Buffer.concat(chunks).toString();
                if (req.url === "/v1/traces") {
                  payloads.push(text);
                  res.end("{}");
                } else if (req.url?.endsWith("/secrets")) {
                  const secret = JSON.parse(text);
                  tokens.push(
                    secret.data.token,
                    Buffer.from(secret.data.token, "base64").toString(),
                  );
                  res.statusCode = 201;
                  res.end(text);
                } else {
                  res.statusCode = 403;
                  res.end(
                    JSON.stringify({
                      kind: "Status",
                      code: 403,
                      reason: "Forbidden",
                      message: "exceeded quota: krun-test-loop-private-status",
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
        if (address === null || typeof address === "string")
          return yield* Effect.die("Owned loop receiver failed");
        const url = `http://127.0.0.1:${address.port}`;
        const config = yield* parseSchedulerConfig({
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: "krun-test-p43b",
          KRUN_JOBS_NAMESPACE: "krun-test-p43b-jobs",
        });
        const connection = yield* makeKubeConnection({
          load: (c) =>
            c.loadFromClusterAndUser(
              { name: "krun-test-p43b", server: url, skipTLSVerify: true },
              { name: "krun-test-p43b" },
            ),
        });
        const fn = functionResourceSchema.parse({
          apiVersion: "krun.io/v1alpha1",
          kind: "Function",
          metadata: { name: "loop-worker" },
          spec: {
            image: `registry.example.invalid/worker@sha256:${"a".repeat(64)}`,
            inputSchema: {},
            env: [{ name: "OWNED_CANARY", value: "krun-test-loop-private-env" }],
          },
        });
        const entry = {
          name: fn.metadata.name,
          uid: "owned",
          generation: 1,
          resourceVersion: "1",
          spec: fn.spec,
          status: undefined,
          result: validateFunction(fn.spec, {
            maxActiveDeadline: 86400,
            maxQueued: 1000,
            allowedRegistries: [],
            allowedServiceAccounts: ["krun-job-default"],
            webhookAllowedHosts: [],
          }),
        };
        const telemetry = TelemetryLive().pipe(
          Layer.provide(
            ConfigLive("scheduler", {
              env: {
                KRUN_DB_MODE: "embedded",
                KRUN_NAMESPACE: "krun-test-p43b",
                OTEL_EXPORTER_OTLP_ENDPOINT: url,
                OTEL_TRACES_SAMPLER: "always_on",
              },
            }),
          ),
        );
        const runId = "0192f000-0000-7000-8000-000000000099";
        yield* Effect.gen(function* () {
          const store = yield* Store;
          yield* store.migrate();
          yield* store.createRun({
            id: runId,
            idempotency_key: null,
            request_hash: "a".repeat(64),
            function_name: "loop-worker",
            input: { value: "krun-test-loop-private-input" },
            priority: 0,
            callback_url: null,
            created_by: "test-owner",
            created_at: yield* DateTime.now,
          });
          const kube = yield* makeKube().pipe(Effect.provideService(KubeConnection, connection));
          const loop = yield* makeMainLoop({
            owner: "krun-test-scheduler",
            config,
            replayCached: () => Effect.die("Unexpected replay on quota failure"),
          }).pipe(
            Effect.provideService(Kube, kube),
            Effect.provideService(Functions, {
              get: () => Effect.succeed(entry),
              getAny: () => Effect.succeed(entry),
              list: Effect.succeed([entry]),
              synced: Effect.void,
              isSynced: Effect.succeed(true),
            }),
          );
          yield* loop.iterate;
          expect((yield* store.getRun(runId)).lease_owner).toBeNull();
          const reader = yield* MetricsReader,
            text = (yield* reader.scrape).body;
          expect(text).toContain('krun_quota_rejections_total{function="loop-worker"} 1');
          expect(text.includes('code="403"')).toBe(true);
          expect(text.includes("_total_total")).toBe(false);
          expect(text.includes("krun-test-loop-private")).toBe(false);
        }).pipe(Effect.provide(StoreSqlite(":memory:")), Effect.provide(telemetry));
        const exported = payloads.join("\n");
        const spans = payloads.flatMap((text) =>
          payloadSchema
            .parse(JSON.parse(text))
            .resourceSpans.flatMap((resource) =>
              resource.scopeSpans.flatMap((scope) => scope.spans),
            ),
        );
        const iteration = spans.find((span) => span.name === "scheduler.iteration"),
          run = spans.find((span) => span.name === "scheduler.schedule_run"),
          native = spans.find((span) => span.name === "kube.create jobs");
        expect(iteration).toBeDefined();
        expect(run).toBeDefined();
        expect(native).toBeDefined();
        expect(run?.parentSpanId).toBe(iteration?.spanId);
        expect(native?.parentSpanId).toBe(run?.spanId);
        expect(exported.includes(runId)).toBe(true);
        expect(exported.includes("krun-test-loop-private")).toBe(false);
        expect(tokens.length).toBe(2);
        expect(tokens.some((token) => exported.includes(token))).toBe(false);
      }),
    ),
);
