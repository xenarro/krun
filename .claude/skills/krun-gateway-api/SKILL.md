---
name: krun-gateway-api
description: Use when building krun gateway routes, auth or SSE. Implements SPEC section 4 on three Fastify listeners with keys and per-run tokens.
---

# krun gateway API

Covers `apps/gateway/src` and `packages/shared/src/auth`: the public `/v1`
listener, the internal `/internal/v1` listener, API keys and scopes,
idempotency, rate limit, `wait`/`WaitRun`, `WatchRun` SSE, `CancelRun`,
`GetRunResult` and the gateway shutdown order. PLAN tasks P2.4, P3.1a-P3.8,
P5.1, P5.2. The admin listener, metrics and logging plumbing belong to
`krun-process-runtime`; the Store to `krun-store`; the callback address
check to `krun-webhooks-objstore`; Function validation to
`krun-functions-crd`.

## When to use

Any task that adds or changes a route, hook, plugin or listener in
`apps/gateway`, the keys loader, the error envelope, OpenAPI generation, or
the gateway's SIGTERM path. Also when reviewing a branch for those tasks.

## Read first

- SPEC.md section 4 (SPEC.md:176-318): listeners, public rules, internal
  rules; section 5 rules on `cancelling` and `actor` (SPEC.md:339-356);
  section 9 API keys and internal token (SPEC.md:952-986); section 11 logs,
  audit, shutdown (SPEC.md:1149-1174); section 12 gateway env
  (SPEC.md:1191-1205).
- docs/API.md in full (normative public contract, SPEC.md:193-198) and
  docs/INTERNAL-API.md in full (normative internal contract, SPEC.md:301).
- PLAN.md Phase 3 (PLAN.md:344-445), P2.4 (PLAN.md:327-331), P5.1-P5.2
  (PLAN.md:605-617), dependency table (PLAN.md:48-74).
- References here: `references/endpoints.md` (admin, public and internal
  endpoint tables, CreateRun outcome table, both error tables, with the
  PLAN task per row), `references/sse-wait.md` (fan-out, wait semantics,
  SSE message rules, shutdown interaction), `references/keys-yaml.md`
  (file format, scopes, globs, constant-time lookup, rotation, loader
  validation).

## Rules

1. Three Fastify instances, one per listener (`KRUN_LISTEN_ADDR`,
   `KRUN_INTERNAL_LISTEN_ADDR`, `KRUN_ADMIN_LISTEN_ADDR`); each answers 404
   `ROUTE_NOT_FOUND` for the other listeners' paths (SPEC.md:178-181,
   docs/API.md:332) because one instance has one `server`
   (node-stack-facts.md:554-558).
2. Every error, framework ones included, is the AIP-193 envelope with
   `details[0]` an `ErrorInfo` whose `reason` comes from the docs/API.md
   table; register `setNotFoundHandler` and `setErrorHandler` on every
   instance; unknown failures are 500 `INTERNAL` with no internals in
   `message` (SPEC.md:218-224, docs/API.md:299-342).
3. Keep docs/API.md:322-342 as the single status/reason mapper: one
   `ApiError(reason)` class that owns `code`, `status` and `Retry-After`;
   routes throw it, nothing else sets status codes (dapr lesson below).
4. Reject unknown body fields, `null` values and unknown query parameters
   with 400 `REQUEST_INVALID`; TypeBox `Type.Object(..., {
   additionalProperties: false })` and `Type.Optional`, never `Type.Null`
   (SPEC.md:245-246, SPEC.md:274-275, docs/API.md:36-40).
5. Auth in `onRequest`: `Authorization: Bearer <key>`, constant-time lookup
   over hashed secrets, scope check, then globs/owner; 401 before 403 before
   404 (SPEC.md:214-217, SPEC.md:956-957, docs/API.md:330-334). Body-needing
   work (idempotency fingerprint) goes in `preHandler`, since `request.body`
   is undefined in `onRequest` (node-stack-facts.md:514-519).
