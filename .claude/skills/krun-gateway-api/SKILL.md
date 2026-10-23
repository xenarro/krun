---
name: krun-gateway-api
description: Use when building krun gateway routes, auth, wait or SSE. Implements docs/API.md and docs/INTERNAL-API.md on three Fastify 5 listeners run as scoped Effect 4 layers, with Zod 4 route schemas, API keys with picomatch globs, per-run tokens and request spans honouring traceparent.
---

# krun gateway API

Covers `apps/gateway/src` and `packages/shared/src/auth`: the public `/v1`
listener (docs/API.md, AIP-style), the internal `/internal/v1` listener
(docs/INTERNAL-API.md), API keys and scopes, `requestId` idempotency, rate
limit, `wait`/`WaitRun`, `WatchRun` SSE, `CancelRun`, `GetRunResult`,
request spans and the gateway drain. PLAN tasks P2.4, P3.1a-P3.8, P5.1,
P5.2. Owned elsewhere: admin listener, config, Logger, metrics and the
telemetry layer (`krun-process-runtime`), the Store and
`toRun`/`toRunSummary` (`krun-store`), the callback address check and
presigner (`krun-webhooks-objstore`), Function validation and the informer
cache (`krun-functions-crd`).

## When to use

Any task that adds or changes a route, hook, listener layer, error tag or
envelope mapping, the keys loader, request spans or `traceparent`
handling, OpenAPI generation or the gateway's SIGTERM path; and when
reviewing a branch for those tasks.

## Read first

- SPEC.md section 4 (SPEC.md:176-318): listeners 178-189, public rules
  212-279, wait 295-297, internal 299-318; section 5 CAS and `actor`
  (SPEC.md:341-356); Store interface and mappers (SPEC.md:489-546); API keys
  and internal token (SPEC.md:956-990); webhooks (SPEC.md:1076-1088);
  section 11 telemetry, logs, audit, health, shutdown (SPEC.md:1141-1206);
  gateway env and `OTEL_*` (SPEC.md:1208-1253); D24, D25, D27, D30, D34,
  D35, D36 (SPEC.md:1528-1540).
- docs/API.md and docs/INTERNAL-API.md in full: normative, they win over
  this skill.
- docs/STACK.md: 2.1-2.2 (Zod, Fastify, provider), 2.5 (`picomatch`,
  `canonicalize`, `uuid`), 2.6 (OpenTelemetry), 4.1 process shape, 4.2
  errors, 4.3 rule map (spans, globs, timeouts), 4.4 time.
- PLAN.md Phase 3 (PLAN.md:363-465), P2.4 (PLAN.md:346-350), Phase 5 gate,
  P5.1, P5.2 (PLAN.md:616-637), allowlist and in-house list (PLAN.md
  section 2).
- Skills to load (CLAUDE.md rule 7, docs/STACK.md section 5): project
  `zod-4` (schema API), `fastify-best-practices` (hooks, plugins, `inject`
  only: route schemas are Zod, shutdown is scope finalizers, and no plugin
  outside docs/STACK.md is added), `vitest` (config, CLI); user-level
  `effect-core-patterns`, `effect-error-handling`,
  `effect-dependency-injection`, `effect-resource-management`,
  `effect-concurrency`, `effect-testing`. Those target Effect 3:
  `node_modules/effect/AGENTS.md` and Effect's `MIGRATION.md` win
  (`Context.Service`, no `Runtime<R>`, `Context.Reference`).
- References: `references/endpoints.md` (routes with Fastify patterns,
  CreateRun check order, both error tables with the tag per row, tag
  list), `references/sse-wait.md` (fan-out, wait, SSE, drain),
  `references/keys-yaml.md` (format, scopes, picomatch globs, constant-time
  lookup, reload), `references/library-facts.md` (verified library
  behaviour). Span table and `traceparent` parser:
  `krun-process-runtime` `references/telemetry.md`.

## Rules

1. Three Fastify instances, one per listener, each a scoped `Layer`
   (docs/STACK.md 4.1); each answers 404 `ROUTE_NOT_FOUND` for the other
   listeners' paths (SPEC.md:178-181): `/internal/*` on public, `/v1/*` on
   internal and admin (PLAN.md:438, 461-463).
2. Every error, framework ones included, is the AIP-193 envelope `{ error:
   { code, message, status, details } }`, `details[0]` a
   `google.rpc.ErrorInfo` (`reason`, `domain: "krun.io"`, `metadata`);
   `setNotFoundHandler` and `setErrorHandler` on every instance
   (SPEC.md:218-224, docs/API.md section 4, INTERNAL-API.md section 6).
