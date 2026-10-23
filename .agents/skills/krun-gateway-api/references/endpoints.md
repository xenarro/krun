# Gateway endpoints, CreateRun outcomes and error tables

Copied from the current SPEC.md section 4, docs/API.md and
docs/INTERNAL-API.md with the PLAN task that implements each row. SPEC.md
section 4 defers to docs/API.md (SPEC.md:193-198) and docs/INTERNAL-API.md
(SPEC.md:301-302); re-verify line numbers before citing them in code or
tests. All three listeners answer 404 `ROUTE_NOT_FOUND` for the other
listeners' paths (SPEC.md:181, docs/API.md:332).

## 1. Admin listener (`KRUN_ADMIN_LISTEN_ADDR`, default `:9090`)

No authentication, never exposed outside the cluster (SPEC.md:183). Served
by the shared plugin in `packages/shared/src/health/` (PLAN.md:106); the
`krun-process-runtime` skill owns it. Listed here only so the gateway wires
it (P3.7).

| Method and path | Notes | PLAN task |
|---|---|---|
| `GET /healthz` | process alive, liveness probe (SPEC.md:187) | P0.7, wired by P3.7 |
| `GET /readyz` | database reachable and Function informer synced; 503 during shutdown; readiness probe (SPEC.md:188) | P0.7, wired by P3.7 |
| `GET /metrics` | Prometheus (SPEC.md:189) | P0.7, P3.1b |

## 2. Public API (`KRUN_LISTEN_ADDR`, default `:8080`, base `/v1`)

Method table, SPEC.md:200-210, with returns from docs/API.md:167-177.

| Method | HTTP | Scope | Returns | PLAN task |
|---|---|---|---|---|
| `ListFunctions` | `GET /v1/functions` | `functions:read` | `{ functions, nextPageToken }` | P3.2 |
| `GetFunction` | `GET /v1/functions/{function}` | `functions:read` | `Function` | P3.2 |
| `CreateRun` | `POST /v1/functions/{function}/runs?requestId=&wait=` | `runs:write` | `Run`, 201, `Location` | P3.3 (+ P5.1 for `wait`) |
| `GetRun` | `GET /v1/functions/{function}/runs/{run}` | `runs:read` | `Run` (FULL; `view=BASIC` accepted) | P3.4 |
| `ListRuns` | `GET /v1/functions/{function}/runs?pageSize=&pageToken=&filter=` | `runs:read` | `{ runs, nextPageToken }`, items BASIC | P3.4 |
| `WaitRun` | `POST /v1/functions/{function}/runs/{run}:wait` | `runs:read` | `Run`, 200 | P5.1 |
| `CancelRun` | `POST /v1/functions/{function}/runs/{run}:cancel` | `runs:write` | `Run`, 200 | P3.5 |
| `GetRunResult` | `GET /v1/functions/{function}/runs/{run}:getResult` | `runs:read` | the result document, or 307 | P3.6 |
| `WatchRun` | `GET /v1/functions/{function}/runs/{run}:watch` | `runs:read` | `text/event-stream` | P5.2 |

Notes per row:

- `{function}` may be `-` (wildcard) in `GetRun`, `ListRuns` and the run
  custom methods (docs/API.md:21-22). There is no `DeleteRun` and no
  `UpdateRun` (docs/API.md:179-180).
- `ListFunctions`: `pageSize` default 50, max 200, no filter, ordered by
  `name`, Ready functions matching the key's globs only; no match is an
  empty list, not an error (docs/API.md:184-186).
- `GetFunction`: missing, not Ready and outside-globs are one generic
  `FUNCTION_NOT_FOUND` (docs/API.md:190-193); exposes `callback`,
  `queueTimeout`, `maxInputBytes`, `maxResultBytes`, `maxWait` beside the
  limits (SPEC.md:250-252, docs/API.md:71-83).
- `ListRuns`: order `createTime desc`, run id `desc`; token binds parent and
  `filter`; `pageSize` above 200 coerced, negative `REQUEST_INVALID`;
  `filter` grammar `state`, `failureReason`, `createTime` with `AND`
  (SPEC.md:236-240, docs/API.md:238-249).
