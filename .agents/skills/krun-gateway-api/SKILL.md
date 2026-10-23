---
name: krun-gateway-api
description: Use when building krun gateway routes, auth, wait or SSE. Implements docs/API.md and docs/INTERNAL-API.md on three Fastify 5 listeners run as scoped Effect 4 layers, with Zod 4 route schemas, API keys with picomatch globs, per-run tokens and request spans honouring traceparent.
---

# krun gateway API

Scope: `apps/gateway/src`, `packages/shared/src/auth`. Public `/v1`
(docs/API.md, AIP-style), internal `/internal/v1` (docs/INTERNAL-API.md),
API keys and scopes, `requestId` idempotency, rate limit, `wait`/`WaitRun`,
`WatchRun` SSE, `CancelRun`, `GetRunResult`, request spans, drain. PLAN
P2.4, P3.1a-P3.8, P5.1, P5.2.

Owned elsewhere: admin listener, config, Logger, metrics, telemetry layer
(`krun-process-runtime`); Store, `toRun`/`toRunSummary` (`krun-store`);
callback address check, presigner (`krun-webhooks-objstore`); Function
validation, informer cache (`krun-functions-crd`).

## When to use

Adding or changing a route, hook, listener layer, error tag, envelope
mapping, keys loader, request span, `traceparent` handling, OpenAPI
generation or gateway SIGTERM path. Reviewing a branch for those.

## Read first

- SPEC.md section 4 (SPEC.md:176-318): listeners 178-189, public rules
  212-279, wait 295-297, internal 299-318. CAS and `actor`
  (SPEC.md:341-356). Store interface, mappers (SPEC.md:489-546). API keys,
  internal token (SPEC.md:956-990). Webhooks (SPEC.md:1076-1088). Section
  11 telemetry, logs, audit, health, shutdown (SPEC.md:1141-1206). Gateway
  env, `OTEL_*` (SPEC.md:1208-1253). D24, D25, D27, D30, D34, D35, D36
  (SPEC.md:1528-1540).
- docs/API.md, docs/INTERNAL-API.md in full. Normative; they win over this
  skill.
- docs/STACK.md 2.1-2.2 (Zod, Fastify, provider), 2.5 (`picomatch`,
  `canonicalize`, `uuid`), 2.6 (OpenTelemetry), 4.1 process shape, 4.2
  errors, 4.3 rule map, 4.4 time.
- PLAN.md Phase 3 (PLAN.md:363-465), P2.4 (PLAN.md:346-350), Phase 5 gate,
  P5.1, P5.2 (PLAN.md:616-637), PLAN.md section 2 allowlist and in-house
  list.
- Skills (CLAUDE.md rule 7, docs/STACK.md section 5): `zod-4`;
  `fastify-best-practices` for hooks, plugins, `inject` only (route schemas
  are Zod, shutdown is scope finalizers, no plugin outside docs/STACK.md);
  `vitest`; `effect-core-patterns`, `effect-error-handling`,
  `effect-dependency-injection`, `effect-resource-management`,
  `effect-concurrency`, `effect-testing`. Those target Effect 3:
  `node_modules/effect/AGENTS.md` and Effect's `MIGRATION.md` win
  (`Context.Service`, no `Runtime<R>`, `Context.Reference`).

| Reference | Holds |
|---|---|
| `references/endpoints.md` | routes and Fastify patterns, CreateRun check order, internal check order, both error tables with tag per row, tag list, Store-tag and framework-error mapping |
| `references/sse-wait.md` | notify fan-out, wait, SSE, drain, handler tests |
| `references/keys-yaml.md` | format, scopes, picomatch globs, constant-time lookup, reload |
| `references/library-facts.md` | verified library behaviour; read before P3.1a, P3.7, P5.2 |
| `../krun-process-runtime/references/telemetry.md` | span table, `traceparent` parser, request-span placement |

## Rules

### Listeners, errors, schemas

