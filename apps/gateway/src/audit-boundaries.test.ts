import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { ConfigLive } from "@krun/shared/dist/config/index.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { MetricsReader } from "@krun/shared/dist/health/metrics.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { LogDestination } from "@krun/shared/dist/runtime/logging.js";
import { TelemetryLive } from "@krun/shared/dist/runtime/telemetry.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { Effect, Layer, Stream } from "effect";
import { z } from "zod";
import { makePublicApp } from "./app.js";

class Capture extends Writable {
  output = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString();
    callback();
  }
  audits(): Array<Record<string, unknown>> {
    return this.output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "http_request");
  }
}
const fixture = Effect.gen(function* () {
  const token = randomBytes(32).toString("hex");
  const keys = yield* makeKeys({
    path: "krun-test-p31b-contracts-memory",
    read: Effect.succeed(
      Buffer.from(
        JSON.stringify({
          keys: [{ name: "reviewer", key: token, scopes: ["runs:write"], functions: ["*"] }],
        }),
      ),
    ),
  });
  const functions = yield* makeFunctions({
    namespace: "krun-test-p31b-contracts",
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
  const app = yield* makePublicApp({
    routes: async (scope) => {
      scope.get("/v1/forbidden", { config: { krun: { scope: "functions:read" } } }, async () => ({
        ok: true,
      }));
      scope.post(
        "/v1/functions/:function/runs",
        {
          config: { krun: { scope: "runs:write" } },
          schema: {
            params: z.strictObject({ function: z.string() }),
            querystring: z.strictObject({ requestId: z.string().max(128).optional() }),
            body: z.strictObject({ input: z.record(z.string(), z.unknown()) }),
          },
        },
        async (_request, reply) => reply.code(201).send({ ok: true }),
      );
      scope.get("/v1/control", { config: { krun: { scope: "runs:write" } } }, async () => ({
        ok: true,
      }));
    },
  }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
  return { app, token };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>, sink: Capture) => {
  const config = ConfigLive("gateway", {
    env: { KRUN_DB_MODE: "embedded", KRUN_NAMESPACE: "krun-test-p31b-contracts" },
  });
  return Effect.scoped(effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        StoreSqlite(":memory:"),
        ReadinessLive(Effect.void),
        TelemetryLive().pipe(Layer.provide(config)),
        config,
        Layer.succeed(LogDestination, sink),
      ),
    ),
  );
};
it.effect("accepted CreateRun-shaped query requestId is present in the audit", () => {
  const sink = new Capture();
  return run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const response = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/v1/functions/echo/runs?requestId=query-correlation",
          headers: { authorization: `Bearer ${token}` },
          payload: { input: {} },
        }),
      );
      expect(response.statusCode).toBe(201);
      expect(sink.audits()).toHaveLength(1);
      expect(sink.audits()[0]).toMatchObject({
        idempotency_key: "query-correlation",
        function: "echo",
        key: "reviewer",
      });
    }),
    sink,
  );
});
it.effect(
  "401 audit includes present parsed query idempotency before a handler can set metadata",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app } = yield* fixture;
        const response = yield* Effect.promise(() =>
          app.inject({
            method: "POST",
            url: "/v1/functions/echo/runs?requestId=denied-correlation",
            payload: { input: {} },
          }),
        );
        expect(response.statusCode).toBe(401);
        expect(sink.audits()[0]).toMatchObject({
          key: null,
          idempotency_key: "denied-correlation",
        });
      }),
      sink,
    );
  },
);
it.effect("invalid body requestId is not published as an idempotency key", () => {
  const sink = new Capture();
  return run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const response = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/v1/functions/echo/runs",
          headers: { authorization: `Bearer ${token}` },
          payload: { input: {}, requestId: "invalid-body-value" },
        }),
      );
      expect(response.statusCode).toBe(400);
      expect(sink.audits()[0]).not.toHaveProperty("idempotency_key");
    }),
    sink,
  );
});
it.live(
  "native absolute-form v1 target emits one audit, just like origin-form",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
        for (const target of ["/v1/control", `${address}/v1/control`]) {
          const before = sink.audits().length;
          const result = yield* Effect.promise(
            () =>
              new Promise<{ code: number; id: unknown }>((resolve, reject) => {
                const request = httpRequest(
                  address,
                  {
                    path: target,
                    headers: {
                      authorization: `Bearer ${token}`,
                      "x-request-id": "native-correlation",
                    },
                  },
                  (response) => {
                    response.resume();
                    response.on("end", () =>
                      resolve({
                        code: response.statusCode ?? 0,
                        id: response.headers["x-request-id"],
                      }),
                    );
                  },
                );
                request.on("error", reject);
                request.end();
              }),
          );
          expect(result).toEqual({ code: 200, id: "native-correlation" });
          expect(sink.audits().length - before).toBe(1);
        }
        const reader = yield* MetricsReader;
        const scrape = yield* reader.scrape;
        expect(
          scrape.body
            .split("\n")
            .find(
              (line) =>
                line.startsWith("krun_http_requests_total{") &&
                line.includes('route="/v1/control"'),
            ),
        ).toMatch(/\} 2$/);
      }),
      sink,
    );
  },
  10000,
);