3. Failures are `Data.TaggedError`s in the handler Effect's error channel;
   ONE function `toEnvelope` in `packages/shared/src/runtime` maps tag to
   HTTP code, `status`, `reason`, `metadata`, `Retry-After`; nothing else
   sets an error status. A defect is 500 `INTERNAL`, generic `message`,
   logged at error. No `throw` outside adapters (`Effect.tryPromise`)
   (docs/STACK.md 4.2, PLAN.md:107).
4. Routes use Zod 4 through `fastify-type-provider-zod` (`validatorCompiler`,
   `serializerCompiler`); bodies and query strings are `z.strictObject`
   (unknown field or parameter 400 `REQUEST_INVALID`); `.optional()`, never
   `.nullable()`, so `null` is rejected (SPEC.md:245-246, docs/API.md:36-40,
   50-51, docs/STACK.md 2.1). Effect Schema is not used.
5. Remove Fastify's default `text/plain` parser on public and internal: a
   `text/plain` POST must be 415 `CONTENT_TYPE_UNSUPPORTED`, not a Zod 400
   (PLAN.md:377-378; `references/library-facts.md`).
6. Auth in `onRequest`, skipped when `request.is404`: bearer SHA-256
   compared with `timingSafeEqual` against every configured hash, scope,
   then globs and owner; 401 before 403 before 404 (SPEC.md:214-217,
   956-957, docs/API.md:330-334). Body-dependent work runs after parse
   (`preHandler` or handler); `request.body` is undefined in `onRequest`.
7. A non-admin key sees only Ready functions matching its globs (else 404
   `FUNCTION_NOT_FOUND`, one generic message) and runs it created (else 404
   `RUN_NOT_FOUND`); `admin` sees everything (SPEC.md:150-153, 215-217,
   972-973, docs/API.md:190-193, 225-227).
8. Key globs are `picomatch` matchers, `picomatch(globs, { nocase: false,
   dot: true })` compiled once per key per load, never a hand-written
   glob-to-regex (docs/STACK.md 2.5, 4.3). Details:
   `references/keys-yaml.md` section 3.
9. Body caps from `Content-Length` and the counted stream, before parsing:
   public `bodyLimit = KRUN_MAX_INPUT_BYTES` (413 `INPUT_TOO_LARGE`,
   `reason="input_size"`); internal per-route 16384 status, 32768 error,
   `KRUN_MAX_RESULT_BYTES` result (413 `REQUEST_TOO_LARGE` /
   `RESULT_TOO_LARGE`, body unread, `Connection: close`); map
   `FST_ERR_CTP_BODY_TOO_LARGE` per listener and route in `setErrorHandler`
   (SPEC.md:274-275, 317-318, INTERNAL-API.md:85-89, PLAN.md:446-447). Do
   not count bytes yourself in `preParsing` unless a test proves
   `bodyLimit` is not enough.
10. `CreateRun` order is fixed: key, scope, rate limit, function (Ready, in
    globs) in `onRequest`; then cap and parse; then `requestId` lookup,
    `inputSchema`, priority, callback, `maxQueued`, insert. Replay: 201,
    `Location`, `Idempotent-Replay: true`, current FULL run, honours
    `wait`; other fingerprint 409 `ABORTED` `IDEMPOTENCY_CONFLICT`
    (docs/API.md:199-211, SPEC.md:225-233, PLAN.md:396-410). Table:
    `references/endpoints.md` section 3.
11. Fingerprint = lowercase hex SHA-256 (`node:crypto`) of `canonicalize({
    input, priority: priority ?? 0, callback: callback ?? null })` (RFC 8785,
    `canonicalize ^5.1`) over the body as received, before the Function
    default callback; `requestId` and `wait` excluded; stored as
    `request_hash`; `requestId` at most 128 characters (SPEC.md:225-228,
    527-529, docs/API.md:199-204, docs/STACK.md 2.5). No in-house JCS.
12. `priority` int 0-9, above 0 needs `runs:priority` (403 `SCOPE_MISSING`,
    `metadata.scope`); the Function's `callback` is copied into the run
    when the request has none (SPEC.md:164-165, 234-235, D25).
13. Callback host glob and resolved-address check at create via the webhook
    package: 400 `CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field =
    "callback.url"` (SPEC.md:1076-1082, docs/API.md:327). Delivery
    re-checks; not yours.
