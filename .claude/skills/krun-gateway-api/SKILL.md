---
name: krun-gateway-api
description: Use when building krun gateway routes, auth, wait or SSE. Implements SPEC section 4 on three Fastify 5 listeners run as scoped Effect 4 layers, with Zod route schemas, keys and per-run tokens.
---

# krun gateway API

Covers `apps/gateway/src` and `packages/shared/src/auth`: the public `/v1`
listener, the internal `/internal/v1` listener, API keys and scopes,
idempotency, rate limit, `wait`/`WaitRun`, `WatchRun` SSE, `CancelRun`,
`GetRunResult` and the gateway shutdown order. PLAN tasks P2.4, P3.1a-P3.8,
P5.1, P5.2. The admin listener, config, logger, metrics and the process
entry belong to `krun-process-runtime`; the Store to `krun-store`; the
callback address check to `krun-webhooks-objstore`; Function validation to
`krun-functions-crd`.

## When to use

Any task that adds or changes a route, hook, plugin, listener layer or
handler Effect in `apps/gateway`, the keys loader, the error mapping,
OpenAPI generation, or the gateway's SIGTERM path. Also when reviewing a
branch for those tasks.

## Read first

- docs/STACK.md in full (normative stack, SPEC D35 SPEC.md:1476): section
  4.1 process shape, 4.2 errors, 4.3 SPEC rules mapped to Effect, 4.4 time.
- SPEC.md section 4 (SPEC.md:176-318): listeners, public rules, internal
  rules; section 5 rules on `cancelling` and `actor` (SPEC.md:339-356);
  section 9 API keys and internal token (SPEC.md:952-986); section 11 logs,
  audit, shutdown (SPEC.md:1149-1174); section 12 gateway env
  (SPEC.md:1191-1205).
- docs/API.md in full (normative public contract, SPEC.md:193-198) and
  docs/INTERNAL-API.md in full (normative internal contract, SPEC.md:301).
- PLAN.md Phase 3 (PLAN.md:363-466), P2.4 (PLAN.md:346-350), P5.1-P5.2
  (PLAN.md:625-637), dependency allowlist (PLAN.md:58-86).
- Skills to load with this one (docs/STACK.md section 5): `effect-core-patterns`,
  `effect-error-handling`, `effect-dependency-injection`,
  `effect-resource-management`, `effect-concurrency`, `effect-testing`,
  `fastify-best-practices`, `zod-4`. Where they describe Effect 3, Effect's
  `MIGRATION.md` wins: `Context.Tag` is `Context.Service`, `Runtime<R>` is
  gone, `FiberRef` is `Context.Reference`.
- References here: `references/endpoints.md` (admin, public and internal
  endpoint tables, CreateRun outcome table, both error tables, with the
  PLAN task per row), `references/sse-wait.md` (fan-out, wait semantics,
  SSE message rules, shutdown interaction), `references/keys-yaml.md`
  (file format, scopes, globs, constant-time lookup, rotation, loader
  validation).

## Rules

1. Three Fastify instances, one per listener (`KRUN_LISTEN_ADDR`,
   `KRUN_INTERNAL_LISTEN_ADDR`, `KRUN_ADMIN_LISTEN_ADDR`), each a scoped
   Effect layer (`PublicServer`, `InternalServer`, `AdminServer`) merged in
   `main.ts` under `NodeRuntime.runMain(Layer.launch(Main))`
   (docs/STACK.md 4.1); each answers 404 `ROUTE_NOT_FOUND` for the other
   listeners' paths (SPEC.md:178-181, docs/API.md:332) because one instance
   has one `server`.
2. Every error, framework ones included, is the AIP-193 envelope with
   `details[0]` an `ErrorInfo` whose `reason` comes from the docs/API.md
   table; register `setNotFoundHandler` and `setErrorHandler` on every
   instance; defects and unknown failures are 500 `INTERNAL` with no
   internals in `message` (SPEC.md:218-224, docs/API.md:299-342).
3. Domain failures are `Data.TaggedError` classes (`FunctionNotFound`,
   `RunNotFound`, `QueueFull`, `IdempotencyConflict`, `TokenInvalid`, ...)
   in the handler Effect's error channel. One function in
   `packages/shared/src/runtime` maps each tag to code, `status`, `reason`,
   `metadata` and `Retry-After` per docs/API.md:322-342 and
   docs/INTERNAL-API.md:275-286; nothing else sets an error status. No
   `throw` in handlers; adapters use `Effect.tryPromise` (docs/STACK.md 4.2,
   dapr lesson below).
