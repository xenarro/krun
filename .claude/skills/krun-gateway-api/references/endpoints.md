# Gateway endpoints, CreateRun order and error tables

Rewritten from docs/API.md sections 1-4 and docs/INTERNAL-API.md sections
1-6 as of 2026-10-23, with the Fastify route pattern, Zod schema notes, the
tagged error per row (section 7 lists the tags) and the PLAN task. The docs are normative; re-verify a
line number before citing it in code or tests. Every listener answers 404
`ROUTE_NOT_FOUND` for the other listeners' paths (SPEC.md:178-181).

## 1. Admin listener (`KRUN_ADMIN_LISTEN_ADDR`, default `:9090`)

No authentication, no rate limit, never exposed outside the cluster
(SPEC.md:183-189). Built by `packages/shared/src/health` (P0.7,
PLAN.md:191-197; owned by `krun-process-runtime`); the gateway only wires
it as `AdminServer` (P3.7) and shares the `Readiness` service with the
drain.

| Path | Notes |
|---|---|
| `GET /healthz` | 200 while the process runs |
| `GET /readyz` | database (2 s bound) and Function informer synced; 503 from the start of shutdown (SPEC.md:1193-1196) |
| `GET /metrics` | Effect `Metric`s through the OpenTelemetry Prometheus exporter, SPEC section 11 names (SPEC.md:1143-1147) |

## 2. Public API (`KRUN_LISTEN_ADDR`, default `:8080`, base `/v1`)

Methods: docs/API.md:167-177 (SPEC.md:200-210). Fastify patterns tested
against find-my-way 9 / Fastify 5.12.7; `R` is `:run(^[^:]+)`, used on
every run route so `.../runs/x:bogus` is 404 instead of matching `GetRun`.

| Method | HTTP | Fastify pattern | Scope | Success | PLAN |
|---|---|---|---|---|---|
| `ListFunctions` | `GET /v1/functions` | `/v1/functions` | `functions:read` | 200 `{ functions, nextPageToken }` | P3.2 |
| `GetFunction` | `GET /v1/functions/{function}` | `/v1/functions/:function` | `functions:read` | 200 `Function` | P3.2 |
| `CreateRun` | `POST /v1/functions/{function}/runs` | `/v1/functions/:function/runs` | `runs:write` | 201 FULL `Run`, `Location` | P3.3, P5.1 |
| `GetRun` | `GET /v1/functions/{function}/runs/{run}` | `/v1/functions/:function/runs/R` | `runs:read` | 200 FULL (or BASIC) `Run` | P3.4 |
| `ListRuns` | `GET /v1/functions/{function}/runs` | `/v1/functions/:function/runs` | `runs:read` | 200 `{ runs, nextPageToken }`, BASIC | P3.4 |
| `WaitRun` | `POST /v1/functions/{function}/runs/{run}:wait` | `/v1/functions/:function/runs/R::wait` | `runs:read` | 200 FULL `Run` | P5.1 |
| `CancelRun` | `POST /v1/functions/{function}/runs/{run}:cancel` | `/v1/functions/:function/runs/R::cancel` | `runs:write` | 200 FULL `Run` | P3.5 |
| `GetRunResult` | `GET /v1/functions/{function}/runs/{run}:getResult` | `/v1/functions/:function/runs/R::getResult` | `runs:read` | 200 document, or 307 | P3.6 |
| `WatchRun` | `GET /v1/functions/{function}/runs/{run}:watch` | `/v1/functions/:function/runs/R::watch` | `runs:read` | 200 `text/event-stream` | P5.2 |

No `DeleteRun`, no `UpdateRun` (docs/API.md:179-180). `@fastify/swagger`
renders the patterns as `/v1/functions/{function}/runs/{run}:wait`.

Path parameters (`params` Zod schema, failures 400 `REQUEST_INVALID` unless
noted):

- `{function}`: a DNS-1123 label, or `-` on `GetRun`, `ListRuns` and the
  run custom methods (docs/API.md:18-22). `-` on `GetFunction` or
  `CreateRun` names no function: 404 `FUNCTION_NOT_FOUND` (reading).