- `CancelRun`: body `{}`; 200 from `QUEUED`/`SCHEDULED`/`RUNNING`
  (transition to `cancelling`, `payload.actor` = key name); 200 with no
  transition when already `CANCELLING`/`CANCELLED`; `RUN_TERMINAL` on
  `SUCCEEDED`/`FAILED` (SPEC.md:269-273, SPEC.md:356, docs/API.md:260-267).
- `GetRunResult`: 200 inline document; 307 to a presigned GET valid 300 s
  with `Cache-Control: no-store`; `RESULT_MISSING`; `RUN_NOT_TERMINAL`; a
  200 does not mean `SUCCEEDED` (SPEC.md:653, docs/API.md:271-281).
- `WatchRun`: see `sse-wait.md`.

## 3. CreateRun outcomes (P3.3, P5.1)

Order of checks is fixed by docs/API.md:204-207 and docs/INTERNAL-API.md's
sibling rule that body caps come before parsing (SPEC.md:274-275). Every
429 carries `Retry-After: 1` (SPEC.md:266-268).

| Step | Outcome | Status, `reason`, headers | Source |
|---|---|---|---|
| body cap from `Content-Length`, then the counted stream, before parsing | above `KRUN_MAX_INPUT_BYTES` | 413 `INPUT_TOO_LARGE`; `krun_admission_rejections_total{reason="input_size"}` | SPEC.md:274-275, docs/API.md:337, SPEC.md:1133 |
| bearer key | missing / unknown | 401 `KEY_MISSING` / `KEY_INVALID` | docs/API.md:330 |
| scope `runs:write` | missing | 403 `SCOPE_MISSING`, `metadata.scope` | docs/API.md:331 |
| rate limit, token bucket per key per replica | empty bucket | 429 `RATE_LIMITED`, `Retry-After: 1`; reason `rate_limit` | SPEC.md:266-268, SPEC.md:1102 |
| function resolution: Ready and inside the key's globs | otherwise | 404 `FUNCTION_NOT_FOUND`, generic message | SPEC.md:150-153, docs/API.md:333 |
| content type, body parse, unknown field, `null`, unknown query | otherwise | 415 `CONTENT_TYPE_UNSUPPORTED`; 400 `REQUEST_INVALID` | docs/API.md:50-54, 324, 338 |
| `requestId` lookup on `(key, function, requestId)` | equal fingerprint | 201, `Location`, `Idempotent-Replay: true`, current run, honours `wait` | SPEC.md:225-233, docs/API.md:199-211 |
| same | different fingerprint | 409 `ABORTED` `IDEMPOTENCY_CONFLICT` | docs/API.md:336 |
| `input` against `inputSchema` | violation | 400 `INPUT_SCHEMA_VIOLATION`, `BadRequest.fieldViolations`; reason `schema` | docs/API.md:325, SPEC.md:1133 |
| `priority` 0-9; above 0 needs `runs:priority` | out of range / no scope | 400 `REQUEST_INVALID` / 403 `SCOPE_MISSING` | SPEC.md:234, docs/API.md:324, 331 |
| callback: request's, else the Function's default; host glob + address check | rejected | 400 `CALLBACK_NOT_ALLOWED`, `fieldViolations[0].field` = `callback.url` | SPEC.md:234-235, SPEC.md:1062-1068, docs/API.md:327 |
| `countQueued(fn)` vs Function `maxQueued`; `countQueuedBy(fn, key)` vs the key's `maxQueued` | reached | 429 `QUEUE_FULL`, `Retry-After: 1`, `metadata.limit` `function` or `key`; reason `max_queued` | SPEC.md:500-501, SPEC.md:974-975, docs/API.md:340 |
| `createRun` (subscribe to the id first when `wait` is set) | created | 201, FULL `Run`, `Location: /v1/functions/{function}/runs/{run}` | SPEC.md:225, SPEC.md:295-296, docs/API.md:219-221 |
| `wait=<duration>` | run terminal or duration elapsed or shutdown | still 201; client reads `state` | SPEC.md:232-233, docs/API.md:212-217 |
| store or informer not ready | | 503 `NOT_READY`, `Retry-After: 1` (never during the SIGTERM drain) | docs/API.md:342 |