14. Rate limit: in-house token bucket per key name per replica, refilled
    from `Clock.currentTimeMillis`, `KRUN_RATE_LIMIT_RPS` and
    `KRUN_RATE_LIMIT_BURST`, 429 `RATE_LIMITED`; `maxQueued` via
    `countQueued` / `countQueuedBy`, 429 `QUEUE_FULL` `metadata.limit`
    `function` or `key`; every 429 and 503 carries `Retry-After: 1`
    (SPEC.md:266-268, 500-501, 980-981, docs/API.md:339-342).
15. `krun_admission_rejections_total{reason}` with exactly `rate_limit`,
    `max_queued`, `input_size`, `schema` (SPEC.md:1165), an Effect
    `Metric` from `krun-process-runtime`.
16. Resource names `functions/{function}/runs/{run}`; `{function}` may be
    `-` in `GetRun`, `ListRuns` and the run custom methods; `{run}` is a
    lowercase UUIDv7 (docs/API.md:18-22). `:wait`, `:cancel`, `:getResult`,
    `:watch` are Fastify paths with `::` and a regex `:run` param
    (`references/endpoints.md` section 2). No `DeleteRun`, no `UpdateRun`.
17. Views: `GetRun`, `CreateRun`, `WaitRun`, `CancelRun` return FULL via
    `toRun`; `GetRun` accepts `view=BASIC`; `ListRuns` items, SSE data and
    webhooks are BASIC via `toRunSummary` (SPEC.md:241-244, 264-265). Never
    hand-build run JSON in a route: it leaks `input` into BASIC payloads.
18. Paging (AIP-158/160): `ListRuns` order `createTime desc, id desc`;
    `pageSize` absent or 0 is 50, above 200 coerced, negative 400; opaque
    token wraps the Store cursor with parent and `filter` hash (mismatch or
    malformed 400 `REQUEST_INVALID`); filter grammar else 400
    `FILTER_INVALID`; `nextPageToken` `""` on the last page;
    `ListFunctions` same paging, by `name`, no filter (SPEC.md:236-240,
    docs/API.md:55-60, 182-186, 229-249).
19. `CancelRun`: `transition(id, from, "cancelling", null, {}, { actor:
    key.name })` from queued, scheduled, running (CAS: zero rows, re-read
    and decide again); already `cancelling`/`cancelled` is 200, no
    transition; `succeeded`/`failed` is 400 `FAILED_PRECONDITION`
    `RUN_TERMINAL` `metadata.state` (SPEC.md:269-273, 341-356,
    PLAN.md:421-427).
20. `GetRunResult`: inline result 200, the document itself as JSON;
    `result_ref` only: 307 to a GET presigned for 300 s, `Cache-Control:
    no-store`; neither: 404 `RESULT_MISSING`; not terminal: 400
    `RUN_NOT_TERMINAL`; a failed or cancelled run may keep an inline result
    (SPEC.md:656-657, docs/API.md:269-281).
21. `wait` and `WaitRun.timeout`: duration grammar, capped at
    `KRUN_MAX_WAIT` (exposed as `Function.maxWait`); waiter registered
    before the insert; 1 s poll fallback; 201/200 at timeout; disconnect
    never cancels the run; the drain answers waits at once
    (SPEC.md:232-233, 295-297, 545-546, 1198-1203). Details:
    `references/sse-wait.md`.
22. `WatchRun` is in-house SSE on `reply.raw` after `reply.hijack()`: first
    `state` event with the BASIC run (terminal: one event then EOF), one
    event per changed group, `id` the field's own time, `: keepalive` every
    15 s (`Schedule.spaced`), `Last-Event-ID` ignored, ends on terminal and
    on shutdown (SPEC.md:253-258, docs/API.md:283-295, PLAN.md section 2).
    `reply.send()` would serialise and end the response.
23. Internal auth: per-run token SHA-256 + `timingSafeEqual` against
    `job_token_hash`, valid in `queued` with a token, `scheduled`, `running`;
    API keys rejected; every 401 is `TOKEN_INVALID`, never logged or echoed
    (SPEC.md:301-305, 983-990, INTERNAL-API.md:48-66, D27).
24. Internal order: route/version 404, token 401, `Content-Type` 415, cap
    413, validation 400, status rate limit 429, guarded write (zero rows
    401, nothing notified); each store call `Effect.timeout("5 seconds")`
    from after validation, the query aborted, then 503 `NOT_READY`
    (INTERNAL-API.md:97-104, docs/STACK.md 4.3).