- `{run}`: lowercase UUIDv7. A run of another function under a concrete
  `{function}` is 404 `RUN_NOT_FOUND`. A malformed id is not fixed by the
  docs; this skill answers 404 `RUN_NOT_FOUND` (it cannot exist) and pins
  it in a test.

Query and body schemas (all `z.strictObject`, `.optional()` only):

| Method | Query | Body |
|---|---|---|
| `ListFunctions` | `pageSize?`, `pageToken?` | none |
| `GetFunction` | none | none |
| `CreateRun` | `requestId?` (1-128 chars), `wait?` (duration) | `{ input, priority?, callback?: { url } }`; output-only `Run` fields in the body are ignored, not rejected (docs/API.md:41-43, 197), every other key is `REQUEST_INVALID` |
| `GetRun` | `view?` `BASIC` or `FULL` (closed enum, `_UNSPECIFIED` rejected) | none |
| `ListRuns` | `pageSize?`, `pageToken?`, `filter?` | none |
| `WaitRun` | none | `{ timeout? }` duration |
| `CancelRun` | none | `{}` |
| `GetRunResult` | none | none |
| `WatchRun` | none | none |

Query strings arrive as strings: `pageSize` is `z.coerce.number().int()`
with 0 meaning default, negative 400, above 200 coerced to 200
(docs/API.md:55-60). Duration grammar `^\d+(ms|s|m|h)$` is the shared Zod
refinement into `Duration` (docs/STACK.md 4.3).

Row notes:

- `ListFunctions`: default 50, max 200, ordered by `name`, Ready functions
  in the key's globs only; none is an empty list (docs/API.md:182-186).
- `GetFunction`: missing, not Ready, outside globs are one generic
  `FUNCTION_NOT_FOUND` (docs/API.md:188-193); fields per docs/API.md:71-83
  including `callback`, `queueTimeout`, `maxInputBytes`, `maxResultBytes`,
  `maxWait`; unset fields omitted.
- `GetRun`: `view` default `FULL` (docs/API.md:223-227).
- `ListRuns`: `createTime desc`, ties by run id `desc`; token encodes the
  last (`createTime`, `{run}`) plus parent and `filter` hash; grammar
  (docs/API.md:238-249):

  ```
  expression := term { "AND" term }
  term       := "state" ( "=" | "!=" ) State
              | "createTime" ( ">=" | "<=" | ">" | "<" ) timestamp
              | "failureReason" "=" FailureReason
  ```

  Timestamps are quoted RFC 3339 strings; enum operands are UPPER_SNAKE and
  map to lowercase columns (docs/API.md:473-482). Anything else is
  `FILTER_INVALID`.
- `WaitRun`: default and cap `Function.maxWait`; 200 at terminal, timeout
  or shutdown (docs/API.md:251-256).
- `CancelRun`: from `QUEUED`/`SCHEDULED`/`RUNNING` move to `CANCELLING`
  (`payload.actor` = key name); repeats on `CANCELLING`/`CANCELLED` are 200
  with no event; `SUCCEEDED`/`FAILED` is `RUN_TERMINAL` (docs/API.md:258-267,
  SPEC.md:269-273, 356).
- `GetRunResult`: docs/API.md:269-281; 307 `Location` is a GET presigned for
  300 s on another origin, `Cache-Control: no-store`; a 200 does not mean
  `SUCCEEDED`; a run never has both `result` and `resultUri`.
- `WatchRun`: `sse-wait.md` section 3.

## 3. CreateRun check order (P3.3, P5.1)

docs/API.md:199-221, SPEC.md:225-235. First failing check answers. Every
429 and 503 carries `Retry-After: 1`.