1. One Fastify instance per listener, each a scoped `Layer` (docs/STACK.md
   4.1). Each answers 404 `ROUTE_NOT_FOUND` for other listeners' paths
   (SPEC.md:178-181): `/internal/*` on public, `/v1/*` on internal and
   admin (PLAN.md:438, 461-463).
2. Every error, framework ones included, is the AIP-193 envelope `{ error:
   { code, message, status, details } }`; `details[0]` is a
   `google.rpc.ErrorInfo` (`reason`, `domain: "krun.io"`, `metadata`).
   `setNotFoundHandler` and `setErrorHandler` on every instance
   (SPEC.md:218-224, docs/API.md section 4, INTERNAL-API.md section 6).
3. Failures are `Data.TaggedError`s in the handler's error channel. ONE
   function `toEnvelope` in `packages/shared/src/runtime` maps tag to HTTP
   code, `status`, `reason`, `metadata`, `Retry-After`; nothing else sets
   an error status. Defect: 500 `INTERNAL`, generic `message`, logged at
   error. No `throw` outside adapters (`Effect.tryPromise`) (docs/STACK.md
   4.2, PLAN.md:107). `message` never carries input values, key, token,
   SQL or a stack.
4. Zod 4 through `fastify-type-provider-zod` (`validatorCompiler`,
   `serializerCompiler`). Bodies and query strings are `z.strictObject`
   (unknown field or parameter: 400 `REQUEST_INVALID`). `.optional()`,
   never `.nullable()`, so `null` is rejected (SPEC.md:245-246,
   docs/API.md:36-40, 50-51, docs/STACK.md 2.1). No Effect Schema.
5. Remove Fastify's default `text/plain` parser on public and internal: a
   `text/plain` POST must be 415 `CONTENT_TYPE_UNSUPPORTED`, not a Zod 400
   (PLAN.md:377-378; `references/library-facts.md`).

### Public auth and admission

6. Auth in `onRequest`, skipped when `request.is404`: bearer SHA-256
   compared with `timingSafeEqual` against every configured hash, then
   scope, then globs and owner. 401 before 403 before 404 (SPEC.md:214-217,
   956-957, docs/API.md:330-334). Body-dependent work runs after parse
   (`preHandler` or handler): `request.body` is undefined in `onRequest`.
7. Non-admin key sees only Ready functions in its globs (else 404
   `FUNCTION_NOT_FOUND`, one generic message) and only runs it created
   (else 404 `RUN_NOT_FOUND`). `admin` sees everything (SPEC.md:150-153,
   215-217, 972-973, docs/API.md:190-193, 225-227).
8. Key globs are `picomatch(globs, { nocase: false, dot: true })` matchers,
   compiled once per key per load. Never a hand-written glob-to-regex such
   as `*` to `.*` (docs/STACK.md 2.5, 4.3; `references/keys-yaml.md`
   section 3).
9. Cap bodies from `Content-Length` and counted stream, before parsing.
   Public: `bodyLimit = KRUN_MAX_INPUT_BYTES`, 413 `INPUT_TOO_LARGE`,
   `reason="input_size"`. Internal per route: 16384 status, 32768 error,
   `KRUN_MAX_RESULT_BYTES` result; 413 `REQUEST_TOO_LARGE` /
   `RESULT_TOO_LARGE`, body unread, `Connection: close`. Map
   `FST_ERR_CTP_BODY_TOO_LARGE` per listener and route in
   `setErrorHandler` (SPEC.md:274-275, 317-318, INTERNAL-API.md:85-89,
   PLAN.md:446-447). Count bytes in `preParsing` only if a test proves
   `bodyLimit` is not enough.
10. `CreateRun` order is fixed. `onRequest`: key, scope, rate limit,
    function (Ready, in globs). Then cap and parse. Then `requestId`
    lookup, `inputSchema`, priority, callback, `maxQueued`, insert.
    Replay: 201, `Location`, `Idempotent-Replay: true`, current FULL run,
    honours `wait`. Other fingerprint: 409 `ABORTED`
    `IDEMPOTENCY_CONFLICT` (docs/API.md:199-211, SPEC.md:225-233,
    PLAN.md:396-410). Table: `references/endpoints.md` section 3.