Fingerprint: lowercase hex SHA-256 of the RFC 8785 (JCS) serialisation of
`{ input, priority, callback }` as received, absent `priority` as `0`,
absent `callback` as `null`, before the Function's default callback is
applied; `requestId` and `wait` excluded; stored in `request_hash`
(SPEC.md:226-228, SPEC.md:527-529, docs/API.md:200-204). Serialise with
the `canonicalize` package, hash with `node:crypto` (docs/STACK.md 2.5).

## 4. Public error table (docs/API.md:322-342, binding through SPEC.md:218-224)

Envelope: `{ error: { code, message, status, details: [ErrorInfo, ...] } }`;
`details[0]` is always `google.rpc.ErrorInfo` with `reason` and
`domain: "krun.io"` (docs/API.md:302-320).

| HTTP | `status` | `reason` | When | PLAN task |
|---|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | `REQUEST_INVALID` | malformed or empty JSON, `null` or unknown field, unknown query parameter, bad or mismatched page token, negative `pageSize`, bad duration, `priority` out of range | P3.1a, P3.3, P3.4, P5.1 |
| 400 | `INVALID_ARGUMENT` | `INPUT_SCHEMA_VIOLATION` | `input` fails `inputSchema`; `BadRequest.fieldViolations` lists each violation | P3.3 |
| 400 | `INVALID_ARGUMENT` | `FILTER_INVALID` | `filter` outside the grammar | P3.4 |
| 400 | `INVALID_ARGUMENT` | `CALLBACK_NOT_ALLOWED` | callback host outside the allowlist or resolving to a disallowed address; `fieldViolations[0].field` is `callback.url` | P3.3 |
| 400 | `FAILED_PRECONDITION` | `RUN_TERMINAL` | `CancelRun` on a `SUCCEEDED` or `FAILED` run; `metadata.state` | P3.5 |
| 400 | `FAILED_PRECONDITION` | `RUN_NOT_TERMINAL` | `GetRunResult` before the terminal state | P3.6 |
| 401 | `UNAUTHENTICATED` | `KEY_MISSING`, `KEY_INVALID` | no or unknown bearer key | P3.1a |
| 403 | `PERMISSION_DENIED` | `SCOPE_MISSING` | the key lacks the method's scope, or `runs:priority` for `priority` above 0; `metadata.scope` names it | P3.1a, P3.3 |
| 404 | `NOT_FOUND` | `ROUTE_NOT_FOUND` | unknown path or method on any listener | P3.1a |
| 404 | `NOT_FOUND` | `FUNCTION_NOT_FOUND` | missing, not Ready, or outside the key's globs; generic message | P3.1a, P3.2 |
| 404 | `NOT_FOUND` | `RUN_NOT_FOUND` | missing, or created by another key | P3.4 |
| 404 | `NOT_FOUND` | `RESULT_MISSING` | terminal run without a result | P3.6 |
| 409 | `ABORTED` | `IDEMPOTENCY_CONFLICT` | `requestId` reused with a different request fingerprint | P3.3 |
| 413 | `INVALID_ARGUMENT` | `INPUT_TOO_LARGE` | body above `Function.maxInputBytes` (deviation 5) | P3.3 |
| 415 | `INVALID_ARGUMENT` | `CONTENT_TYPE_UNSUPPORTED` | body `Content-Type` other than `application/json` (deviation 7) | P3.1a |
| 429 | `RESOURCE_EXHAUSTED` | `RATE_LIMITED` | per-key token bucket; `Retry-After: 1` | P3.3 |
| 429 | `RESOURCE_EXHAUSTED` | `QUEUE_FULL` | function `maxQueued` or the key's `maxQueued` reached; `Retry-After: 1`; `metadata.limit` is `function` or `key` | P3.3 |
| 500 | `INTERNAL` | `INTERNAL` | unexpected; `message` carries no internals | P3.1a |
| 503 | `UNAVAILABLE` | `NOT_READY` | database or Function informer not ready at startup; `Retry-After: 1`. During the SIGTERM drain `/v1` keeps serving normally and only `/readyz` is 503; after the listeners close, connections are refused | P3.1a, P3.7 |

## 5. Internal API (`KRUN_INTERNAL_LISTEN_ADDR`, default `:8081`, base `/internal/v1`) — P3.8

Per-run token only; API keys rejected; token valid only for the run in the
path and only while `queued` with a token set, `scheduled` or `running`
(SPEC.md:301-305). Version segment independent of `/v1`; unknown version 404
`UNSUPPORTED_API_VERSION` (SPEC.md:306-308, D24 SPEC.md:1465).