4. Reject unknown body fields, `null` values and unknown query parameters
   with 400 `REQUEST_INVALID`: Zod 4 `z.strictObject` for bodies and query
   strings, `.optional()` never `.nullable()` (SPEC.md:245-246,
   SPEC.md:274-275, docs/API.md:36-40, docs/STACK.md 2.1). Effect Schema is
   not used.
5. Auth in `onRequest`: `Authorization: Bearer <key>`, constant-time lookup
   over hashed secrets, scope check, then globs/owner; 401 before 403 before
   404 (SPEC.md:214-217, SPEC.md:956-957, docs/API.md:330-334). Body-needing
   work (idempotency fingerprint) goes in `preHandler` or the handler, since
   `request.body` is undefined in `onRequest`.
6. A non-admin key sees only functions matching its globs and runs it
   created; the other key's run is 404 `RUN_NOT_FOUND`; `admin` sees
   everything (SPEC.md:215-217, SPEC.md:972-973).
7. Body caps are enforced from `Content-Length` and the counted stream
   before parsing: public `bodyLimit = KRUN_MAX_INPUT_BYTES` → 413
   `INPUT_TOO_LARGE`; internal per-route `bodyLimit` 16384 (`status`) /
   32768 (`error`) / `KRUN_MAX_RESULT_BYTES` (`result`) → 413
   `REQUEST_TOO_LARGE` / `RESULT_TOO_LARGE`, body unread, connection closed;
   Fastify's `FST_ERR_CTP_BODY_TOO_LARGE` is rewritten in `setErrorHandler`
   (SPEC.md:274-275, docs/API.md:337, docs/INTERNAL-API.md:85-89,
   PLAN.md:446-447).
8. `CreateRun` check order: cap → key → scope → rate limit → function
   (Ready, in globs) → parse → `requestId` lookup → schema → priority →
   callback → `maxQueued` → insert; replay is 201 + `Location` +
   `Idempotent-Replay: true` with the current run, honouring `wait`;
   mismatch 409 `ABORTED` `IDEMPOTENCY_CONFLICT` (docs/API.md:199-211,
   PLAN.md:396-410). Table in `references/endpoints.md` section 3.
9. Fingerprint = lowercase hex SHA-256 (`node:crypto`) of
   `canonicalize({ input, priority: priority ?? 0, callback: callback ??
   null })` (RFC 8785, the `canonicalize` package, docs/STACK.md 2.5) as
   received, before the Function default is applied; `requestId` and `wait`
   excluded; stored in `request_hash`; `requestId` ≤ 128 chars
   (SPEC.md:226-228, docs/API.md:199-204, PLAN.md:70).
10. `priority` 0-9, above 0 needs `runs:priority` (403 `SCOPE_MISSING`,
    `metadata.scope`); the Function's `callback` is copied into the run when
    the request has none (SPEC.md:234-235, SPEC.md:162-164, D25).
11. Callback host glob + resolved-address check at create through the
    webhook package; failure is 400 `CALLBACK_NOT_ALLOWED` with
    `fieldViolations[0].field` = `callback.url` (SPEC.md:1062-1068,
    docs/API.md:327); the scheduler re-checks at delivery, not you.
12. Rate limit: in-house token bucket per key name per replica,
    `KRUN_RATE_LIMIT_RPS` / `KRUN_RATE_LIMIT_BURST`, refilled from
    `Clock.currentTimeMillis` (never `Date.now()`), 429 `RATE_LIMITED`
    `Retry-After: 1`; `maxQueued` via `countQueued` and `countQueuedBy`, 429
    `QUEUE_FULL` `metadata.limit` `function`|`key`; every 429 carries
    `Retry-After: 1` (SPEC.md:266-268, SPEC.md:500-501, SPEC.md:974-975,
    PLAN.md:82-83).
13. Count admission rejections: `krun_admission_rejections_total{reason}`
    with exactly `rate_limit`, `max_queued`, `input_size`, `schema`
    (SPEC.md:1133).