11. Fingerprint: lowercase hex SHA-256 (`node:crypto`) of `canonicalize({
    input, priority: priority ?? 0, callback: callback ?? null })` (RFC
    8785, `canonicalize ^5.1`), over the body as received, before the
    Function default callback. `requestId` and `wait` excluded. Stored as
    `request_hash`. `requestId` at most 128 characters (SPEC.md:225-228,
    527-529, docs/API.md:199-204, docs/STACK.md 2.5). No in-house JCS.
12. `priority` int 0-9; above 0 needs `runs:priority` (403
    `SCOPE_MISSING`, `metadata.scope`). Request without `callback` gets
    the Function's (SPEC.md:164-165, 234-235, D25).
13. Callback host glob and resolved-address check at create via the
    webhook package: 400 `CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field =
    "callback.url"` (SPEC.md:1076-1082, docs/API.md:327). Delivery
    re-checks; not this skill.
14. Rate limit: in-house token bucket per key name per replica, refilled
    from `Clock.currentTimeMillis`, `KRUN_RATE_LIMIT_RPS`,
    `KRUN_RATE_LIMIT_BURST`; 429 `RATE_LIMITED`. `maxQueued` via
    `countQueued` / `countQueuedBy`: 429 `QUEUE_FULL`, `metadata.limit`
    `function` or `key`. Every 429 and 503 carries `Retry-After: 1`
    (SPEC.md:266-268, 500-501, 980-981, docs/API.md:339-342).
15. `krun_admission_rejections_total{reason}`, reasons exactly
    `rate_limit`, `max_queued`, `input_size`, `schema` (SPEC.md:1165); an
    Effect `Metric` from `krun-process-runtime`.

### Public resources

16. Names `functions/{function}/runs/{run}`. `{function}` may be `-` in
    `GetRun`, `ListRuns` and run custom methods. `{run}` is lowercase
    UUIDv7 (docs/API.md:18-22). `:wait`, `:cancel`, `:getResult`, `:watch`
    are Fastify paths with `::` and a regex `:run` param
    (`references/endpoints.md` section 2). No `DeleteRun`, no `UpdateRun`.
17. FULL via `toRun`: `GetRun`, `CreateRun`, `WaitRun`, `CancelRun`.
    `GetRun` accepts `view=BASIC`. BASIC via `toRunSummary`: `ListRuns`
    items, SSE data, webhooks (SPEC.md:241-244, 264-265). Never hand-build
    run JSON in a route: it leaks `input` into BASIC payloads.
18. Paging (AIP-158/160): `ListRuns` order `createTime desc, id desc`.
    `pageSize` absent or 0 is 50, above 200 coerced, negative 400. Opaque
    token wraps Store cursor with parent and `filter` hash; mismatch or
    malformed: 400 `REQUEST_INVALID`. Bad filter grammar: 400
    `FILTER_INVALID`. `nextPageToken` is `""` on the last page.
    `ListFunctions`: same paging, by `name`, no filter (SPEC.md:236-240,
    docs/API.md:55-60, 182-186, 229-249).
19. `CancelRun` from queued, scheduled, running: `transition(id, from,
    "cancelling", null, {}, { actor: key.name })`; CAS zero rows: re-read,
    decide again. Already `cancelling`/`cancelled`: 200, no transition.
    `succeeded`/`failed`: 400 `FAILED_PRECONDITION` `RUN_TERMINAL`
    `metadata.state` (SPEC.md:269-273, 341-356, PLAN.md:421-427).
20. `GetRunResult`: inline result: 200, the document itself as JSON.
    `result_ref` only: 307 to a GET presigned for 300 s, `Cache-Control:
    no-store`. Neither: 404 `RESULT_MISSING`. Not terminal: 400
    `RUN_NOT_TERMINAL`. Failed or cancelled run may keep an inline result
    (SPEC.md:656-657, docs/API.md:269-281).
