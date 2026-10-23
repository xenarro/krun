# Library facts for the gateway (VERIFIED 2026-10-23)

Checked against npm tarballs (`effect` 4.0.6, `@effect/platform-node`
4.0.6, `@effect/vitest` 4.0.6, `fastify` 5.12.7, `find-my-way` 9.10.0,
`fastify-type-provider-zod` 7.0.0, `@fastify/swagger` 9.9.2, `zod` 4.6.7,
`canonicalize` 5.1.0, `kysely` 0.29.7) and local probes against those
versions. Re-check after any Renovate bump (STACK.md section 6). Generic
usage: `zod-4`, `fastify-best-practices`, `vitest`, `effect-*` skills.

- `fastify-type-provider-zod@7.0.0` exports `validatorCompiler`,
  `serializerCompiler`, `jsonSchemaTransform`, `createJsonSchemaTransform`,
  `ZodTypeProvider`, `hasZodFastifySchemaValidationErrors`,
  `isResponseSerializationError`. Peers: `zod >=4.1.5`, `fastify ^5.5.0`,
  `@fastify/swagger >=9.5.1`. Validation is `safeParse`. Serialisation is
  `safeEncode` then `JSON.stringify`, so keys absent from a non-strict
  response schema are stripped: a second guard against leaking `input`
  into BASIC, never the first. OpenAPI 3.1 gets `draft-2020-12`.
- Validation failures are `FST_ERR_VALIDATION` with `validationContext`
  `body`/`querystring`/`params` and items `{ keyword: issue.code,
  instancePath }`. Unknown key: `unrecognized_keys`. `null` on an
  `.optional()` field: `invalid_type`.
- `z.json()` accepts `null`: `input` and `SetResult` need an explicit
  refusal. `canonicalize@5.1.0`: ESM default `(input: unknown) => string |
  undefined`, Node >= 22, throws on lone surrogates, `NaN`, `Infinity`.
- Router (find-my-way 9 in Fastify 5.12.7): literal `:` is `::`.
  `:run(^[^:]+)::wait` matches `/runs/019a:wait` with `run = "019a"`.
  `x:bogus` is 404 only when the plain run route uses the same regex.
  `@fastify/swagger` renders `/runs/{run}:wait`.
- Default parsers: `application/json` and `text/plain`.
  `application/json; charset=utf-8` passes. Another `Content-Type` with a
  body: 415 `FST_ERR_CTP_INVALID_MEDIA_TYPE`. Body over `bodyLimit`: 413
  `FST_ERR_CTP_BODY_TOO_LARGE` before the body is read.
- `onRequest` runs for unmatched routes too (`request.is404`).
  `routeOptions.url` is undefined in the not-found handler.
- `requestIdHeader` defaults to `false`; with a header name set,
  `genReqId` is skipped whenever the header is present. Keep it `false`,
  read `x-request-id` in `genReqId` (length rule there), echo it in
  `onRequest`.
- `reply.hijack()` skips Fastify's send path. Write headers with
  `reply.raw.writeHead`. `onResponse` still fires on `finish`.
- `app.close()`: closing flag, `preClose`, idle sockets reaped,
  `server.close()` waits for in-flight requests. It does NOT end hijacked
  SSE or pending waits: probes blocked 3 s and 6 s without ending them
  first, 2 ms with.
- `handlerTimeout` at server level cannot be opted out per route. Leave it
  unset (wait and SSE would die).
- Effect 4.0.6: `Data.TaggedError`, `Layer.effectDiscard`, `Layer.launch`,
  `Effect.acquireRelease`, `Effect.runPromiseExitWith(ctx)(eff, { signal
  })`, `Effect.timeout` (fails `TimeoutError`, interrupts the source),
  `Deferred`, `FiberSet`, `PubSub`, `Queue.sliding`, `Schedule.spaced`.
  `TestClock` from `effect/testing`. `@effect/vitest` 4.0.6: `it.effect`
  (scoped, test services), `it.live`, `layer(...)`, `it.prop`; no
  `it.scoped`.
- `NodeRuntime.runMain` default teardown exits 130 on an interrupt-only
  exit (measured).
- Kysely 0.29 `execute({ signal, inflightQueryAbortStrategy })`; Postgres
  supports `'cancel query'`. Pass the signal `Effect.tryPromise` gives
  `try` so `Effect.timeout` really cancels the query.
- UNVERIFIED: the generated OpenAPI for a regex path param with a Zod
  `params` schema; check the file in P3.1c.

Fastify facts not probed; confirm against the installed version before
relying on one:

- `trustProxy: true` is the SPEC value; numeric hop counts are disabled in
  5.12.x.
- Hook order: `onRequest` → `preParsing` → parse → `preValidation` →
  validation (400) → `preHandler` → handler → `preSerialization` →
  `onSend` → `onResponse`.
- `setErrorHandler` bumps a `statusCode` below 400 to 500. It sees neither
  404s (use `setNotFoundHandler`) nor stream errors after headers.
- `handlerTimeout` is cancelled by `reply.hijack()`.
- `@fastify/swagger` 9.x: `{ openapi: { openapi: "3.1.0" }, transform:
  jsonSchemaTransform }`, `await app.ready()` then `app.swagger()`.
  `schema.hide: true` hides a route.

## Prior art (dapr, knative/serving)

Lesson, then the krun rule it backs (SKILL.md rule number).

- Size-limit the body before anything reads it (dapr
  `pkg/api/http/middlewares.go:28-40`, `server.go:293-325`): Rule 9.
- One error vocabulary and one mapper (dapr
  `pkg/messages/api_error.go:36-45`, `pkg/api/http/responses.go:154-183`):
  Rule 3.
- Never compare tokens with `!=` (dapr
  `pkg/api/http/middlewares.go:52-82`): Rules 6, 23.
- Not-ready is 503, never 500 (dapr `pkg/messages/predefined.go:63-78` vs
  `pkg/healthz/server/server.go:58`): Rule 3.
- Close listeners concurrently under one deadline, dependencies after in
  reverse (dapr `pkg/api/http/server.go:235-265`,
  `pkg/runtime/runtime.go:500-531`): Rule 32.
- Flip readiness first, keep serving, then close (knative
  `vendor/knative.dev/pkg/network/handlers/drain.go:91-114`,
  `pkg/queue/sharedmain/main.go:310-347`): Rule 32. knative resets its
  quiet period on traffic; SPEC fixes a plain delay. No reset without a
  Decisions row.
- Hijacked streams are invisible to server close (knative
  `pkg/http/handler/hijack.go:27-66`): end them before `app.close()`.
- Never write an error status after the first byte (knative
  `pkg/http/handler/timeout.go:70-156`): a wait answers 201/200 with the
  current run; an SSE stream at shutdown just ends.
- Probes bypass limiters (knative `pkg/queue/handler.go:39-43,70-81`): the
  admin listener has no auth, no rate limit (SPEC.md:183).