25. `ReportStatus`: one accepted report per second per run per replica,
    window from the last 204 on `Clock` (a 429 or failed write does not
    extend it); body replaces `runtime_status` wholesale; `at` from
    `DateTime.now`; `reportTime` in the body is 400; notify only, no
    `run_events` (SPEC.md:316, INTERNAL-API.md:138-149).
26. `SetError` stored with `source: FUNCTION`, never changes state; field
    limits are UTF-8 bytes of compact `JSON.stringify`; `SetResult` rejects
    `null`; `GetInput` re-serialises with `Content-Length` (SPEC.md:315-318,
    INTERNAL-API.md:90-94, 106-206).
27. Version: `^/internal/v([1-9]\d*)(/|$)` with a version other than 1 is
    404 `UNSUPPORTED_API_VERSION` in the not-found handler, before auth;
    `User-Agent` logged, never gated (INTERNAL-API.md:36-43, D24).
28. `X-Request-Id`: up to 128 characters kept, else a UUID; echoed on every
    response; `reqId` on request-scoped log lines, Effect ones included;
    `trustProxy: true` for `client_ip` (SPEC.md:276-277, 1188-1191).
29. Audit one line per `/v1` request, info (warn on 401/403): `key` (name or
    null), `client_ip`, `user_agent`, `route`, `code`, `run_id`, `function`,
    `idempotency_key`; never the key, token, input, result, runtime status
    or a body (SPEC.md:1101-1103, 1181-1191). Redaction:
    `krun-process-runtime`.
30. Every `/v1` and `/internal/v1` request is an Effect span (kind
    `server`, name `<METHOD> <route template>`, attributes method, route,
    status code, and `krun.run_id` whenever the request is about one run:
    on `CreateRun` once the id exists, on the internal API the run in the
    path). A valid incoming W3C `traceparent` on either API becomes the
    span's parent; a missing or malformed header starts a new trace and is
    never an error; `tracestate` is not read in v1 (SPEC.md:1147-1156).
    Parser, span table and the request-span placement:
    `krun-process-runtime` `references/telemetry.md`. Span attributes
    never carry the key, token, `Authorization`, input, result,
    `runtimeStatus` or `error.details`. The admin listener is not traced.
    v1 does not join a run's spans into one trace: no trace column on the
    run, no trace variable to the pod; `krun.run_id` is the correlation.
31. Time only from `Clock`/`DateTime` (`DateTime.formatIso`); run ids
    `v7({ msecs })` with `Clock.currentTimeMillis`; no `Date.now()`,
    `new Date()`, `setTimeout`, `setInterval` in gateway code (CLAUDE.md
    rule 8, docs/STACK.md 2.5, 4.4).
32. Drain: readiness 503, serve `KRUN_SHUTDOWN_DELAY`, end SSE streams,
    answer waits, close the listeners, pool last, exit 0 (SPEC.md:1198-1206,
    D30, PLAN.md:432-441). `/v1` and `/internal/v1` never answer
    `NOT_READY` during the drain (docs/API.md:342). Shutdown is scope
    finalizers; no signal handler of your own.
33. OpenAPI 3.1 from the Zod routes via `@fastify/swagger` +
    `jsonSchemaTransform` into `docs/api/openapi-public.json` and
    `openapi-internal.json` in `make generate`; response enums `string`
    with known values in `.meta({ description })`; no nullable schema; a
    diff against the docs is a bug (SPEC.md:278-279, docs/API.md:466-469,
    PLAN.md:383-388, 455-461, D24).
34. Zod validates krun's own schemas only; `input` against `inputSchema`
    uses the cached Ajv validator from the Function cache (SPEC.md:146-148,
    docs/STACK.md principle 3), with violations as
    `BadRequest.fieldViolations`; never the route compiler.

## Process shape (P3.1a, P3.7; docs/STACK.md 4.1)

- `main.ts`: `NodeRuntime.runMain(Layer.launch(Layer.mergeAll(PublicServer,
  InternalServer, AdminServer).pipe(Layer.provide(AppLayer),
  Layer.provide(Telemetry))), { teardown })`; `AppLayer` holds Config,
  Logger, Database, Store, Functions, Keys, Metrics, Readiness, Drain,
  Notifier; `Telemetry` is the `@effect/opentelemetry` layer from
  `krun-process-runtime`.