it.live(
  "native origin/http/https targets preserve audit membership and bounded failure metadata",
  () => {
    const sink = new Capture();
    return run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
        const cases = [
          { path: "/v1/control", auth: true, code: 200, audit: true },
          { path: "/v1/control", auth: false, code: 401, audit: true },
          { path: "/v1/forbidden", auth: true, code: 403, audit: true },
          { path: "/v1/not-found", auth: false, code: 404, audit: true },
          {
            path: "/v1/control?unknown=krun-test-private-query",
            auth: true,
            code: 400,
            audit: true,
          },
          { path: "/v1/%ZZ", auth: false, code: 400, audit: true },
          { path: "/v1/../outside", auth: false, code: 404, audit: true },
          { path: "/v10/control", auth: false, code: 404, audit: false },
          { path: "/outside?next=/v1/control", auth: false, code: 404, audit: false },
          { path: "/outside/../v1/control", auth: false, code: 404, audit: false },
        ];
        for (const prefix of [
          "",
          "http://krun-test-authority.invalid",
          "https://krun-test-authority.invalid",
        ]) {
          for (const [index, item] of cases.entries()) {
            const id = `matrix-${prefix.length}-${index}`;
            const before = sink.audits().length;
            const result = yield* Effect.promise(
              () =>
                new Promise<{ code: number; id: unknown }>((resolve, reject) => {
                  const request = httpRequest(
                    address,
                    {
                      path: prefix + item.path,
                      headers: {
                        "x-request-id": id,
                        ...(item.auth ? { authorization: `Bearer ${token}` } : {}),
                      },
                    },
                    (response) => {
                      response.resume();
                      response.once("end", () =>
                        resolve({
                          code: response.statusCode ?? 0,
                          id: response.headers["x-request-id"],
                        }),
                      );
                    },
                  );
                  request.once("error", reject);
                  request.end();
                }),
            );
            expect(result).toEqual({ code: item.code, id });
            expect(sink.audits().length - before).toBe(item.audit ? 1 : 0);
            if (item.audit) {
              expect(sink.audits().at(-1)).toMatchObject({
                reqId: id,
                code: item.code,
                level: item.code === 401 || item.code === 403 ? 40 : 30,
              });
              if (item.code === 404) expect(sink.audits().at(-1)?.route).toBe("unmatched");
            }
          }
        }
        expect(
          sink.output.includes(token) ||
            sink.output.includes("krun-test-private-query") ||
            sink.output.includes("krun-test-authority.invalid"),
        ).toBe(false);
      }),
      sink,
    );
  },
  10000,
);
