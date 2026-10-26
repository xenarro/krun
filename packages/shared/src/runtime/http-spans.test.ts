import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DateTime, Effect, Layer } from "effect";
import { makePublicApp } from "../../../../apps/gateway/src/app.js";
import { makeInternalApp } from "../../../../apps/gateway/src/internal-app.js";
import { Keys, makeKeys } from "../auth/keys.js";
import { ConfigLive } from "../config/index.js";
import { Functions } from "../functions/cache.js";
import { makeHealthApp } from "../health/index.js";
import { ReadinessLive } from "../health/readiness.js";
import { Store } from "../store/index.js";
import { StoreSqlite } from "../store/live.js";
import { requestTraceFields } from "./http.js";
import { TelemetryLive } from "./telemetry.js";

for (const source of ["path", "audit"] as const) {
  it.effect(
    `P46-C1: ${source} correlation exports only valid Run identities, without repairing invalid values`,
    () => {
      const exporter = new InMemorySpanExporter();
      const processor = new SimpleSpanProcessor(exporter);
      const config = ConfigLive("gateway", {
        env: {
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: "krun-test-p46-identity",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-collector.invalid",
          OTEL_TRACES_SAMPLER: "always_on",
          KRUN_LOG_LEVEL: "silent",
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const internal = yield* makeInternalApp({ maxResultBytes: 262144 });
          const token = randomBytes(32).toString("hex");
          const keys = yield* makeKeys({
            path: "krun-test-p46-identity-memory",
            read: Effect.succeed(
              Buffer.from(
                JSON.stringify({
                  keys: [{ name: "reader", key: token, scopes: ["runs:read"], functions: ["*"] }],
                }),
              ),
            ),
          });
          const functions: Functions["Service"] = {
            get: () => Effect.succeed(undefined),
            getAny: () => Effect.succeed(undefined),
            list: Effect.succeed([]),
            isSynced: Effect.succeed(true),
            synced: Effect.void,
          };
          const app = yield* makePublicApp({
            routes: async (scope) => {
              scope.get<{ Params: { run: string; value: string } }>(
                "/v1/identity/:run/:value",
                { config: { krun: { scope: "runs:read" } } },
                async (request) => {
                  request.audit = { run_id: request.params.value };
                  return { ok: true };
                },
              );
            },
          }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
          const valid = "0192f000-0000-7000-8000-000000000123";
          for (const [value, accepted] of [
            ["private-run-identity-canary", false],
            ["0192f000-0000-4000-8000-000000000123", false],
            ["00000000-0000-0000-0000-000000000000", false],
            [`prefix-${valid}`, false],
            [`${valid}suffix`, false],
            [valid, true],
            [valid.toUpperCase(), true],
          ] as const) {
            const before = exporter.getFinishedSpans().length;
            const response = yield* Effect.promise(() =>
              source === "path"
                ? internal.inject({ url: `/internal/v1/runs/${encodeURIComponent(value)}/input` })
                : app.inject({
                    url: `/v1/identity/${valid}/${encodeURIComponent(value)}`,
                    headers: { authorization: ["Bearer", token].join(" ") },
                  }),
            );
            expect(response.statusCode).toBe(source === "path" ? 401 : 200);
            yield* Effect.promise(() => processor.forceFlush());
            const spans = exporter.getFinishedSpans().slice(before);
            expect(spans).toHaveLength(1);
            expect(spans[0]?.attributes["krun.run_id"]).toBe(accepted ? value : undefined);
            if (!accepted)
              expect(
                JSON.stringify(
                  spans.map((span) => ({
                    name: span.name,
                    attributes: span.attributes,
                    events: span.events,
                    status: span.status,
                  })),
                ),
              ).not.toContain(value);
          }
        }),
      ).pipe(
        Effect.provide(StoreSqlite(":memory:")),
        Effect.provide(TelemetryLive(() => processor).pipe(Layer.provide(config))),
        Effect.provide(config),
      );
    },
  );
}

it.effect(
  "request tracing honors valid parent, ignores malformed parents, covers pre-handler errors/internal and excludes admin",
  () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const config = ConfigLive("gateway", {
      env: {
        KRUN_DB_MODE: "embedded",
        KRUN_NAMESPACE: "krun-test-p46-spans",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://krun-test-collector.invalid",
        OTEL_TRACES_SAMPLER: "always_on",
        KRUN_LOG_LEVEL: "silent",
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const token = randomBytes(32).toString("hex");
        const keys = yield* makeKeys({
          path: "krun-test-p46-spans-memory",
          read: Effect.succeed(
            Buffer.from(
              JSON.stringify({
                keys: [{ name: "reader", key: token, scopes: ["runs:read"], functions: ["*"] }],
              }),
            ),
          ),
        });
        const functions: Functions["Service"] = {
          get: () => Effect.succeed(undefined),
          getAny: () => Effect.succeed(undefined),
          list: Effect.succeed([]),
          isSynced: Effect.succeed(true),
          synced: Effect.void,
        };
        const app = yield* makePublicApp({
          routes: async (scope) => {
            scope.get(
              "/v1/span",
              { config: { krun: { scope: "runs:read" } } },
              async (request, reply) =>
                scope.runEffect(
                  request,
                  reply,
                  Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    return { trace: span.traceId, fields: requestTraceFields(request) };
                  }),
                ),
            );
          },
        }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
        const headers = { authorization: `Bearer ${token}` };
        const valid = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
        for (const parent of [
          valid,
          `00-${"0".repeat(32)}-${"2".repeat(16)}-01`,
          `00-${"1".repeat(32)}-${"0".repeat(16)}-01`,
          valid.toUpperCase().replace("00-", "FF-"),
          `${valid},${valid}`,
          "invalid-private-header",
        ]) {
          const response = yield* Effect.promise(() =>
            app.inject({ url: "/v1/span", headers: { ...headers, traceparent: parent } }),
          );
          expect(response.statusCode).toBe(200);
          yield* Effect.promise(() => processor.forceFlush());
          const span = exporter.getFinishedSpans().at(-1);
          expect(span?.name).toBe("GET /v1/span");
          expect(response.json().fields).toEqual({
            traceId: span?.spanContext().traceId,
            spanId: span?.spanContext().spanId,
          });
          if (parent === valid) {
            expect(span?.spanContext().traceId).toBe("1".repeat(32));
            expect(span?.parentSpanContext?.spanId).toBe("2".repeat(16));
          } else expect(span?.parentSpanContext).toBeUndefined();
        }
        const denied = yield* Effect.promise(() => app.inject({ url: "/v1/span" }));
        expect(denied.statusCode).toBe(401);
        const missing = yield* Effect.promise(() =>
          app.inject({ url: "/v1/private-path-canary?secret=private-query-canary" }),
        );
        expect(missing.statusCode).toBe(404);
        const store = yield* Store;
        yield* store.migrate();
        const id = "0192f000-0000-7000-8000-000000000123";
        yield* store.createRun({
          id,
          function_name: "echo",
          idempotency_key: null,
          request_hash: "a".repeat(64),
          input: { private: "private-body-canary" },
          priority: 0,
          callback_url: null,
          created_by: "owned",
          created_at: yield* DateTime.now,
        });
        const runToken = randomBytes(32).toString("hex");
        yield* store.setJobToken(
          id,
          `krun-${id}`,
          createHash("sha256").update(runToken).digest("hex"),
        );
        const internal = yield* makeInternalApp({ maxResultBytes: 262144 });
        const result = yield* Effect.promise(() =>
          internal.inject({
            url: `/internal/v1/runs/${id}/input`,
            headers: { authorization: `Bearer ${runToken}`, traceparent: valid },
          }),
        );
        expect(result.statusCode).toBe(200);
        const admin = yield* makeHealthApp;
        for (const url of ["/healthz", "/readyz", "/metrics", "/v1/span", "/internal/v1/missing"])
          yield* Effect.promise(() => admin.inject(url));
        yield* Effect.promise(() => processor.forceFlush());
        const spans = exporter.getFinishedSpans();
        expect(spans.filter((s) => s.name === "GET /v1/span")).toHaveLength(7);
        expect(spans.find((s) => s.attributes["http.response.status_code"] === 401)).toBeDefined();
        expect(spans.find((s) => s.attributes["http.response.status_code"] === 404)).toBeDefined();
        const run = spans.find((s) => s.name === "GET /internal/v1/runs/:run/input");
        expect(run?.attributes["krun.run_id"]).toBe(id);
        expect(run?.parentSpanContext?.spanId).toBe("2".repeat(16));
        expect(spans.some((s) => /healthz|readyz|metrics/.test(s.name))).toBe(false);
        expect(
          JSON.stringify(
            spans.map((s) => ({
              name: s.name,
              attributes: s.attributes,
              events: s.events,
              status: s.status,
            })),
          ),
        ).not.toMatch(/private-.*canary|private-header/);
        expect(
          spans.filter(
            (s) =>
              s.name === "store.getRun" &&
              s.parentSpanContext?.spanId === run?.spanContext().spanId,
          ).length,
        ).toBeGreaterThan(0);
      }),
    ).pipe(
      Effect.provide(StoreSqlite(":memory:")),
      Effect.provide(ReadinessLive(Effect.void)),
      Effect.provide(TelemetryLive(() => processor).pipe(Layer.provide(config))),
      Effect.provide(config),
    );
  },
);