| Step | Fails as | Tag | Where |
|---|---|---|---|
| 1. bearer key | 401 `KEY_MISSING` / `KEY_INVALID` | `KeyMissing` / `KeyInvalid` | `onRequest` |
| 2. scope `runs:write` | 403 `SCOPE_MISSING` `metadata.scope` | `ScopeMissing` | `onRequest` |
| 3. token bucket per key name per replica | 429 `RATE_LIMITED`; metric `rate_limit` | `RateLimited` | `onRequest` |
| 4. function Ready and in globs | 404 `FUNCTION_NOT_FOUND`, generic message | `FunctionNotFound` | `onRequest` (needs only the path) |
| 5. `Content-Type` | 415 `CONTENT_TYPE_UNSUPPORTED` | `ContentTypeUnsupported` | parser lookup |
| 6. body cap from `Content-Length`, then counted stream, before parse; JSON parse; Zod body and query | 413 `INPUT_TOO_LARGE` (metric `input_size`), body unread; 400 `REQUEST_INVALID` | `InputTooLarge` / `RequestInvalid` | instance `bodyLimit`, parser, validator |
| 7. `requestId` lookup on (key, function, `requestId`) | equal fingerprint: 201, `Location`, `Idempotent-Replay: true`, current FULL run, honours `wait`; different: 409 `ABORTED` `IDEMPOTENCY_CONFLICT` | `IdempotencyConflict` | handler |
| 8. `input` vs `inputSchema` (cached Ajv) | 400 `INPUT_SCHEMA_VIOLATION`, `BadRequest.fieldViolations` (`field` = `input.<path>`); metric `schema` | `InputSchemaViolation` | handler |
| 9. `priority` above 0 needs `runs:priority` (range 0-9 is step 6) | 403 `SCOPE_MISSING` `metadata.scope: runs:priority` | `ScopeMissing` | handler |
| 10. callback: request's, else the Function's; host glob + address check | 400 `CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field = "callback.url"` | `CallbackNotAllowed` | handler |
| 11. `countQueued(fn)` vs `maxQueued`, `countQueuedBy(fn, key)` vs the key's | 429 `QUEUE_FULL` `metadata.limit` `function` or `key`; metric `max_queued` | `QueueFull` | handler |
| 12. register the waiter (when `wait`), then `createRun` uninterruptibly | 201 FULL `Run`, `Location: /v1/functions/{function}/runs/{run}` | | handler |
| 13. `wait=<duration>` | terminal, elapsed or shutdown: still 201, client reads `state` | | handler |
| any: store or informer not ready at startup | 503 `NOT_READY` (never during the SIGTERM drain) | `NotReady` | handler / `onRequest` |

docs/API.md:204-206 put authentication, scope, rate limit, function
resolution and body parsing (the cap is part of it, SPEC.md:274-275) before
the `requestId` lookup; Fastify's lifecycle gives exactly this order with
auth in `onRequest` (Fastify checks the media type, then `Content-Length`
against `bodyLimit`, then reads). So an unauthenticated oversized body is
401, never 413, and is never read. Step 4 before 6: a non-Ready function
answers 404 even for a malformed body. Step 7 after 3: a replay still
spends a rate token.
`Store.createRun` also dedupes on `runs_idem_idx` and returns
`ConflictError` on a concurrent mismatch: map it to `IdempotencyConflict`
and `created: false` to the replay response (SPEC.md:494, 433-434).

Fingerprint (SPEC.md:226-228, 527-529, docs/API.md:199-204): lowercase
hex SHA-256 of `canonicalize({ input, priority: body.priority ?? 0,
callback: body.callback ?? null })` over the parsed body before the
Function default callback is applied; `requestId` and `wait` excluded;
stored in `request_hash`. Property test with fast-check: key order and
whitespace never change the hash; any change to `input`, `priority` or
`callback.url` does.

## 4. Public error table (docs/API.md:322-342)

Envelope (docs/API.md:302-320): `{ "error": { "code": <http>, "message",
"status", "details": [ { "@type":
"type.googleapis.com/google.rpc.ErrorInfo", "reason", "domain":
"krun.io", "metadata"? }, { "@type":
"type.googleapis.com/google.rpc.BadRequest", "fieldViolations": [ { "field",
"description" } ] }? ] } }`. `details[0]` is always the `ErrorInfo`.