6. A non-admin key sees only functions matching its globs and runs it
   created; the other key's run is 404 `RUN_NOT_FOUND`; `admin` sees
   everything (SPEC.md:215-217, SPEC.md:972-973).
7. Body caps are enforced from `Content-Length` and the counted stream
   before parsing: public `bodyLimit = KRUN_MAX_INPUT_BYTES` → 413
   `INPUT_TOO_LARGE`; internal per-route `bodyLimit` 16384 / 32768 /
   `KRUN_MAX_RESULT_BYTES` → 413 `REQUEST_TOO_LARGE` / `RESULT_TOO_LARGE`,
   body unread, connection closed; Fastify's `FST_ERR_CTP_BODY_TOO_LARGE` is
   rewritten in `setErrorHandler` (SPEC.md:274-275, docs/API.md:337,
   docs/INTERNAL-API.md:85-89, PLAN.md:425-427).
8. `CreateRun` check order: cap → key → scope → rate limit → function
   (Ready, in globs) → parse → `requestId` lookup → schema → priority →
   callback → `maxQueued` → insert; replay is 201 + `Idempotent-Replay:
   true` with the current run, mismatch 409 `ABORTED` (docs/API.md:199-211,
   PLAN.md:377-391). Table in `references/endpoints.md` section 3.
9. Fingerprint = lowercase hex SHA-256 of the RFC 8785 serialisation of `{
   input, priority, callback }` as received, absent `priority` as 0, absent
   `callback` as `null`, before the Function default is applied; stored in
   `request_hash`; `requestId` ≤ 128 chars (SPEC.md:226-228,
   docs/API.md:199-204). Write the JCS serialiser in house (sorted keys,
   compact, ES number formatting); no package for it (PLAN.md:29-30, 69-72).
10. `priority` 0-9, above 0 needs `runs:priority` (403 `SCOPE_MISSING`,
    `metadata.scope`); the Function's `callback` is copied into the run when
    the request has none (SPEC.md:234-235, SPEC.md:162-164, D25).
11. Callback host glob + resolved-address check at create through the
    webhook package; failure is 400 `CALLBACK_NOT_ALLOWED` with
    `fieldViolations[0].field` = `callback.url` (SPEC.md:1062-1068,
    docs/API.md:327); the scheduler re-checks at delivery, not you.
12. Rate limit: in-house token bucket per key name per replica,
    `KRUN_RATE_LIMIT_RPS` / `KRUN_RATE_LIMIT_BURST`, 429 `RATE_LIMITED`
    `Retry-After: 1`; `maxQueued` via `countQueued` and `countQueuedBy`, 429
    `QUEUE_FULL` `metadata.limit` `function`|`key`; every 429 carries
    `Retry-After: 1` (SPEC.md:266-268, SPEC.md:500-501, SPEC.md:974-975,
    PLAN.md:70-71).
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
15. `CancelRun`: `transition(id, from, "cancelling", null, {}, { actor:
    key.name })` from queued/scheduled/running; already `cancelling` or
    `cancelled` is 200 with no transition; `succeeded`/`failed` is 400
    `FAILED_PRECONDITION` `RUN_TERMINAL` with `metadata.state`
    (SPEC.md:269-273, SPEC.md:356, PLAN.md:402-408).
16. `GetRunResult`: inline → 200 with the document itself; `result_ref`
    only → 307 presigned GET 300 s + `Cache-Control: no-store`; neither →
    404 `RESULT_MISSING`; not terminal → 400 `RUN_NOT_TERMINAL`; a failed
    run may keep an inline result (SPEC.md:653, docs/API.md:271-281).
17. `wait` and `WaitRun.timeout` are capped at `KRUN_MAX_WAIT`; the
    subscriber is registered before the insert; 1 s poll fallback; the
    status is still 201/200 on timeout; disconnect never cancels; SIGTERM
    answers at once (SPEC.md:232-233, SPEC.md:295-297, SPEC.md:545-546,
    SPEC.md:1169-1170). Details: `references/sse-wait.md`.