21. `wait` and `WaitRun.timeout`: duration grammar, capped at
    `KRUN_MAX_WAIT` (exposed as `Function.maxWait`). Waiter registered
    before insert; 1 s poll fallback; 201/200 at timeout; disconnect never
    cancels the run; drain answers waits at once (SPEC.md:232-233,
    295-297, 545-546, 1198-1203; `references/sse-wait.md`).
22. `WatchRun`: in-house SSE on `reply.raw` after `reply.hijack()`
    (`reply.send()` would serialise and end the response). First `state`
    event: BASIC run (terminal: one event, then EOF). Then one event per
    changed group, `id` the field's own time. `: keepalive` every 15 s
    (`Schedule.spaced`). `Last-Event-ID` ignored. Ends on terminal and on
    shutdown (SPEC.md:253-258, docs/API.md:283-295, PLAN.md section 2).

### Internal API

23. Per-run token: SHA-256 + `timingSafeEqual` against `job_token_hash`.
    Valid in `queued` with a token, `scheduled`, `running`. API keys
    rejected. Every 401 is `TOKEN_INVALID`; token never logged or echoed
    (SPEC.md:301-305, 983-990, INTERNAL-API.md:48-66, D27).
24. Order: route/version 404, token 401, `Content-Type` 415, cap 413,
    validation 400, status rate limit 429, guarded write (zero rows: 401,
    nothing notified). Each store call: `Effect.timeout("5 seconds")` from
    after validation, query aborted, then 503 `NOT_READY`
    (INTERNAL-API.md:97-104, docs/STACK.md 4.3).
25. `ReportStatus`: one accepted report per second per run per replica,
    window from the last 204 on `Clock` (a 429 or failed write does not
    extend it). Body replaces `runtime_status` wholesale; `at` from
    `DateTime.now`; `reportTime` in the body is 400. Notify only, no
    `run_events` (SPEC.md:316, INTERNAL-API.md:138-149).
26. `SetError` stored with `source: FUNCTION`, never changes state. Field
    limits are UTF-8 bytes of compact `JSON.stringify`. `SetResult` rejects
    `null`. `GetInput` re-serialises with `Content-Length`
    (SPEC.md:315-318, INTERNAL-API.md:90-94, 106-206).
27. `^/internal/v([1-9]\d*)(/|$)` with version other than 1: 404
    `UNSUPPORTED_API_VERSION` in the not-found handler, before auth.
    `User-Agent` logged, never gated (INTERNAL-API.md:36-43, D24).

### Observability, time, shutdown, OpenAPI

28. `X-Request-Id`: keep up to 128 characters, else a UUID; echo on every
    response; `reqId` on request-scoped log lines, Effect ones included.
    `trustProxy: true` for `client_ip` (SPEC.md:276-277, 1188-1191).
29. Audit: one line per `/v1` request, info (warn on 401/403): `key` (name
    or null), `client_ip`, `user_agent`, `route`, `code`, `run_id`,
    `function`, `idempotency_key`. Never the key, token, input, result,
    runtime status or a body (SPEC.md:1101-1103, 1181-1191). Redaction:
    `krun-process-runtime`.
30. Every `/v1` and `/internal/v1` request is an Effect span: kind
    `server`, name `<METHOD> <route template>`, attributes method, route,
    status code, plus `krun.run_id` when the request is about one run
    (`CreateRun` once the id exists; internal: the run in the path). Valid
    incoming W3C `traceparent` on either API becomes the parent; missing
    or malformed starts a new trace, never an error. `tracestate` not read
    in v1 (SPEC.md:1147-1156). Attributes never carry key, token,
    `Authorization`, input, result, `runtimeStatus`, `error.details`. Admin
    listener not traced. v1 does not join a run's spans into one trace: no
    trace column on the run, no trace variable to the pod; `krun.run_id`
    is the correlation. Parser and placement:
    `../krun-process-runtime/references/telemetry.md`.