| HTTP | `status` | `reason` | Tag | When | PLAN |
|---|---|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | `REQUEST_INVALID` | `RequestInvalid` | malformed or empty JSON, `null` or unknown field, unknown query parameter, bad or mismatched page token, negative `pageSize`, bad duration, `priority` out of range | P3.1a, P3.3, P3.4, P5.1 |
| 400 | `INVALID_ARGUMENT` | `INPUT_SCHEMA_VIOLATION` | `InputSchemaViolation` | `input` fails `inputSchema`; `BadRequest.fieldViolations` per violation | P3.3 |
| 400 | `INVALID_ARGUMENT` | `FILTER_INVALID` | `FilterInvalid` | `filter` outside the grammar | P3.4 |
| 400 | `INVALID_ARGUMENT` | `CALLBACK_NOT_ALLOWED` | `CallbackNotAllowed` | host outside the allowlist or resolving to a disallowed address; `fieldViolations[0].field` `callback.url` | P3.3 |
| 400 | `FAILED_PRECONDITION` | `RUN_TERMINAL` | `RunTerminal` | `CancelRun` on `SUCCEEDED` or `FAILED`; `metadata.state` | P3.5 |
| 400 | `FAILED_PRECONDITION` | `RUN_NOT_TERMINAL` | `RunNotTerminal` | `GetRunResult` before terminal | P3.6 |
| 401 | `UNAUTHENTICATED` | `KEY_MISSING`, `KEY_INVALID` | `KeyMissing`, `KeyInvalid` | no or unknown bearer key | P3.1a |
| 403 | `PERMISSION_DENIED` | `SCOPE_MISSING` | `ScopeMissing` | method scope missing, or `runs:priority` for `priority` above 0; `metadata.scope` | P3.1a, P3.3 |
| 404 | `NOT_FOUND` | `ROUTE_NOT_FOUND` | `RouteNotFound` | unknown path or method, any listener | P3.1a |
| 404 | `NOT_FOUND` | `FUNCTION_NOT_FOUND` | `FunctionNotFound` | missing, not Ready, outside globs; generic message | P3.1a, P3.2 |
| 404 | `NOT_FOUND` | `RUN_NOT_FOUND` | `RunNotFound` | missing, or created by another key | P3.4 |
| 404 | `NOT_FOUND` | `RESULT_MISSING` | `ResultMissing` | terminal run without a result | P3.6 |
| 409 | `ABORTED` | `IDEMPOTENCY_CONFLICT` | `IdempotencyConflict` | `requestId` reused with another fingerprint | P3.3 |
| 413 | `INVALID_ARGUMENT` | `INPUT_TOO_LARGE` | `InputTooLarge` | body above `Function.maxInputBytes` (deviation 5) | P3.3 |
| 415 | `INVALID_ARGUMENT` | `CONTENT_TYPE_UNSUPPORTED` | `ContentTypeUnsupported` | body `Content-Type` not `application/json` (deviation 7) | P3.1a |
| 429 | `RESOURCE_EXHAUSTED` | `RATE_LIMITED` | `RateLimited` | per-key token bucket; `Retry-After: 1` | P3.3 |
| 429 | `RESOURCE_EXHAUSTED` | `QUEUE_FULL` | `QueueFull` | function or key `maxQueued`; `Retry-After: 1`; `metadata.limit` | P3.3 |
| 500 | `INTERNAL` | `INTERNAL` | any defect, `DatabaseError` | unexpected; `message` carries no internals | P3.1a |
| 503 | `UNAVAILABLE` | `NOT_READY` | `NotReady` | database or informer not ready at startup; `Retry-After: 1`; during the drain `/v1` serves normally, after close connections are refused | P3.1a, P3.7 |

The rate limit applies to every authenticated `/v1` call (docs/API.md:361-
366), not only `CreateRun`; the admission metric counts only `CreateRun`
rejections with the four reasons (SPEC.md:1165).

## 5. Internal API (`KRUN_INTERNAL_LISTEN_ADDR`, default `:8081`, base `/internal/v1`), P3.8