14. `GetRun` returns FULL via `toRun`, accepts `view=BASIC`; `ListRuns`
    items are `toRunSummary`, order `createTime desc, id desc`, `pageSize`
    default 50, >200 coerced, negative 400, token binds parent and `filter`
    (mismatch or malformed 400 `REQUEST_INVALID`), filter grammar else 400
    `FILTER_INVALID`, `nextPageToken` `""` on the last page (SPEC.md:236-244,
    docs/API.md:55-60, 229-249). The Store's cursor is `createdAt|id`; wrap
    it with the parent and filter hash in the opaque token.
15. `CancelRun` (`POST .../runs/{run}:cancel`, body `{}`): `transition(id,
    from, "cancelling", null, {}, { actor: key.name })` from
    queued/scheduled/running; already `cancelling` or `cancelled` is 200
    with no transition; `succeeded`/`failed` is 400 `FAILED_PRECONDITION`
    `RUN_TERMINAL` with `metadata.state` (SPEC.md:269-273, SPEC.md:356,
    PLAN.md:421-427).
16. `GetRunResult` (`GET .../runs/{run}:getResult`): inline → 200 with the
    document itself; `result_ref` only → 307 presigned GET 300 s +
    `Cache-Control: no-store`; neither → 404 `RESULT_MISSING`; not terminal
    → 400 `RUN_NOT_TERMINAL`; a failed run may keep an inline result
    (SPEC.md:653, docs/API.md:269-281).
17. `wait` (query on `CreateRun`) and `WaitRun.timeout` (body of `POST
    .../runs/{run}:wait`) are capped at `KRUN_MAX_WAIT`; the subscriber is
    registered before the insert; 1 s poll fallback; the status is still
    201/200 on timeout; disconnect never cancels; SIGTERM answers at once
    (SPEC.md:232-233, SPEC.md:295-297, SPEC.md:545-546,
    SPEC.md:1169-1170). Details: `references/sse-wait.md`.
18. `WatchRun` (`GET .../runs/{run}:watch`) is in-house SSE on `reply.raw`
    after `reply.hijack()`: first `state` event with the BASIC run (terminal
    → one event then EOF), one event per changed group, `id` = the field's
    own time, `: keepalive` every 15 s (`Schedule.spaced`), `Last-Event-ID`
    ignored, closes on terminal and on shutdown (SPEC.md:253-258,
    docs/API.md:283-295, PLAN.md:82-83).
19. Internal listener: per-run token SHA-256 + `timingSafeEqual` against
    `job_token_hash`, valid only in `queued` with token / `scheduled` /
    `running`, API keys rejected, every 401 is `TOKEN_INVALID`
    (SPEC.md:301-305, SPEC.md:979-986, docs/INTERNAL-API.md:48-66, D27).
20. Internal check order is fixed: route/version 404 → token 401 →
    `Content-Type` 415 → cap 413 → validation 400 → status rate limit 429 →
    guarded store write (zero rows = 401, nothing notified); each store call
    under `Effect.timeout("5 seconds")`, started after the body is read and
    validated, the query cancelled, → 503 `NOT_READY`
    (docs/INTERNAL-API.md:97-104, PLAN.md:442-466).
21. `ReportStatus`: 1 accepted report per second per run per replica, the
    window starting at the last 204 and measured with `Clock`; the body
    replaces `runtime_status` wholesale; `at` is set by the gateway from
    `DateTime.now`, never read from the body; `reportTime` in the body is
    400 `REQUEST_INVALID`; notify only, no `run_events` (SPEC.md:316,
    docs/INTERNAL-API.md:138-160).
22. `SetError` is stored with `source: FUNCTION` and never changes state;
    `SetResult` rejects `null`; `GetInput` re-serialises and sends
    `Content-Length` (SPEC.md:315-318, docs/INTERNAL-API.md:106-120, 162-206).
23. Version segment: `^/internal/v([1-9]\d*)(/|$)` with a version other
    than 1 is 404 `UNSUPPORTED_API_VERSION`, resolved before auth;
    `User-Agent` logged, never gated (docs/INTERNAL-API.md:36-43, D24).
24. `X-Request-Id`: accept ≤ 128 chars else replace with a UUID, echo on
    every response, `reqId` on every request-scoped log line, Effect log
    lines included; `trustProxy: true` for `client_ip` (SPEC.md:276-277,
    SPEC.md:1156-1159).