18. `WatchRun` is in-house SSE on `reply.raw` after `reply.hijack()`: first
    `state` event with the BASIC run (terminal → one event then EOF), one
    event per changed group, `id` = the field's own time, `: keepalive`
    every 15 s, `Last-Event-ID` ignored, closes on terminal and on shutdown
    (SPEC.md:253-258, docs/API.md:285-295, PLAN.md:70-71).
19. Internal listener: per-run token SHA-256 + `timingSafeEqual` against
    `job_token_hash`, valid only in `queued` with token / `scheduled` /
    `running`, API keys rejected, every 401 is `TOKEN_INVALID`
    (SPEC.md:301-305, SPEC.md:979-986, docs/INTERNAL-API.md:48-66, D27).
20. Internal check order is fixed: route/version 404 → token 401 →
    `Content-Type` 415 → cap 413 → validation 400 → status rate limit 429 →
    guarded store write (zero rows = 401, nothing notified); store calls
    bounded to 5 s → 503 `NOT_READY` (docs/INTERNAL-API.md:97-104,
    PLAN.md:422-445).
21. `ReportStatus`: 1 accepted report per second per run per replica, the
    window starting at the last 204; the body replaces `runtime_status`
    wholesale; `at` is set by the gateway, never read from the body;
    `reportTime` in the body is 400 `REQUEST_INVALID`; notify only, no
    `run_events` (SPEC.md:316, docs/INTERNAL-API.md:138-149).
22. `SetError` is stored with `source: FUNCTION` and never changes state;
    `SetResult` rejects `null`; `GetInput` re-serialises and sends
    `Content-Length` (SPEC.md:315-318, docs/INTERNAL-API.md:113-120, 172-206).
23. Version segment: `^/internal/v([1-9]\d*)(/|$)` with a version other
    than 1 is 404 `UNSUPPORTED_API_VERSION`, resolved before auth;
    `User-Agent` logged, never gated (docs/INTERNAL-API.md:36-43, D24).
24. `X-Request-Id`: accept ≤ 128 chars else replace with a UUID, echo on
    every response, `reqId` on every request-scoped log line; `trustProxy:
    true` for `client_ip` (SPEC.md:276-277, SPEC.md:1156-1159).
25. Audit one line per `/v1` request at info (warn on 401/403) with `key`
    (name or null), `client_ip`, `user_agent`, `route`, `code`, `run_id`,
    `function`, `idempotency_key`; never the key, token, input, result or
    body (SPEC.md:1151-1159, SPEC.md:1087-1089). Redaction config lives in
    `krun-process-runtime`.
26. Keys file: `key` string or list, duplicate names rejected, globs
    required unless `admin`, per-key `maxQueued`, 30 s content-hash poll,
    Secret mounted at the parent dir never `subPath` (SPEC.md:954-970, D12).
    Details: `references/keys-yaml.md`.
27. Shutdown: `/readyz` 503 → serve `KRUN_SHUTDOWN_DELAY` → close the three
    listeners → `preClose` ends SSE streams → pending waits answered → pool
    closed → exit 0, driven by `close-with-grace` (SPEC.md:1166-1170,
    PLAN.md:413-421, D30). `/v1` never answers `NOT_READY` during the drain
    (docs/API.md:342).
28. OpenAPI 3.1 from the TypeBox routes via `@fastify/swagger` into
    `docs/api/openapi-public.json` and `docs/api/openapi-internal.json` in
    `make generate`; response enums typed `string` with known values in
    `description`; no nullable schema; a diff against docs/API.md is a bug
    (SPEC.md:278-279, docs/API.md:466-469, PLAN.md:364-369, 435-441, D24).

## Listeners and app factory (P3.1a, P3.7)

- `createPublicApp(deps)`, `createInternalApp(deps)`, `createAdminApp(deps)`
  each return a Fastify instance built with
  `Fastify({...}).withTypeProvider<TypeBoxTypeProvider>()` chained on
  construction (node-stack-facts.md:462-464); register store, Function cache
  and keys as decorators so handler tests inject fakes (PLAN.md:350-351).