| Operation | HTTP | Body cap | Success | Notes (SPEC.md:313-318) |
|---|---|---|---|---|
| `GetInput` | `GET /internal/v1/runs/{run}/input` | — | 200 | JSON equal to the submitted input, re-serialised (key order, whitespace, number spelling not preserved), with `Content-Length` |
| `ReportStatus` | `POST /internal/v1/runs/{run}/status` | 16384 bytes (413 `REQUEST_TOO_LARGE`) | 204 | `{ message ≤ 1 KB, progress 0-1 optional, data ≤ 4 KB }`; 1 accepted report per second per run per replica, window from the last 204, 429 `STATUS_RATE_LIMITED` beyond; stored as `runtime_status` `{ message, progress, data, at }` replaced wholesale, `at` set by the gateway at receipt; notify, never `run_events` |
| `SetResult` | `PUT /internal/v1/runs/{run}/result` | `KRUN_MAX_RESULT_BYTES` (413 `RESULT_TOO_LARGE`, body unread, connection closed) | 204 | any JSON value except `null`; replaces `result` |
| `SetError` | `PUT /internal/v1/runs/{run}/error` | 32768 bytes (413 `REQUEST_TOO_LARGE`) | 204 | `{ message ≤ 4 KB, type ≤ 128 B, details ≤ 8 KB }`; stored with `source: FUNCTION`; never overwritten later (`coalesce(error, patch.error)`); never changes state |

Check order, first failing check answers (docs/INTERNAL-API.md:97-104):
route and version (404) → token hash and run state (401) → `Content-Type`
(415) → body cap (413) → body validation (400) → status rate limit (429,
accepted reports only) → store write guarded by state, zero rows = 401
`TOKEN_INVALID` with nothing written or notified. Each store call bounded
to 5 s from after the body is read and validated (`Effect.timeout`, the
`NotReady` tagged error); on expiry cancel the query and answer 503
`NOT_READY`. Body caps are per-route Fastify `bodyLimit`; body shapes are
`z.strictObject` schemas, `data` and `details` opaque. Per-field byte limit = UTF-8 length of the
compact JSON serialisation after parsing (docs/INTERNAL-API.md:90-94).

## 6. Internal error table (docs/INTERNAL-API.md:275-286) — P3.8

| HTTP | `status` | `reason` | When |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | `REQUEST_INVALID` | malformed or empty JSON, `null` body on `SetResult`, unknown top-level field, empty `message`, field over its limit, `progress` outside 0 to 1 |
| 401 | `UNAUTHENTICATED` | `TOKEN_INVALID` | missing, malformed, unknown, wrong or unknown run, run not in an accepting state, or the guarded write affected zero rows |
| 404 | `NOT_FOUND` | `ROUTE_NOT_FOUND` | unknown path or method on the internal listener, including public `/v1` paths |
| 404 | `NOT_FOUND` | `UNSUPPORTED_API_VERSION` | `/internal/v<other>` |
| 413 | `INVALID_ARGUMENT` | `RESULT_TOO_LARGE` | `SetResult` body above `KRUN_MAX_RESULT_BYTES`; body unread, connection closed |
| 413 | `INVALID_ARGUMENT` | `REQUEST_TOO_LARGE` | `ReportStatus` body above 16384 or `SetError` body above 32768 bytes; body unread, connection closed |
| 415 | `INVALID_ARGUMENT` | `CONTENT_TYPE_UNSUPPORTED` | body not `application/json` |
| 429 | `RESOURCE_EXHAUSTED` | `STATUS_RATE_LIMITED` | `ReportStatus` inside the one-second window; `Retry-After: 1` |
| 500 | `INTERNAL` | `INTERNAL` | unexpected |
| 503 | `UNAVAILABLE` | `NOT_READY` | database not ready, or a store call exceeded 5 seconds; `Retry-After: 1`. During the gateway's SIGTERM drain the listener keeps serving; after it closes, connections are refused |

Every 401 is the same `TOKEN_INVALID`; the cases are indistinguishable by
design (docs/INTERNAL-API.md:65-66). The token is never logged, never
echoed, never rotated (docs/INTERNAL-API.md:63-64, SPEC.md:986).