25. Audit one line per `/v1` request at info (warn on 401/403) with `key`
    (name or null), `client_ip`, `user_agent`, `route`, `code`, `run_id`,
    `function`, `idempotency_key`; never the key, token, input, result or
    body (SPEC.md:1151-1159, SPEC.md:1087-1089). Logger and redaction live in
    `krun-process-runtime`.
26. Keys file: `key` string or list, duplicate names rejected, globs
    required unless `admin`, per-key `maxQueued`, 30 s content-hash poll
    (`Schedule.spaced`), Secret mounted at the parent dir never `subPath`
    (SPEC.md:954-970, D12). Details: `references/keys-yaml.md`.
27. Shutdown is scope finalizers, no signal handler of your own: SIGTERM
    interrupts the main fiber; each listener layer's release flips
    readiness to 503 → waits `KRUN_SHUTDOWN_DELAY` → ends SSE streams and
    answers pending waits → closes its listener; the pool's finalizer runs
    last because it was acquired first (SPEC.md:1166-1170, PLAN.md:432-441,
    D30, docs/STACK.md 4.1). `/v1` never answers `NOT_READY` during the
    drain (docs/API.md:342).
28. OpenAPI 3.1 from the Zod routes via `@fastify/swagger` with
    `jsonSchemaTransform` into `docs/api/openapi-public.json` and
    `docs/api/openapi-internal.json` in `make generate`; response enums
    typed `string` with known values in `description`; no nullable schema;
    a diff against docs/API.md is a bug (SPEC.md:278-279,
    docs/API.md:466-469, PLAN.md:383-388, 456-462, D24).
29. Time: never `Date.now()` or `new Date()` in application code; deadlines,
    windows, token buckets and timestamps come from `Clock` and `DateTime`,
    formatted with `DateTime.formatIso` (CLAUDE.md rule 8, docs/STACK.md
    4.4).

## Listeners and app factory (P3.1a, P3.7)

- `makePublicApp`, `makeInternalApp`, `makeAdminApp` are Effects that need
  the services (`Config`, `Store`, `Functions`, `Keys`, `Metrics`, logger)
  and return a Fastify instance built with
  `Fastify({...}).withTypeProvider<ZodTypeProvider>()`, then
  `setValidatorCompiler(validatorCompiler)` and
  `setSerializerCompiler(serializerCompiler)` from
  `fastify-type-provider-zod` 7. Handler tests build the app inside the
  test Effect with fake service layers and call `app.inject` through
  `Effect.promise`.