- `listen({ host: '0.0.0.0', port })` parsed from `:8080`-style addresses;
  Fastify's default host is `localhost` (node-stack-facts.md:554-555).
- Metric `route` label is `request.routeOptions.url`, `unmatched` on 404
  (SPEC.md:1131); the counter and histogram come from `krun-process-runtime`.
- Keep Fastify's Ajv validator (not `TypeBoxValidatorCompiler`) so
  `additionalProperties` and `format` behave as JSON Schema
  (node-stack-facts.md:469-472); function `inputSchema` validation uses the
  cached compiled validator from the informer map (SPEC.md:146-148), not
  Fastify's.

## Library facts (node-stack-facts.md section 3, VERIFIED unless marked)

- `requestIdHeader` defaults to `false` in Fastify 5; set it to
  `'x-request-id'` and a `genReqId` returning a UUID; when the header is
  present `genReqId` is not called, so enforce the 128-char rule in
  `onRequest` by overwriting `request.id` (node-stack-facts.md:489-494).
- `trustProxy: true` is the SPEC value; numeric hop counts are disabled in
  5.12.x (node-stack-facts.md:497-500).
- Hook order: `onRequest` → `preParsing` → parse → `preValidation` →
  validation (400) → `preHandler` → handler → `preSerialization` → `onSend`
  → `onResponse` (node-stack-facts.md:513-519).
- `reply.hijack()` before `reply.send()`; write headers with
  `reply.raw.writeHead`, `reply.header()` is ignored on `raw`; `onResponse`
  still runs; `handlerTimeout` is cancelled by hijack
  (node-stack-facts.md:524-533).
- `close()` waits for in-flight requests and does not end hijacked streams;
  end SSE in `preClose` (node-stack-facts.md:534-540, 559-562).
- `setErrorHandler` bumps `statusCode < 400` to 500, does not see 404s
  (use `setNotFoundHandler`) nor stream errors after headers
  (node-stack-facts.md:542-551).
- `close-with-grace`: `closeWithGrace({ delay }, async ({ signal }) => ...)`
  returns `{ close, uninstall }`; `@fastify/swagger` 9.x: `{ openapi: {
  openapi: '3.1.0' } }`, `await app.ready()` then `app.swagger()`,
  `schema.hide: true` hides a route. Both UNVERIFIED in the research
  session; confirm against the installed READMEs (node-stack-facts.md:601-614).
- SPEC RISK: `@fastify/type-provider-typebox@6` peers `typebox@^1.1.14`
  and does not accept `@sinclair/typebox`; the last provider for
  `@sinclair/typebox` is 5.2.0 pinned (node-stack-facts.md:436-455).
  PLAN.md:53 and D15 (SPEC.md:1456) name `@sinclair/typebox`. Do not mix;
  pin `@fastify/type-provider-typebox@5.2.0` with `@sinclair/typebox@0.34`
  or add a Decisions row before using `typebox@1` + provider 6 + TS ≥ 6.
  Resolving this is a dependency change: Decisions row or `BLOCKED`
  (PLAN.md:23-30).

## Lessons from dapr and knative/serving

- Wrap the body in a size limiter before any middleware or handler can
  read it, with per-route overrides for the big one: dapr
  `pkg/api/http/middlewares.go:28-40`, `server.go:293-325`. krun: global
  `bodyLimit` on each instance, per-route `bodyLimit` on `SetResult`
  (Rule 7).
- One envelope type, one code→status mapper, a counter per error code: dapr
  `pkg/messages/api_error.go:36-45`, `pkg/api/http/responses.go:154-183`.
  krun: `ApiError` + docs/API.md:322-342 (Rule 3).
- Do not compare tokens with `!=`: dapr `pkg/api/http/middlewares.go:52-82`
  is the anti-pattern (plain string compare, plain-text 401). krun:
  `timingSafeEqual` on hashes, JSON envelope on 401 (Rules 5, 19).