Per-run token only, API keys rejected; valid for the run in the path while
`queued` with a token, `scheduled` or `running` (INTERNAL-API.md:48-66,
SPEC.md:301-305). Not resource-oriented; sub-resource paths, no custom
methods (INTERNAL-API.md:382-384).

| Operation | HTTP | Fastify `bodyLimit` | Body schema | Success |
|---|---|---|---|---|
| `GetInput` | `GET /internal/v1/runs/:run/input` | n/a | none | 200, `Content-Type: application/json`, `Content-Length`, the input re-serialised |
| `ReportStatus` | `POST /internal/v1/runs/:run/status` | 16384 (413 `REQUEST_TOO_LARGE`) | `z.strictObject({ message: 1..1024 bytes, progress?: 0..1, data?: object <= 4096 bytes })` | 204 |
| `SetResult` | `PUT /internal/v1/runs/:run/result` | `KRUN_MAX_RESULT_BYTES` (413 `RESULT_TOO_LARGE`) | any JSON value except `null` (opaque) | 204 |
| `SetError` | `PUT /internal/v1/runs/:run/error` | 32768 (413 `REQUEST_TOO_LARGE`) | `z.strictObject({ message: 1..4096 bytes, type?: <= 128 bytes, details?: object <= 8192 bytes })` | 204 |

Rules (INTERNAL-API.md:80-206):

- `Content-Type` parameters (`charset=utf-8`) ignored; unknown-field
  rejection only on top-level `status` and `error` fields; `data`,
  `details`, `result` are opaque.
- Byte limits are the UTF-8 length of the field's compact
  `JSON.stringify` after parsing (`Buffer.byteLength`), checked in a Zod
  `refine`, not string `length`.
- `ReportStatus`: wholesale replace of `runtime_status` as `{ message,
  progress, data, at }`, `at` = `DateTime.now` at receipt; `reportTime` in
  the body is an unknown field; 1 accepted report per second per run per
  replica from the last 204, beyond is 429 `STATUS_RATE_LIMITED`, dropped;
  `setRuntimeStatus` notifies, writes no `run_events` row.
- `SetResult` replaces `result`; `SetError` stored with `source: FUNCTION`,
  never overwritten by a later terminal error (`coalesce(error,
  patch.error)`), never changes state.
- `{run}` not a lowercase UUID, unknown, another run's token or a dead state
  are all 401 `TOKEN_INVALID` (INTERNAL-API.md:55-66).

Check order, first failing check answers (INTERNAL-API.md:97-104):

| Step | Fails as | Tag | Where |
|---|---|---|---|
| 1. route and version | 404 `ROUTE_NOT_FOUND` / `UNSUPPORTED_API_VERSION` | `RouteNotFound` / `UnsupportedApiVersion` | not-found handler, `^/internal/v([1-9]\d*)(/|$)` |
| 2. token hash and run state | 401 `TOKEN_INVALID` | `TokenInvalid` | `onRequest`, reads `job_token_hash` and `state` |
| 3. `Content-Type` | 415 `CONTENT_TYPE_UNSUPPORTED` | `ContentTypeUnsupported` | parser |
| 4. body cap | 413, body unread, `Connection: close` | `RequestTooLarge` / `ResultTooLarge` | route `bodyLimit` |
| 5. body validation | 400 `REQUEST_INVALID` | `RequestInvalid` | Zod |
| 6. status window (accepted reports only) | 429 `STATUS_RATE_LIMITED`, `Retry-After: 1` | `StatusRateLimited` | handler, `Clock` |
| 7. guarded store write (state in queued-with-token, scheduled, running) | zero rows: 401 `TOKEN_INVALID`, nothing written or notified | `TokenInvalid` | handler |
| each store call | `Effect.timeout("5 seconds")` from after validation, query aborted: 503 `NOT_READY` | `NotReady` | handler |

Step 2 runs before the body is read, so a request with a bad token and an
oversized body is 401, not 413. The doc starts the 5 s timer after the body
is validated; the step 2 token read is not covered by that sentence, so
bound it with the same `Effect.timeout` and answer 503 `NOT_READY`
(reading, pin it in a test).

