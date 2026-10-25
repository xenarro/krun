import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import { Keys, makeKeys } from "@krun/shared/dist/auth/keys.js";
import { Functions, makeFunctions } from "@krun/shared/dist/functions/cache.js";
import { ReadinessLive } from "@krun/shared/dist/health/readiness.js";
import { FunctionSource } from "@krun/shared/dist/k8s/functions.js";
import { StoreSqlite } from "@krun/shared/dist/store/live.js";
import { Effect, Stream } from "effect";
import { z } from "zod";
import { makePublicApp } from "./app.js";

const fixture = Effect.gen(function* () {
  const token = randomBytes(32).toString("base64url");
  const keys = yield* makeKeys({
    path: "owned-review-fixture",
    read: Effect.succeed(
      Buffer.from(
        JSON.stringify({
          keys: [
            {
              name: "reviewer",
              key: token,
              scopes: ["functions:read", "runs:write"],
              functions: ["*"],
            },
          ],
        }),
      ),
    ),
  });
  const functions = yield* makeFunctions({
    namespace: "krun-review-p31a",
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
  let defaults = 0;
  const app = yield* makePublicApp({
    routes: async (scope) => {
      scope.get(
        "/probe/:function",
        {
          config: { krun: { scope: "functions:read" } },
          schema: { params: z.object({ function: z.string() }) },
        },
        async () => ({ ok: true }),
      );
      scope.get(
        "/wrapped-query",
        {
          config: { krun: { scope: "functions:read" } },
          schema: { querystring: z.object({ value: z.string().optional() }).optional() },
        },
        async () => ({ ok: true }),
      );
      scope.post(
        "/wrapped-body",
        {
          config: { krun: { scope: "runs:write" } },
          schema: { body: z.object({ value: z.string().optional() }).optional() },
        },
        async () => ({ ok: true }),
      );
      scope.post(
        "/wrapped-default",
        {
          config: { krun: { scope: "runs:write" } },
          schema: {
            body: z.object({ value: z.string() }).default(() => ({ value: String(++defaults) })),
          },
        },
        async (request) => z.object({ value: z.string() }).parse(request.body),
      );
      scope.post(
        "/strict-body",
        {
          config: { krun: { scope: "runs:write" } },
          schema: { body: z.object({ value: z.string().optional() }) },
        },
        async () => ({ ok: true }),
      );
    },
  }).pipe(Effect.provideService(Keys, keys), Effect.provideService(Functions, functions));
  return { app, token, keys, functions };
});
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    import("@krun/shared/dist/store/index.js").Store | import("effect").Scope.Scope
  >,
) => Effect.scoped(program).pipe(Effect.provide(StoreSqlite(":memory:")));
for (const [label, path] of [
  ["bad-url", "/probe/krun-review-%ZZ"],
  ["long-param", `/probe/${"a".repeat(150)}`],
] as const) {
  it.effect(
    `${label} routing failure uses the canonical envelope rather than native router JSON`,
    () =>
      run(
        Effect.gen(function* () {
          const { app, token } = yield* fixture;
          const response = yield* Effect.promise(() =>
            app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${token}` } }),
          );
          const body = response.json();
          console.log(
            JSON.stringify({
              label,
              status: response.statusCode,
              errorIsObject: typeof body.error === "object",
              nativeCode: body.code,
              reflectsPath: response.body.includes("krun-review-"),
            }),
          );
          expect(typeof body.error).toBe("object");
          expect(body.error.code).toBe(response.statusCode);
          expect(body.error.details[0]["@type"]).toBe("type.googleapis.com/google.rpc.ErrorInfo");
          expect(body.error.details[0].domain).toBe("krun.io");
        }),
      ),
  );
}
it.effect("optional query object cannot silently strip an unknown query parameter", () =>
  run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const response = yield* Effect.promise(() =>
        app.inject({
          method: "GET",
          url: "/wrapped-query?unexpected=private",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      console.log(
        JSON.stringify({
          optionalQuery: {
            status: response.statusCode,
            handlerAccepted: response.statusCode === 200,
          },
        }),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].reason).toBe("REQUEST_INVALID");
    }),
  ),
);
it.effect("optional body object cannot silently strip an unknown body field", () =>
  run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const response = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/wrapped-body",
          headers: { authorization: `Bearer ${token}` },
          payload: { unexpected: "private" },
        }),
      );
      console.log(
        JSON.stringify({
          optionalBody: {
            status: response.statusCode,
            handlerAccepted: response.statusCode === 200,
          },
        }),
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].reason).toBe("REQUEST_INVALID");
    }),
  ),
);
it.effect("unwrapped object and known optional fields provide discriminating controls", () =>
  run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const strict = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/strict-body",
          headers: { authorization: `Bearer ${token}` },
          payload: { unexpected: "private" },
        }),
      );
      expect(strict.statusCode).toBe(400);
      expect(strict.json().error.details[0].reason).toBe("REQUEST_INVALID");
      const known = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/wrapped-body",
          headers: { authorization: `Bearer ${token}` },
          payload: { value: "ok" },
        }),
      );
      expect(known.statusCode).toBe(200);
    }),
  ),
);

it.effect("wrapped body preserves omission/default semantics while rejecting explicit null", () =>
  run(
    Effect.gen(function* () {
      const { app, token } = yield* fixture;
      const headers = { authorization: `Bearer ${token}` };
      const omitted = yield* Effect.promise(() =>
        app.inject({ method: "POST", url: "/wrapped-body", headers }),
      );
      expect(omitted.statusCode).toBe(200);
      for (const url of ["/wrapped-body", "/wrapped-default"]) {
        const result = yield* Effect.promise(() =>
          app.inject({
            method: "POST",
            url,
            headers: { ...headers, "content-type": "application/json" },
            payload: "null",
          }),
        );
        expect(result.statusCode).toBe(400);
        expect(result.json().error.details[0].reason).toBe("REQUEST_INVALID");
      }
      for (const value of ["1", "2"]) {
        const result = yield* Effect.promise(() =>
          app.inject({ method: "POST", url: "/wrapped-default", headers }),
        );
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ value });
      }
      const unknown = yield* Effect.promise(() =>
        app.inject({
          method: "POST",
          url: "/wrapped-default",
          headers,
          payload: { unexpected: "private" },
        }),
      );
      expect(unknown.statusCode).toBe(400);
    }),
  ),
);

it.effect(
  "unsupported root forms fail registration rather than silently admit unknown members",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const body of [
          z.object({}).catch({}),
          z.object({}).nullable(),
          z.object({}).transform((value) => value),
          z.unknown(),
        ]) {
          const failure = yield* Effect.flip(
            makePublicApp({
              routes: async (scope) => {
                scope.post(
                  "/unsupported",
                  { config: { krun: { scope: "runs:write" } }, schema: { body } },
                  async () => ({ ok: true }),
                );
              },
            }).pipe(
              Effect.provideService(Keys, f.keys),
              Effect.provideService(Functions, f.functions),
            ),
          );
          expect(failure._tag).toBe("PublicAppError");
        }
      }),
    ),
);

it.live(
  "router failures use sanitized canonical envelopes on actual sockets with and without credentials",
  () =>
    run(
      Effect.gen(function* () {
        const { app, token } = yield* fixture;
        const address = yield* Effect.promise(() => app.listen({ host: "127.0.0.1", port: 0 }));
        for (const path of [
          "/probe/krun-review-%ZZ",
          "/probe/%C0%AF",
          `/probe/${"krun-review-".repeat(15)}`,
        ]) {
          for (const credential of [undefined, token]) {
            const result = yield* Effect.promise(
              () =>
                new Promise<{ status: number; body: string }>((resolve, reject) => {
                  const request = httpRequest(
                    address,
                    {
                      path,
                      ...(credential === undefined
                        ? {}
                        : { headers: { authorization: `Bearer ${credential}` } }),
                    },
                    (response) => {
                      let body = "";
                      response.setEncoding("utf8");
                      response.on("data", (chunk) => {
                        body += chunk;
                      });
                      response.once("end", () =>
                        resolve({ status: response.statusCode ?? 0, body }),
                      );
                    },
                  );
                  request.once("error", reject);
                  request.end();
                }),
            );
            expect(result.status).toBe(400);
            expect(JSON.parse(result.body).error).toMatchObject({
              code: 400,
              status: "INVALID_ARGUMENT",
              details: [{ reason: "REQUEST_INVALID", domain: "krun.io" }],
            });
            expect(result.body).not.toMatch(/FST_ERR|krun-review|%ZZ|%C0/);
            expect(result.body).not.toContain(token);
          }
        }
      }),
    ),
  10000,
);