- A server layer is `Layer.effectDiscard(Effect.acquireRelease(acquire,
  release))`. Acquire: `buildPublicApp` (an Effect needing the services)
  builds `Fastify({ trustProxy: true, return503OnClosing: false, genReqId
  })`, sets the Zod compilers, registers routes, then `listen({ host:
  "0.0.0.0", port })` parsed from `:8080`-style addresses (Fastify's
  default host is `localhost`). Release: the drain. Handler tests call
  `buildPublicApp` and `app.inject()`, no socket.
- Handlers run Effects with the context captured at build:
  `const ctx = yield* Effect.context<Services>()`, then per request
  `Effect.runPromiseExitWith(ctx)(program, { signal: request.signal })`;
  `request.signal` aborts on client disconnect, which interrupts the fiber
  (docs/STACK.md 4.1). `ManagedRuntime` is the other documented bridge;
  pick one for the whole gateway.
- The request span (Rule 30) wraps the Effect run in this same place, so
  store calls made by the handler (spans owned by `krun-store`) nest under
  it and log lines inside it carry `traceId` and `spanId`. The `CreateRun`
  span is the one docs/OPERATIONS.md "Telemetry" tells operators to find.
- Map the `Exit`: success sends; a failure goes through `toEnvelope`; an
  interrupt after disconnect sends nothing.
- Drain: the shared `Drain` from `krun-process-runtime` runs once per
  process (sets `draining` on the `Readiness` `Ref`, then
  `Effect.sleep(shutdownDelay)`); the gateway adds the `shuttingDown`
  `Deferred` it completes; every server release awaits it, then
  `app.close()`. `KRUN_SHUTDOWN_DELAY` must elapse once per process, not
  once per listener. `Layer.mergeAll` releases siblings in parallel
  (measured), but sharing the drain keeps the delay single without relying
  on that.
- `return503OnClosing: false`: otherwise a request on a kept-alive
  connection after `close()` starts gets Fastify's own plain 503, outside
  the envelope.
- `runMain`'s default teardown exits 130 on an interrupt-only exit
  (measured); SPEC wants 0 after SIGTERM, so pass a `teardown` mapping
  interrupt-only to 0 (shared with the scheduler, `krun-process-runtime`).
- Metric `route` label = `request.routeOptions.url` (registered pattern),
  `unmatched` in the not-found handler (SPEC.md:1163). The counter and
  histogram are Effect `Metric`s from `krun-process-runtime`, exported by
  the OpenTelemetry Prometheus exporter with the SPEC section 11 names.

## Errors (docs/STACK.md 4.2)

Tag list, Store-tag translation and framework-error mapping:
`references/endpoints.md` section 7. `message` never carries input
values, the key, the token, SQL or a stack.

## Library facts

`references/library-facts.md` holds the verified facts these rules rest
on: provider exports and error shapes, `z.json()` accepting `null`, the
`::` router patterns, default parsers, `close()` not ending hijacked
streams, `runMain` exiting 130, the Effect 4 and `@effect/vitest` names,
plus Fastify facts to confirm against the installed version. Read it
before P3.1a, P3.7 and P5.2.

## Lessons from dapr and knative/serving

- Size-limit the body before anything reads it (dapr
  `pkg/api/http/middlewares.go:28-40`, `server.go:293-325`); one error
  vocabulary and mapper (dapr `pkg/messages/api_error.go:36-45`,
  `pkg/api/http/responses.go:154-183`); never compare tokens with `!=`
  (dapr `pkg/api/http/middlewares.go:52-82`); not-ready is 503, never 500
  (dapr `pkg/messages/predefined.go:63-78` vs
  `pkg/healthz/server/server.go:58`). Rules 3, 6, 9, 23.
- Close listeners concurrently under one deadline, dependencies after in
  reverse (dapr `pkg/api/http/server.go:235-265`,
  `pkg/runtime/runtime.go:500-531`). Rule 32.
- Flip readiness first, keep serving, then close (knative
  `vendor/knative.dev/pkg/network/handlers/drain.go:91-114`,
  `pkg/queue/sharedmain/main.go:310-347`). knative resets its quiet period
  on traffic; SPEC fixes a plain delay: no reset without a Decisions row.
- Hijacked streams are invisible to server close (knative
  `pkg/http/handler/hijack.go:27-66`); never write an error status after
  the first byte (`pkg/http/handler/timeout.go:70-156`): a wait answers
  201/200 with the current run, an SSE stream at shutdown just ends.
- Probes bypass limiters (knative `pkg/queue/handler.go:39-43,70-81`): the
  admin listener has no auth, no rate limit (SPEC.md:183).