- The listener layer acquires with `Effect.acquireRelease`: build the app,
  `listen({ host: '0.0.0.0', port })` parsed from `:8080`-style addresses
  (Fastify's default host is `localhost`); the release is Rule 27.
- Handlers run Effects with the services captured when the layer was
  built: capture the context once (`Effect.context()`) and run each handler
  with it, or a `ManagedRuntime`, whichever Effect 4 documents for
  embedding (check `MIGRATION.md` and the runtime guide; `Runtime<R>` is
  gone). Pass an `AbortSignal` tied to the request so a client disconnect
  interrupts the handler fiber; map the `Exit` to the reply: success →
  serialise, tagged failure → the Rule 3 mapper, defect → 500 `INTERNAL`
  logged at error.
- Metric `route` label is `request.routeOptions.url`, `unmatched` on 404
  (SPEC.md:1131); the counter and histogram come from the `Metrics` service
  in `krun-process-runtime`.
- Zod validates krun's own schemas only. Function `inputSchema` validation
  uses the cached compiled Ajv validator from the informer map
  (SPEC.md:146-148, docs/STACK.md principle 3), never the route compiler.

## Library facts (confirm against the installed versions)

- `requestIdHeader` defaults to `false` in Fastify 5; with a header name
  set, `genReqId` is skipped whenever the header is present, so the
  128-char rule cannot live there. Keep `requestIdHeader: false` and read
  `x-request-id` inside `genReqId` (accept 1 to 128 characters, else a new
  UUID), so `request.log` carries the final `reqId` from the first line
  (`krun-process-runtime` `references/logging.md`). `genReqId` is
  synchronous and outside Effect; `v7()` from `uuid` is fine there, run
  ids use `v7({ msecs })` with the time from `Clock` (docs/STACK.md 2.5).
- `trustProxy: true` is the SPEC value; numeric hop counts are disabled in
  5.12.x.
- Hook order: `onRequest` → `preParsing` → parse → `preValidation` →
  validation (400) → `preHandler` → handler → `preSerialization` → `onSend`
  → `onResponse`.
- `reply.hijack()` before `reply.send()`; write headers with
  `reply.raw.writeHead`, `reply.header()` is ignored on `raw`; `onResponse`
  still runs; `handlerTimeout` is cancelled by hijack.
- `close()` waits for in-flight requests and does not end hijacked streams;
  end SSE and answer waits before or in `preClose`.
- `setErrorHandler` bumps `statusCode < 400` to 500, does not see 404s
  (use `setNotFoundHandler`) nor stream errors after headers.
- `fastify-type-provider-zod` 7 (peers `zod >= 4.1.5`, `fastify ^5.5`):
  route validation failures reach `setErrorHandler` as Zod validation
  errors and response mismatches as serialization errors; the package
  exports type guards for both (names in its README). Map the first to 400
  `REQUEST_INVALID` with `BadRequest.fieldViolations`, the second to 500
  `INTERNAL`.
- `@fastify/swagger` 9.x: `{ openapi: { openapi: '3.1.0' }, transform:
  jsonSchemaTransform }`, `await app.ready()` then `app.swagger()`,
  `schema.hide: true` hides a route. Option names UNVERIFIED; confirm
  against the installed README.

## Lessons from dapr and knative/serving

- Wrap the body in a size limiter before any middleware or handler can
  read it, with per-route overrides for the big one: dapr
  `pkg/api/http/middlewares.go:28-40`, `server.go:293-325`. krun: global
  `bodyLimit` on each instance, per-route `bodyLimit` on `SetResult`
  (Rule 7).
- One error vocabulary, one code→status mapper, a counter per error code:
  dapr `pkg/messages/api_error.go:36-45`, `pkg/api/http/responses.go:154-183`.
  krun: tagged errors + one mapper over docs/API.md:322-342 (Rule 3).
- Do not compare tokens with `!=`: dapr `pkg/api/http/middlewares.go:52-82`
  is the anti-pattern (plain string compare, plain-text 401). krun:
  `timingSafeEqual` on hashes, JSON envelope on 401 (Rules 5, 19).
- Not-ready is 503, never 500: dapr's `/v1.0/healthz` returns 500
  (`pkg/messages/predefined.go:63-78`) while its control-plane `/healthz`
  returns 503 (`pkg/healthz/server/server.go:58`). krun: `NOT_READY` 503
  with `Retry-After: 1` (docs/API.md:342).
- Close HTTP listeners under one deadline so the first close does not
  cancel the rest, then close dependencies in reverse order (SSE and waits
  before the pool): dapr `pkg/api/http/server.go:235-265`,
  `pkg/runtime/runtime.go:500-531`. krun: scope finalizers give the reverse
  order (Rule 27).
- Flip readiness first, keep serving, then close: knative
  `vendor/knative.dev/pkg/network/handlers/drain.go:91-114`, queue-proxy
  `pkg/queue/sharedmain/main.go:310-347`. knative resets its quiet period
  on every non-probe request; SPEC.md:1166-1170 fixes a plain
  `KRUN_SHUTDOWN_DELAY`, so do not add the reset without a Decisions row.
- Hijacked streams are not tracked by server close; signal and end them
  yourself under a cap: knative `pkg/http/handler/hijack.go:27-66`
  (Rule 27, `references/sse-wait.md` section 4).
- Never write an error status after the first byte; end the stream instead:
  knative `pkg/http/handler/timeout.go:70-156`. krun: a wait that times out
  before writing answers 201/200 with the current run; an SSE stream that
  hits shutdown just ends (SPEC.md:256-258).
- Probes bypass limiters and concurrency breakers: knative
  `pkg/queue/handler.go:39-43,70-81`. krun: the admin listener has no auth,
  no rate limit (SPEC.md:183).

## Pitfalls

- Fastify's 413 fires from `bodyLimit` on `Content-Length` or the counted
  stream; rewrite it into the envelope (Rule 7) and do not count bytes
  yourself in `preParsing` unless a test proves `bodyLimit` is not enough.
- A `Map` keyed by the bearer string is not constant-time
  (`references/keys-yaml.md` section 4).
- `request.routeOptions.url` is undefined in the not-found handler; label
  `unmatched` there (SPEC.md:1131).
- SSE through `reply.send()` serialises and ends the response; always
  `hijack()` and write `reply.raw` (Rule 18).
- Rate limit and `maxQueued` counters are per replica by design
  (SPEC.md:266-267, SPEC.md:1102); no shared store for them (D4).
- The idempotency lookup runs after rate limit and function resolution, so
  a replay still consumes a token and still 404s on a non-Ready function;
  a replay with `wait` waits too (docs/API.md:204-209, SPEC.md:230-231).
- A client disconnect interrupts the handler fiber; it must never cancel or
  half-create a run. Make the insert `Effect.uninterruptible` so an abort
  only ends the wait that follows it (docs/API.md:220-221).
- `KRUN_SHUTDOWN_DELAY` must elapse once per process, not once per listener:
  sequential sibling finalizers would otherwise wait three times. Put the
  readiness flip and the delay in one shared drain Effect (memoised, or a
  `Deferred` the first release completes) that every listener's release
  awaits; do not depend on the order between merged sibling layers.
- Handler Effects run with the context captured from the layer; a test that
  builds the app outside its `it.effect` body runs handlers on the live
  clock and `TestClock.adjust` does nothing. Build the app inside the test.
- `CANCELLING` has no timestamp column: the SSE `id` is the read time from
  `DateTime.now` (docs/API.md:289-290).
- Only `toRun`/`toRunSummary` map rows to wire; hand-built JSON in a route
  leaks `input` into BASIC payloads (SPEC.md:264-265).
- The status rate-limit window starts at the last 204, not the last
  attempt; a 429 does not extend it (docs/INTERNAL-API.md:143-149). The
  stored JSON key is `at`, the wire name `reportTime` (PLAN.md:465).
- Never log `req.headers.authorization`, bodies, `input`, `result`,
  `runtimeStatus`, `error.details` (SPEC.md:1151-1154); tests generate
  their own keys (PLAN.md:33).
- A server-level `handlerTimeout` cannot be opted out per route and would
  kill `wait` and SSE; leave it unset and bound waits with Effect instead.
- `/v1/*` on the admin port is 404 (PLAN.md:438).

## Before marking a task done

- Phase 3 gate: `pnpm exec vitest run apps/gateway/src` green against
  SQLite in memory plus one POST-then-GET route test on testcontainers
  Postgres (PLAN.md:365-367). Tests use `@effect/vitest` (`it.effect`,
  which is scoped, `layer(...)`, `TestClock`), never sleeps. Per task: the
  acceptance text in PLAN.md:346-350 (P2.4), 369-466 (P3.x), 625-637
  (P5.1, P5.2); P3.3 and P3.8 need one test per row of their error tables.
- `make generate && git diff --exit-code` for P3.1c and P3.8 (OpenAPI files
  committed under `docs/api/`, PLAN.md:123, 135-140).
- `make check` (CLAUDE.md rule 3, PLAN.md:17-18).
- Branch named after the task id (`p3-3-create-run`), Conventional Commit
  with scope `gateway` or `shared`, PR to main, merge on green; never push
  main (PLAN.md:13-22).
- Append `2026-MM-DD P3.3 <short sha> note` to PLAN section 6 and commit it
  with the code (PLAN.md:19-20). No `Co-Authored-By`, ever (CLAUDE.md rule
  5, PLAN.md:16).
- Public API shape, section 9 policy and non-goals are owner decisions:
  write `BLOCKED`, never a Decisions row (PLAN.md:23-26).

## Limitations

- SPEC names no final SSE event for shutdown; the stream just ends
  (docs/API.md:291-293). No `event: shutdown` without a Decisions row.
- The keys loader's behaviour on a malformed file after a successful
  startup is not fixed by SPEC; `references/keys-yaml.md` records the
  conservative reading (keep the last good set, log an error).
- The glob dialect is not spelled out in SPEC; implement the `*`/`?`
  subset and pin it with tests. JCS comes from `canonicalize`; pin the
  fingerprint with a fast-check property test.
- Effect 4 API names for embedding (captured context versus
  `ManagedRuntime`), the logger replacement and scoped layers moved since
  Effect 3; where this skill is unsure it says so, check Effect's
  `MIGRATION.md` rather than guess.
- `@fastify/swagger` option names and the `fastify-type-provider-zod` type
  guard names are UNVERIFIED; confirm against the installed package README
  before relying on one.
