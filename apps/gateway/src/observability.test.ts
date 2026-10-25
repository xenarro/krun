import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { ConfigLive } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { makeHealthApp } from "@krun/shared/dist/health/index.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import { z } from "zod";
import { makePublicApp } from "./app.js";
import { ApiError } from "./errors.js";

class Capture extends Writable {
  output = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    callback();
  }
  lines(): Array<Record<string, unknown>> {
    return this.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
beforeEach(() => {
  for (const name of [
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());
const config = (level = "info") =>
  ConfigLive("gateway", {
    env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p31b", KRUN_LOG_LEVEL: level },
  });
const fixture = Effect.gen(function* () {
  const token = randomBytes(32).toString("hex"),
    limited = randomBytes(32).toString("hex");
  const keys = yield* makeKeys({
    path: "krun-test-p31b-memory",
    read: Effect.succeed(
      Buffer.from(
        JSON.stringify({
          keys: [
            {
              name: "reader",
              key: token,
              scopes: ["functions:read", "runs:write"],
              functions: ["*"],
            },
            { name: "limited", key: limited, scopes: ["runs:read"], functions: ["*"] },
          ],
        }),
      ),
    ),
  });
  const functions = yield* makeFunctions({
    namespace: "krun-test-p31b",
    ceilings: {
      maxActiveDeadline: 86400,
      maxQueued: 1000,
      allowedRegistries: [],
      allowedServiceAccounts: ["krun-job-default"],
      webhookAllowedHosts: [],
    },
  }).pipe(
    Effect.provideService(FunctionSource, {
      watch: () =>
        Stream.succeed({ type: "sync" as const, items: [] }).pipe(Stream.concat(Stream.never)),
    }),
    Effect.provide(ReadinessLive(Effect.void)),
  );
  yield* functions.synced;
  const privateFields = {
    input: "krun-test-private-input",
    result: "krun-test-private-result",
    runtimeStatus: "krun-test-private-runtime",
    error: { details: "krun-test-private-details" },
    dsn: "krun-test-private-dsn",
    body: "krun-test-private-body",
    env: ["krun-test-private-env"],
    manifest: "krun-test-private-manifest",
  };
  const app = yield* makePublicApp({
    routes: async (scope) => {
      scope.get(
        "/v1/functions/:function",
        {
          config: { krun: { scope: "functions:read" } },
          schema: { params: z.strictObject({ function: z.string() }) },
        },
        async (request) => ({ id: request.id }),
      );
      scope.get(
        "/v1/functions/:function/runs/:run",
        {
          config: { krun: { scope: "functions:read" } },
          schema: { params: z.strictObject({ function: z.string(), run: z.string() }) },
        },
        async () => ({ ok: true }),
      );
      scope.get(
        "/v1/parallel",
        { config: { krun: { scope: "functions:read" } } },
        async (request, reply) =>
          scope.runEffect(
            request,
            reply,
            Effect.yieldNow.pipe(
              Effect.andThen(Effect.logInfo("parallel-safe")),
              Effect.as({ id: request.id }),
            ),
          ),
      );
      scope.get(
        "/v1/missing-resource",
        { config: { krun: { scope: "functions:read" } } },
        async () => {
          throw new ApiError({ reason: "RUN_NOT_FOUND" });
        },
      );
      scope.post(
        "/v1/log",
        {
          config: { krun: { scope: "runs:write" } },
          schema: {
            querystring: z.strictObject({ requestId: z.string().max(128).optional() }),
            body: z.strictObject({ input: z.unknown().optional() }),
          },
        },
        async (request, reply) => {
          scope.log.info({ ...privateFields, req: request }, "root-safe");
          request.log.info({ ...privateFields, req: request }, "request-safe");
          await scope.runEffect(
            request,
            reply,
            Effect.logInfo("effect-safe", privateFields).pipe(
              Effect.annotateLogs({ run_id: "run-for-log", state: "running" }),
              Effect.withSpan("krun-test-log-span"),
            ),
          );
          await scope.runEffect(request, reply, Effect.logDebug("debug-safe"));
          return { ok: true };
        },
      );
    },
  }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
  return { app, token, limited };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>, sink: Capture, level = "info") =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        StoreSqlite(":memory:"),
        ReadinessLive(Effect.void),
        TelemetryLive().pipe(Layer.provide(config(level))),
        config(level),
        Layer.succeed(LogDestination, sink),
      ),
    ),
  );

it.effect(
  "401 is one warn audit with null key,accepted/echoed reqId and trusted proxy fields",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app } = yield* fixture;
        const response = yield* Effect.promise(() =>
          app.inject({
            url: "/v1/functions/echo",
            headers: {
              "x-request-id": "client-id",
              "x-forwarded-for": "192.0.2.7",
              "user-agent": "krun-test-agent",
            },
          }),
        );
        expect(response.statusCode).toBe(401);
        expect(response.headers["x-request-id"]).toBe("client-id");
        const lines = sink.lines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          level: 40,
          event: "http_request",
          key: null,
          reqId: "client-id",
          client_ip: "192.0.2.7",
          user_agent: "krun-test-agent",
          route: "/v1/functions/:function",
          code: 401,
          function: "echo",
        });
      }),
      sink,
    );
  },
);
it.effect(
  "403 retains authenticated key name,not credential;success audit includes path/correlation fields",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token, limited } = yield* fixture;
        const denied = yield* Effect.promise(() =>
          app.inject({
            url: "/v1/functions/echo",
            headers: { authorization: `Bearer ${limited}` },
          }),
        );
        expect(denied.statusCode).toBe(403);
        const allowed = yield* Effect.promise(() =>
          app.inject({
            url: "/v1/functions/echo/runs/krun-test-run",
            headers: { authorization: `Bearer ${token}`, "x-request-id": "owned-run-id" },
          }),
        );
        expect(allowed.statusCode).toBe(200);
        expect(sink.lines()[0]).toMatchObject({ level: 40, key: "limited", code: 403 });
        expect(sink.lines()[1]).toMatchObject({
          level: 30,
          key: "reader",
          code: 200,
          run_id: "krun-test-run",
          function: "echo",
          reqId: "owned-run-id",
        });
        expect(sink.output.includes(token) || sink.output.includes(limited)).toBe(false);
      }),
      sink,
    );
  },
);
it.effect(
  "request IDs bound128,generate UUID for absent/empty/oversized,echo even404 and parser errors",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        for (const id of ["a", "a".repeat(128), "", "a".repeat(129), undefined]) {
          const response = yield* Effect.promise(() =>
            app.inject({
              url: "/v1/missing",
              headers: id === undefined ? {} : { "x-request-id": id },
            }),
          );
          const actual = response.headers["x-request-id"];
          if (id && id.length <= 128) expect(actual).toBe(id);
          else
            expect(actual).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
          expect(sink.lines().at(-1)?.reqId).toBe(actual);
        }
        const malformed = yield* Effect.promise(() =>
          app.inject({
            method: "POST",
            url: "/v1/log",
            headers: {
              authorization: `Bearer ${token}`,
              "x-request-id": "parse-id",
              "content-type": "application/json",
            },
            payload: "{",
          }),
        );
        expect(malformed.statusCode).toBe(400);
        expect(malformed.headers["x-request-id"]).toBe("parse-id");
        expect(sink.lines().at(-1)).toMatchObject({ reqId: "parse-id", code: 400 });
      }),
      sink,
    );
  },
);
it.effect(
  "root/request/Effect logging shares pino redaction,request correlation and active span IDs",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        const response = yield* Effect.promise(() =>
          app.inject({
            method: "POST",
            url: "/v1/log?requestId=idempotent-id",
            headers: { authorization: `Bearer ${token}`, "x-request-id": "log-id" },
            payload: { input: { value: "krun-test-input" } },
          }),
        );
        expect(response.statusCode).toBe(200);
        expect(sink.output.includes("krun-test-private") || sink.output.includes(token)).toBe(
          false,
        );
        const lines = sink.lines();
        expect(lines.filter((l) => l.event === "http_request")).toHaveLength(1);
        expect(lines.find((l) => l.msg === "request-safe")).toMatchObject({ reqId: "log-id" });
        expect(lines.find((l) => l.msg === "effect-safe")).toMatchObject({
          reqId: "log-id",
          run_id: "run-for-log",
          state: "running",
          traceId: expect.any(String),
          spanId: expect.any(String),
        });
        expect(lines.find((l) => l.event === "http_request")).toMatchObject({
          idempotency_key: "idempotent-id",
        });
        expect(lines.some((l) => l.msg === "debug-safe")).toBe(false);
      }),
      sink,
    );
  },
);
it.effect("KRUN_LOG_LEVEL governs Effect debug and pino output without disabling metrics", () => {
  const sink = new Capture();
  return run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/v1/log",
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        }),
      );
      expect(sink.lines().some((l) => l.msg === "debug-safe" && l.level === 20)).toBe(true);
    }),
    sink,
    "debug",
  );
});
it.effect(
  "real exporter/admin scrape uses exact bounded labels and counts404 as unmatched,including registered404",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        for (const name of ["one", "two"])
          yield* Effect.promise(() =>
            app.inject({
              url: `/v1/functions/${name}`,
              headers: { authorization: `Bearer ${token}` },
            }),
          );
        for (const url of ["/v1/unknown-one", "/v1/unknown-two", "/v1/missing-resource"])
          yield* Effect.promise(() =>
            app.inject({ url, headers: { authorization: `Bearer ${token}` } }),
          );
        const admin = yield* makeHealthApp;
        yield* Effect.promise(() => admin.inject("/healthz"));
        const reader = yield* MetricsReader;
        const result = yield* reader.scrape;
        const lines = result.body.split("\n");
        expect(lines).toContain("# TYPE krun_http_requests_total counter");
        expect(lines).toContain("# TYPE krun_http_request_seconds histogram");
        const counters = lines.filter((line) => line.startsWith("krun_http_requests_total{"));
        expect(counters.find((line) => line.includes('route="unmatched"'))).toMatch(/\} 3$/);
        expect(counters.find((line) => line.includes('route="/v1/functions/:function"'))).toMatch(
          /\} 2$/,
        );
        expect(counters.find((line) => line.includes('route="/healthz"'))).toMatch(/\} 1$/);
        expect(result.body).not.toMatch(
          /route="\/v1\/functions\/(?:one|two)"|request_id=|reqId=|key=|_total_total|otel_scope_|target_info/,
        );
        for (const line of counters)
          expect(
            line
              .match(/\{([^}]+)\}/)?.[1]
              ?.split(",")
              .map((value) => value.split("=")[0])
              .sort(),
          ).toEqual(["code", "route"]);
        for (const line of lines.filter((line) =>
          line.startsWith("krun_http_request_seconds_count{"),
        ))
          expect(
            line
              .match(/\{([^}]+)\}/)?.[1]
              ?.split(",")
              .map((value) => value.split("=")[0]),
          ).toEqual(["route"]);
      }),
      sink,
    );
  },
);
it.effect("concurrent Effect logs keep their own request IDs", () => {
  const sink = new Capture();
  return run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const ids = ["parallel-one", "parallel-two", "parallel-three"];
      const responses = yield* Effect.all(
        ids.map((id) =>
          Effect.promise(() =>
            app.inject({
              url: "/v1/parallel",
              headers: { authorization: `Bearer ${token}`, "x-request-id": id },
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(
        sink
          .lines()
          .filter((line) => line.msg === "parallel-safe")
          .map((line) => line.reqId)
          .sort(),
      ).toEqual([...ids].sort());
    }),
    sink,
  );
});
it.effect("silent KRUN_LOG_LEVEL suppresses logs but not real request metrics", () => {
  const sink = new Capture();
  return run(
    Effect.gen(function* () {
      const { app } = yield* fixture;
      yield* Effect.promise(() => app.inject("/v1/functions/echo"));
      expect(sink.output).toBe("");
      const reader = yield* MetricsReader;
      const result = yield* reader.scrape;
      expect(
        result.body.split("\n").find((line) => line.startsWith("krun_http_requests_total{")),
      ).toMatch(/\} 1$/);
    }),
    sink,
    "silent",
  );
});
it.live(
  "native router errors and duplicate request-ID fields have bounded correlation,audit and metrics",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app } = yield* fixture;
        const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
        const before = sink.lines().filter((l) => l.event === "http_request").length;
        for (const path of ["/v1/functions/%ZZ", `/v1/functions/${"a".repeat(150)}`]) {
          const result = yield* Effect.promise(
            () =>
              new Promise<{ code: number; id: string | string[] | undefined }>(
                (resolve, reject) => {
                  const req = httpRequest(
                    address,
                    {
                      path,
                      headers: [
                        "host",
                        new URL(address).host,
                        "x-request-id",
                        "one",
                        "x-request-id",
                        "two",
                      ],
                    },
                    (res) => {
                      res.resume();
                      res.once("end", () =>
                        resolve({ code: res.statusCode ?? 0, id: res.headers["x-request-id"] }),
                      );
                    },
                  );
                  req.once("error", reject);
                  req.end();
                },
              ),
          );
          expect(result.code).toBe(400);
          expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(sink.lines().filter((l) => l.event === "http_request").length - before).toBe(2);
        const reader = yield* MetricsReader;
        const scraped = yield* reader.scrape;
        expect(
          scraped.body
            .split("\n")
            .find(
              (line) => line.startsWith("krun_http_requests_total{") && line.includes('code="400"'),
            ),
        ).toMatch(/\} 2$/);
      }),
      sink,
    );
  },
  10000,
);