## Pitfalls

- A `Map` keyed by the bearer string is not constant-time
  (`references/keys-yaml.md` section 4).
- A hand-written glob regex (`*` to `.*` and friends) is wrong at this
  trust boundary; key globs are `picomatch` matchers (Rule 8).
- Auth that ignores `request.is404` turns an unknown internal path into
  401 instead of 404 (INTERNAL-API.md:36-40).
- A disconnect interrupts the handler fiber; make the insert
  `Effect.uninterruptible` so it never half-creates a run and only the
  following wait ends (docs/API.md:220-221).
- An app built outside the `it.effect` body runs on the live clock and
  `TestClock.adjust` does nothing; build it inside the test.
- A timer on `setTimeout` instead of `Effect.sleep`/`Schedule` cannot be
  driven by `TestClock` (rate refill, status window, wait, keepalive,
  drain).
- A server-level `handlerTimeout` cannot be opted out per route and would
  kill `wait` and SSE; leave it unset and bound waits with Effect.
- Rate limit and `maxQueued` counters are per replica by design
  (SPEC.md:266-267, section 10); no shared store (D4).
- The `requestId` lookup runs after rate limit and function resolution: a
  replay still spends a token and still 404s on a non-Ready function; a
  replay with `wait` waits too.
- `CANCELLING` has no timestamp column; its SSE `id` is the read time from
  `DateTime.now`.
- Stored status key is `at`, wire name `reportTime` (PLAN.md:450, 465).
- Never log `req.headers.authorization`, bodies, `input`, `result`,
  `runtimeStatus`, `error.details` (SPEC.md:1183-1186); tests mint keys
  (PLAN.md:33).
- `traceparent` on the public API is caller-controlled: with the
  `parentbased_traceidratio` sampler a caller's `sampled` flag decides
  sampling for its own requests. That is what SPEC asks ("honoured"); do
  not override it per listener without a Decisions row.

## Before marking a task done

- Phase 3 gate: `pnpm exec vitest run apps/gateway/src` green against
  SQLite in memory plus one POST-then-GET route test on testcontainers
  Postgres (PLAN.md:365-367). Tests: `@effect/vitest` `it.effect` (scoped),
  `layer(...)`, `TestClock.adjust` for every timer, Fastify `inject`,
  `fast-check` for the fingerprint, filter parser and duration grammar; no
  test sleeps. Span assertions use an in-memory exporter
  (`krun-process-runtime` `references/telemetry.md` "Tests").
- Per task: the acceptance text in PLAN.md:346-350 (P2.4), 369-465 (P3.x),
  625-637 (P5.1, P5.2); P3.3 and P3.8 need one test per error-table row.
- `make generate && git diff --exit-code` for P3.1c and P3.8 (OpenAPI files
  committed under `docs/api/`).
- `make check` (CLAUDE.md rule 3, PLAN.md:17-18).
- Branch named after the task (`p3-3-create-run`), Conventional Commit with
  scope `gateway` or `shared`, PR to main, merge on green, never push main
  (PLAN.md:13-22); append `2026-MM-DD P3.3 <short sha> note` to PLAN
  section 6 and commit it with the code. No `Co-Authored-By`, ever
  (CLAUDE.md rule 5).
- Public API shape, section 9 policy and non-goals are owner decisions:
  `BLOCKED`, never a Decisions row (PLAN.md:23-28).

## Limitations

- SPEC names no final SSE event for shutdown; the stream just ends
  (docs/API.md:291-293). No `event: shutdown` without a Decisions row.
- The keys loader on a malformed file after a good startup is not fixed by
  SPEC; `references/keys-yaml.md` records the conservative reading (keep
  the last good set, log an error).
- Whether `WaitRun`/`CancelRun` accept a request with no body at all is not
  fixed; read an absent body (no `Content-Type`, length 0) as `{}` and pin
  it in a test.
- The glob dialect is picomatch's (docs/STACK.md 2.5); SPEC only shows
  `report-*`. Pin `*`, `?` and a literal name with tests; braces, classes
  and a leading `!` behave as picomatch defines them (keys.yaml is
  platform-team input).
- The exact Effect 4 span API for a span opened in `onRequest` and ended
  in `onResponse` is UNVERIFIED (`krun-process-runtime`
  `references/telemetry.md`); check `effect` 4.0.6 `Tracer.ts` before
  relying on a signature.
- The generated OpenAPI for a regex path param with a Zod `params` schema
  is UNVERIFIED; check the file in P3.1c.