31. Time only from `Clock`/`DateTime` (`DateTime.formatIso`). Run ids
    `v7({ msecs })` with `Clock.currentTimeMillis`. No `Date.now()`,
    `new Date()`, `setTimeout`, `setInterval` in gateway code (CLAUDE.md
    rule 8, docs/STACK.md 2.5, 4.4).
32. Drain: readiness 503, serve `KRUN_SHUTDOWN_DELAY`, end SSE streams,
    answer waits, close listeners, pool last, exit 0 (SPEC.md:1198-1206,
    D30, PLAN.md:432-441). `/v1` and `/internal/v1` never answer
    `NOT_READY` during the drain (docs/API.md:342). Shutdown is scope
    finalizers; no own signal handler. Steps: `references/sse-wait.md`
    section 4.
33. OpenAPI 3.1 from the Zod routes via `@fastify/swagger` +
    `jsonSchemaTransform` into `docs/api/openapi-public.json` and
    `openapi-internal.json` in `make generate`. Response enums `string`,
    known values in `.meta({ description })`. No nullable schema. A diff
    against the docs is a bug (SPEC.md:278-279, docs/API.md:466-469,
    PLAN.md:383-388, 455-461, D24).
34. Zod validates krun's own schemas only. `input` against `inputSchema`
    uses the cached Ajv validator from the Function cache, never the route
    compiler; violations become `BadRequest.fieldViolations`
    (SPEC.md:146-148, docs/STACK.md principle 3).

## Process shape (P3.1a, P3.7; docs/STACK.md 4.1)

- `main.ts`: `NodeRuntime.runMain(Layer.launch(Layer.mergeAll(PublicServer,
  InternalServer, AdminServer).pipe(Layer.provide(AppLayer),
  Layer.provide(Telemetry))), { teardown })`. `AppLayer`: Config, Logger,
  Database, Store, Functions, Keys, Metrics, Readiness, Drain, Notifier.
  `Telemetry`: the `@effect/opentelemetry` layer from
  `krun-process-runtime`.
- Server layer: `Layer.effectDiscard(Effect.acquireRelease(acquire,
  release))`. Acquire: `buildPublicApp` (an Effect needing the services)
  builds `Fastify({ trustProxy: true, return503OnClosing: false, genReqId
  })`, sets Zod compilers, registers routes, then `listen({ host:
  "0.0.0.0", port })`, port parsed from `:8080`-style addresses (Fastify's
  default host is `localhost`). Release: the drain
  (`references/sse-wait.md` section 4). Handler tests call
  `buildPublicApp` and `app.inject()`, no socket.
- Handlers capture context at build: `const ctx = yield*
  Effect.context<Services>()`; per request
  `Effect.runPromiseExitWith(ctx)(program, { signal: request.signal })`.
  `request.signal` aborts on client disconnect, which interrupts the
  fiber. `ManagedRuntime` is the other documented bridge; pick one for the
  whole gateway.
- Request span (Rule 30) wraps the Effect run here, so Store spans (owned
  by `krun-store`) nest under it and log lines carry `traceId` and
  `spanId`. Operators find the `CreateRun` span per docs/OPERATIONS.md
  "Telemetry".
- Map the `Exit`: success sends; failure goes through `toEnvelope`;
  interrupt after disconnect sends nothing.
- Metric `route` label = `request.routeOptions.url` (registered pattern),
  `unmatched` in the not-found handler (SPEC.md:1163). Counter and
  histogram: Effect `Metric`s from `krun-process-runtime`, exported by the
  OpenTelemetry Prometheus exporter with SPEC section 11 names.

## Lessons from dapr and knative/serving

One-liners with citations, each tied to Rules 3, 6, 9, 23 or 32:
`references/library-facts.md` "Prior art".

## Pitfalls

- A `Map` keyed by the bearer string is not constant-time
  (`references/keys-yaml.md` section 4).
- Auth ignoring `request.is404` turns an unknown internal path into 401
  instead of 404 (INTERNAL-API.md:36-40).