## 6. Internal error table (INTERNAL-API.md:275-286)

Same envelope and `ErrorInfo.reason` rule as section 4. Fastify's own
body-size and content-type errors are rewritten into it.

| HTTP | `status` | `reason` | Tag | When |
|---|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | `REQUEST_INVALID` | `RequestInvalid` | malformed or empty JSON, `null` body on `SetResult`, unknown top-level field, empty `message`, field over its limit, `progress` outside 0 to 1 |
| 401 | `UNAUTHENTICATED` | `TOKEN_INVALID` | `TokenInvalid` | missing, malformed, unknown, wrong or unknown run, non-accepting state, or the guarded write affected zero rows |
| 404 | `NOT_FOUND` | `ROUTE_NOT_FOUND` | `RouteNotFound` | unknown path or method on the internal listener, `/v1` paths included |
| 404 | `NOT_FOUND` | `UNSUPPORTED_API_VERSION` | `UnsupportedApiVersion` | `/internal/v<other>` |
| 413 | `INVALID_ARGUMENT` | `RESULT_TOO_LARGE` | `ResultTooLarge` | `SetResult` above `KRUN_MAX_RESULT_BYTES`; body unread, connection closed |
| 413 | `INVALID_ARGUMENT` | `REQUEST_TOO_LARGE` | `RequestTooLarge` | `ReportStatus` above 16384 or `SetError` above 32768 bytes; body unread, connection closed |
| 415 | `INVALID_ARGUMENT` | `CONTENT_TYPE_UNSUPPORTED` | `ContentTypeUnsupported` | body not `application/json` |
| 429 | `RESOURCE_EXHAUSTED` | `STATUS_RATE_LIMITED` | `StatusRateLimited` | `ReportStatus` inside the one-second window; `Retry-After: 1` |
| 500 | `INTERNAL` | `INTERNAL` | defect | unexpected |
| 503 | `UNAVAILABLE` | `NOT_READY` | `NotReady` | database not ready, or a store call over 5 s; `Retry-After: 1`; serves normally during the drain, refused after close |

Every 401 is the same `TOKEN_INVALID`, indistinguishable by design; the
token is never logged, echoed or rotated (INTERNAL-API.md:63-66,
SPEC.md:990).

## 7. Tagged errors and framework errors (STACK.md 4.2)

- One tag file for both listeners: `RequestInvalid({ fieldViolations? })`,
  `InputSchemaViolation`, `FilterInvalid`, `CallbackNotAllowed`,
  `RunTerminal({ state })`, `RunNotTerminal`, `KeyMissing`, `KeyInvalid`,
  `ScopeMissing({ scope })`, `RouteNotFound`, `FunctionNotFound`,
  `RunNotFound`, `ResultMissing`, `IdempotencyConflict`, `InputTooLarge`,
  `ContentTypeUnsupported`, `RateLimited`, `QueueFull({ limit })`,
  `NotReady`, `TokenInvalid`, `UnsupportedApiVersion`, `ResultTooLarge`,
  `RequestTooLarge`, `StatusRateLimited`. Rows: sections 4 and 6.
- Store tags map at the route: `NotFoundError` to `RunNotFound` (public) or
  `TokenInvalid` (internal); `ConflictError` to `IdempotencyConflict`;
  `DatabaseError` to 500 on `/v1`; the internal `TimeoutError` to
  `NotReady`.
- `setErrorHandler` turns framework errors into tags:
  `FST_ERR_CTP_BODY_TOO_LARGE` (per listener/route),
  `FST_ERR_CTP_INVALID_MEDIA_TYPE` to `ContentTypeUnsupported`,
  `FST_ERR_CTP_INVALID_JSON_BODY` / `FST_ERR_CTP_EMPTY_JSON_BODY` /
  `FST_ERR_VALIDATION` (`hasZodFastifySchemaValidationErrors`) to
  `RequestInvalid` with `fieldViolations` from `err.validation[].instancePath`;
  `isResponseSerializationError` is a defect, 500.
- `message` never carries input values, the key, the token, SQL or a stack.