- Not-ready is 503, never 500: dapr's `/v1.0/healthz` returns 500
  (`pkg/messages/predefined.go:63-78`) while its control-plane `/healthz`
  returns 503 (`pkg/healthz/server/server.go:58`). krun: `NOT_READY` 503
  with `Retry-After: 1` (docs/API.md:342).
- Close HTTP listeners concurrently under one deadline so the first close
  does not cancel the rest, then close dependencies in reverse order (SSE
  and waits before the pool): dapr `pkg/api/http/server.go:235-265`,
  `pkg/runtime/runtime.go:500-531` (Rule 27).
- Flip readiness first, keep serving, then close: knative
  `vendor/knative.dev/pkg/network/handlers/drain.go:91-114`, queue-proxy
  `pkg/queue/sharedmain/main.go:310-347`. knative resets its quiet period
  on every non-probe request; SPEC.md:1166-1170 fixes a plain
  `KRUN_SHUTDOWN_DELAY`, so do not add the reset without a Decisions row.
- Hijacked streams are not tracked by server close; keep your own in-flight
  set and end them under a cap: knative `pkg/http/handler/hijack.go:27-66`
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
- `CANCELLING` has no timestamp column: the SSE `id` is the read time
  (docs/API.md:289-290).
- Only `toRun`/`toRunSummary` map rows to wire; hand-built JSON in a route
  leaks `input` into BASIC payloads (SPEC.md:264-265).
- The status rate-limit window starts at the last 204, not the last
  attempt; a 429 does not extend it (docs/INTERNAL-API.md:143-149). The
  stored JSON key is `at`, the wire name `reportTime` (PLAN.md:444-445).
- Never log `req.headers.authorization`, bodies, `input`, `result`,
  `runtimeStatus`, `error.details` (SPEC.md:1151-1154); tests generate
  their own keys (PLAN.md:33).
- A server-level `handlerTimeout` cannot be opted out per route and would
  kill `wait` and SSE; leave it unset (node-stack-facts.md:481-485).
- `/v1/*` on the admin port is 404 (PLAN.md:417-418).

## Before marking a task done

- Phase 3 gate: `node --test 'apps/gateway/src/**/*.test.ts'` green against
  SQLite in memory plus one POST-then-GET route test on testcontainers
  Postgres (PLAN.md:346-348). Per task: the acceptance text in
  PLAN.md:327-331 (P2.4), 350-445 (P3.x), 605-617 (P5.1, P5.2); P3.3 and
  P3.8 need one test per row of their error tables.
- `make generate && git diff --exit-code` for P3.1c and P3.8 (OpenAPI files
  committed under `docs/api/`, PLAN.md:106, 121-123).
- `make check` (CLAUDE.md:5, PLAN.md:17-18).
- Branch named after the task id (`p3-3-create-run`), Conventional Commit
  with scope `gateway` or `shared`, PR to main, merge on green; never push
  main (PLAN.md:13-22).
- Append `2026-MM-DD P3.3 <short sha> note` to PLAN section 6 and commit it
  with the code (PLAN.md:19-20). No `Co-Authored-By`, ever (CLAUDE.md:7,
  PLAN.md:16).
- Public API shape, section 9 policy and non-goals are owner decisions:
  write `BLOCKED`, never a Decisions row (PLAN.md:23-26).

## Limitations

- SPEC names no final SSE event for shutdown; the stream just ends
  (docs/API.md:291-293). No `event: shutdown` without a Decisions row.
- The keys loader's behaviour on a malformed file after a successful
  startup is not fixed by SPEC; `references/keys-yaml.md` records the
  conservative reading (keep the last good set, log an error).
- JCS (RFC 8785) number formatting and the glob dialect are not spelled out
  in SPEC; implement the RFC and the `*`/`?` subset and pin both with tests.
- `@fastify/swagger` and `close-with-grace` option names are UNVERIFIED;
  confirm against the installed package README before relying on one.
- The TypeBox provider conflict (SPEC RISK above) blocks P3.1a until a
  Decisions row or the pinned `@sinclair/typebox@0.34` + provider 5.2.0
  choice is recorded.