- Disconnect interrupts the handler fiber. Make the insert
  `Effect.uninterruptible`: it never half-creates a run, only the
  following wait ends (docs/API.md:220-221).
- App built outside the `it.effect` body runs on the live clock;
  `TestClock.adjust` does nothing. Build it inside the test.
- A `setTimeout` timer instead of `Effect.sleep`/`Schedule` cannot be
  driven by `TestClock` (rate refill, status window, wait, keepalive,
  drain).
- Server-level `handlerTimeout` cannot be opted out per route and kills
  `wait` and SSE. Leave it unset; bound waits with Effect.
- Rate limit and `maxQueued` counters are per replica by design
  (SPEC.md:266-267, section 10). No shared store (D4).
- `requestId` lookup runs after rate limit and function resolution: a
  replay still spends a token, still 404s on a non-Ready function, and
  with `wait` waits too.
- `CANCELLING` has no timestamp column; its SSE `id` is the read time from
  `DateTime.now`.
- Stored status key `at`, wire name `reportTime` (PLAN.md:450, 465).
- Never log `req.headers.authorization`, bodies, `input`, `result`,
  `runtimeStatus`, `error.details` (SPEC.md:1183-1186). Tests mint keys
  (PLAN.md:33).
- `traceparent` on the public API is caller-controlled: with the
  `parentbased_traceidratio` sampler a caller's `sampled` flag decides
  sampling for its own requests. SPEC asks for that ("honoured"). Do not
  override it per listener without a Decisions row.

## Before marking a task done

- Phase 3 gate: `pnpm exec vitest run apps/gateway/src` green on SQLite in
  memory, plus one POST-then-GET route test on testcontainers Postgres
  (PLAN.md:365-367). Tests: `@effect/vitest` `it.effect` (scoped),
  `layer(...)`, `TestClock.adjust` for every timer, Fastify `inject`,
  `fast-check` for fingerprint, filter parser, duration grammar. No test
  sleeps. Span assertions: in-memory exporter
  (`../krun-process-runtime/references/telemetry.md` "Tests").
- Per task acceptance: PLAN.md:346-350 (P2.4), 369-465 (P3.x), 625-637
  (P5.1, P5.2). P3.3 and P3.8: one test per error-table row.
- P3.1c, P3.8: `make generate && git diff --exit-code` (OpenAPI files
  committed under `docs/api/`).
- `make check` (CLAUDE.md rule 3, PLAN.md:17-18).
- Branch per task (`p3-3-create-run`), Conventional Commit, scope
  `gateway` or `shared`, PR to main, merge on green, never push main
  (PLAN.md:13-22). Append `2026-MM-DD P3.3 <short sha> note` to PLAN
  section 6, commit with the code. No `Co-Authored-By`, ever (CLAUDE.md
  rule 5).
- Public API shape, section 9 policy, non-goals are owner decisions:
  `BLOCKED`, never a Decisions row (PLAN.md:23-28).

## Limitations

- SPEC names no final SSE event for shutdown; stream just ends
  (docs/API.md:291-293). No `event: shutdown` without a Decisions row.
- SPEC does not fix keys-loader behaviour on a malformed file after a good
  startup. `references/keys-yaml.md` records the conservative reading:
  keep the last good set, log an error.
- SPEC does not fix whether `WaitRun`/`CancelRun` accept a request with no
  body. Read an absent body (no `Content-Type`, length 0) as `{}`; pin it
  in a test.
- Glob dialect is picomatch's (docs/STACK.md 2.5); SPEC only shows
  `report-*`. Pin `*`, `?` and a literal name with tests. Braces, classes,
  leading `!` behave as picomatch defines them (keys.yaml is platform-team
  input).
- UNVERIFIED: exact Effect 4 span API for a span opened in `onRequest` and
  ended in `onResponse` (`../krun-process-runtime/references/telemetry.md`).
  Check `effect` 4.0.6 `Tracer.ts` before relying on a signature.
- UNVERIFIED: generated OpenAPI for a regex path param with a Zod `params`
  schema. Check the file in P3.1c.
