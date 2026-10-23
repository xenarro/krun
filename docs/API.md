# krun public API contract, v1

Status: normative for the public API, 2026-10-22. SPEC.md section 4 summarises
this document and defers to it; the internal API that job pods use is not
resource-oriented and stays in SPEC.md section 4. The design follows the
Google API Improvement Proposals (AIPs): resource-oriented design (AIP-121),
resource names (AIP-122), enums (AIP-126), standard methods (AIP-131 to
AIP-133), custom methods (AIP-136), timestamps and durations (AIP-142),
request identification (AIP-155), partial responses as views (AIP-157),
pagination (AIP-158), reading across collections (AIP-159), filtering
(AIP-160), versioning (AIP-185), errors (AIP-193), field behaviour
(AIP-203). Deviations are listed in section 11.

## 1. Conventions

- Base path `/v1` on the gateway's public listener. JSON bodies, UTF-8.
  Request and response field names are lowerCamelCase.
- Resource names (AIP-122): `functions/{function}` and
  `functions/{function}/runs/{run}`. `{function}` is a DNS-1123 label;
  `{run}` is a lowercase UUIDv7 assigned by krun. Every resource carries its
  full name in `name`. The wildcard `-` (AIP-159) may replace `{function}`
  in `GetRun`, `ListRuns` and the run custom methods.
- Timestamps (AIP-142): RFC 3339, UTC, millisecond precision; timestamp
  field names end in `Time`, duration field names never do. Durations are
  strings matching `^\d+(ms|s|m|h)$`, the same grammar as every other krun
  duration (section 11, deviation 1).
- Enums (AIP-126): UPPER_SNAKE_CASE strings. An `_UNSPECIFIED` value is
  never emitted and is rejected on input. Only fields typed `enum` follow
  this rule: `jobStatus.phase`, `jobStatus.reason` and `error.type` are
  typed `string` and carry their origin's value verbatim (Kubernetes
  `Running`, `ImagePullBackOff`; the function's reported `type`), never
  re-cased or enumerated. Response enums are open: a client treats an
  unknown value as opaque; the OpenAPI document types them `string` with
  the known values in `description`, never a closed `enum`. Request enums
  (`view`, filter operands) are closed.
- Presence: a field with no value is omitted, never `null`; fields outside
  the response's view are omitted; a set field is always emitted, including
  `0`, `false` and `""`. On input, `null` is rejected like an unknown field
  (deviation 2). Zod schemas use `.optional()`, never `.nullable()`, so
  the generated OpenAPI has no nullable field.
- Field behaviour (AIP-203) is marked per field: REQUIRED, OPTIONAL,
  IMMUTABLE, OUTPUT_ONLY. Output-only fields in a request body are
  ignored, not rejected.
- Authentication: `Authorization: Bearer <api key>` on every call. Scopes:
  `functions:read`, `runs:read`, `runs:write`, `runs:priority`, `admin`.
  A key reaches only the functions matching its globs and the runs it
  created; `admin` reaches everything (SPEC.md section 9).
- `X-Request-Id`: accepted up to 128 characters, else replaced by a UUID;
  echoed on every response; present in every log line as `reqId`.
- Unknown query parameters and unknown body fields are rejected with
  `INVALID_ARGUMENT` `REQUEST_INVALID` (deviation 2). A body whose
  `Content-Type` is not `application/json` is 415 (deviation 7). An unknown
  path or method is 404 `ROUTE_NOT_FOUND`. Every error, including those the
  framework raises, is rendered in the section 4 envelope.
- Pagination (AIP-158): `pageSize` absent or `0` means the default, above
  the maximum is coerced to it, negative is `REQUEST_INVALID`; `pageSize`
  may change between pages. Page tokens are opaque and bind the parent and
  the `filter` they were issued for; a token replayed with either changed,
  or a malformed token, is `REQUEST_INVALID`. Tokens do not expire.
  `nextPageToken` is an empty string on the last page.
- Every response that can be retried carries `Retry-After`.

## 2. Resources

### 2.1 Function

Read-only through this API; managed as a Kubernetes custom resource
(SPEC.md section 3). Only Ready functions the key may use exist from the
API's point of view.

| Field | Type | Behaviour | Notes |
|---|---|---|---|
| `name` | string | OUTPUT_ONLY | `functions/{function}` |
| `inputSchema` | object | OUTPUT_ONLY | JSON Schema 2020-12 applied to `Run.input` |
| `maxConcurrency` | int32 | OUTPUT_ONLY | |
| `maxQueued` | int32 | OUTPUT_ONLY | |
| `queueTimeout` | duration | OUTPUT_ONLY | runs queued longer fail with `QUEUE_TIMEOUT` |
| `activeDeadlineSeconds` | int32 | OUTPUT_ONLY | |
| `heartbeatTimeout` | duration | OUTPUT_ONLY | omitted when unset |
| `callback` | object `Callback` | OUTPUT_ONLY | `{ "url": "https://..." }`, the default for `Run.callback`; omitted when unset |
| `maxInputBytes` | int32 | OUTPUT_ONLY | installation limit, identical on every function, default 262144 |
| `maxResultBytes` | int32 | OUTPUT_ONLY | installation limit, default 262144 |
| `maxWait` | duration | OUTPUT_ONLY | installation cap on `wait` and `timeout`, default `60s` |

```json
{ "name": "functions/report-generator",
  "inputSchema": { "type": "object", "required": ["from", "to"],
                   "properties": { "from": { "type": "string", "format": "date" },
                                   "to":   { "type": "string", "format": "date" } } },
  "maxConcurrency": 10, "maxQueued": 1000, "queueTimeout": "1h",
  "activeDeadlineSeconds": 3600, "heartbeatTimeout": "5m",
  "callback": { "url": "https://hooks.acme.com/krun" },
  "maxInputBytes": 262144, "maxResultBytes": 262144, "maxWait": "60s" }
```

### 2.2 Run

One execution of a function. Runs are the long-running resource
themselves; there is no separate Operation (deviation 3).

| Field | Type | Behaviour | View | Notes |
|---|---|---|---|---|
| `name` | string | OUTPUT_ONLY | BASIC | `functions/{function}/runs/{run}` |
| `state` | enum `State` | OUTPUT_ONLY | BASIC | `QUEUED`, `SCHEDULED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLING`, `CANCELLED` |
| `attempt` | int32 | OUTPUT_ONLY | BASIC | scheduler claims |
| `priority` | int32 | OPTIONAL, IMMUTABLE | BASIC | 0 to 9, default 0, higher first; above 0 needs `runs:priority` |
| `input` | object | REQUIRED, IMMUTABLE | FULL | validated against `Function.inputSchema`; at most `Function.maxInputBytes` |
| `callback` | object `Callback` | OPTIONAL, IMMUTABLE | BASIC | `{ "url": "https://..." }`; default from `Function.callback` |
| `result` | JSON value | OUTPUT_ONLY | FULL | inline result, any JSON value except `null`, at most `Function.maxResultBytes` |
| `resultUri` | string | OUTPUT_ONLY | BASIC | `s3://<bucket>/runs/<run>/result.json` when the result is in object storage; set only with `SUCCEEDED`, never beside `result` |
| `error` | object `Error` | OUTPUT_ONLY | BASIC, `details` FULL | `{ source, message, type, details }`; `source` is enum `FUNCTION`, `KUBERNETES` or `KRUN`; `type` is a string |
| `logTail` | string | OUTPUT_ONLY | FULL | last 100 log lines, 16 KB, failed runs only |
| `failureReason` | enum `FailureReason` | OUTPUT_ONLY | BASIC | `EXIT_CODE`, `OOM_KILLED`, `DEADLINE_EXCEEDED`, `EVICTED`, `DISRUPTED`, `HEARTBEAT_TIMEOUT`, `JOB_CREATE_FAILED`, `JOB_LOST`, `QUEUE_TIMEOUT`; set only with `FAILED` |
| `runtimeStatus` | object `RuntimeStatus` | OUTPUT_ONLY | BASIC | `{ message, progress, data, reportTime }`, the function's last report; `reportTime` is set by the gateway at receipt |
| `jobStatus` | object `JobStatus` | OUTPUT_ONLY | BASIC | `{ podName, phase, reason, message, exitCode, observeTime }`; `phase` and `reason` are strings |
| `jobName` | string | OUTPUT_ONLY | BASIC | |
| `createdBy` | string | OUTPUT_ONLY | BASIC | API key name |
| `createTime` | timestamp | OUTPUT_ONLY | BASIC | |
| `scheduleTime` | timestamp | OUTPUT_ONLY | BASIC | Job created |
| `startTime` | timestamp | OUTPUT_ONLY | BASIC | pod running; backfilled from the container's start when `RUNNING` was skipped, else omitted |
| `endTime` | timestamp | OUTPUT_ONLY | BASIC | terminal state |

Views (AIP-157): `BASIC` is every field marked BASIC, with `error.details`
removed; `FULL` is every field. `GetRun`, `CreateRun`, `WaitRun` and
`CancelRun` return FULL; `GetRun` accepts `view=BASIC`. `ListRuns` items,
`WatchRun` events and webhook payloads are always BASIC.

```json
{ "name": "functions/report-generator/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "state": "RUNNING",
  "attempt": 1,
  "priority": 0,
  "input": { "from": "2026-10-01", "to": "2026-10-21" },
  "callback": { "url": "https://hooks.acme.com/krun" },
  "runtimeStatus": { "message": "loading", "progress": 0.1,
                     "reportTime": "2026-10-22T10:00:12.000Z" },
  "jobStatus": { "podName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b-x7k2q",
                 "phase": "Running",
                 "observeTime": "2026-10-22T10:00:09.000Z" },
  "jobName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "createdBy": "reports-service",
  "createTime": "2026-10-22T10:00:00.000Z",
  "scheduleTime": "2026-10-22T10:00:03.000Z",
  "startTime": "2026-10-22T10:00:09.000Z" }
```

State machine:

- `QUEUED` to `SCHEDULED` to `RUNNING` to `SUCCEEDED` or `FAILED`.
- `QUEUED` to `FAILED` with `QUEUE_TIMEOUT` or `JOB_CREATE_FAILED`.
- `SCHEDULED` to `SUCCEEDED` when the pod finished before it was observed
  running; `SCHEDULED` to `FAILED` when the Job fails or is lost before
  `RUNNING` was observed (any reason except `HEARTBEAT_TIMEOUT`,
  `JOB_CREATE_FAILED`, `QUEUE_TIMEOUT`).
- `QUEUED`, `SCHEDULED` or `RUNNING` to `CANCELLING` on `CancelRun`; once
  `CANCELLING`, the only terminal state is `CANCELLED`, even if the pod
  finished meanwhile (the completion event is rejected as stale). A
  `CANCELLED` run may therefore carry a `result` accepted before the
  cancel, never `resultUri`.
- Terminal: `SUCCEEDED`, `FAILED`, `CANCELLED`.

The truth comes from Kubernetes, never from the function's reports
(SPEC.md section 8).

## 3. Methods

| Method | HTTP | Scope | Returns |
|---|---|---|---|
| `ListFunctions` | `GET /v1/functions` | `functions:read` | `{ functions, nextPageToken }` |
| `GetFunction` | `GET /v1/functions/{function}` | `functions:read` | `Function` |
| `CreateRun` | `POST /v1/functions/{function}/runs` | `runs:write` | `Run`, 201 |
| `GetRun` | `GET /v1/functions/{function}/runs/{run}` | `runs:read` | `Run` |
| `ListRuns` | `GET /v1/functions/{function}/runs` | `runs:read` | `{ runs, nextPageToken }` |
| `WaitRun` | `POST /v1/functions/{function}/runs/{run}:wait` | `runs:read` | `Run` |
| `CancelRun` | `POST /v1/functions/{function}/runs/{run}:cancel` | `runs:write` | `Run` |
| `GetRunResult` | `GET /v1/functions/{function}/runs/{run}:getResult` | `runs:read` | the result document |
| `WatchRun` | `GET /v1/functions/{function}/runs/{run}:watch` | `runs:read` | `text/event-stream` |

There is no `DeleteRun`: runs expire with the retention window (SPEC.md
section 10). There is no `UpdateRun`: every settable field is IMMUTABLE.

### 3.1 ListFunctions (AIP-132)

Query: `pageSize` (default 50, max 200), `pageToken`, rules in section 1.
No filter. Ordered by `name`. Returns only Ready functions the key may use;
a key with no matching function gets an empty list, not an error.

### 3.2 GetFunction (AIP-131)

`NOT_FOUND` `FUNCTION_NOT_FOUND` for a missing function, a function that
is not Ready, or a function outside the key's globs; the three cases are
indistinguishable and the message is generic. The reason a function is
not Ready is visible only on its Kubernetes `Ready` condition.

### 3.3 CreateRun (AIP-133, AIP-155)

Body: a `Run`; only `input`, `priority` and `callback` are read. Query:

- `requestId` (AIP-155): optional, at most 128 characters, UUID
  recommended; unique per key name and function. The request fingerprint
  is the lowercase hex SHA-256 of the RFC 8785 (JCS) serialisation of
  `{ input, priority, callback }` as received, with absent `priority` as
  `0` and absent `callback` as `null`, before the function's default
  callback is applied; `requestId` and `wait` are excluded. After
  authentication, scope, rate limit, function resolution and body parsing,
  and before schema, callback and `maxQueued` checks, the gateway looks up
  (key, function, `requestId`): a match with an equal fingerprint returns
  the run as it is now (no stored snapshot) with 201, `Location`,
  `Idempotent-Replay: true`, and honours `wait`; a match with a different
  fingerprint is 409 `ABORTED` `IDEMPOTENCY_CONFLICT`. Request ids live as
  long as the run row.
- `wait`: optional duration, default none, capped at `Function.maxWait`.
  The response is delayed until the run is terminal or the duration
  elapses; the status code is 201 either way and the client reads
  `state`. The server may answer earlier, including at shutdown; a
  non-terminal `state` means wait again. Set the HTTP client timeout above
  `wait`.

Response: 201 with the FULL `Run` and `Location:
/v1/functions/{function}/runs/{run}`. A client that disconnects does not
cancel the run.

### 3.4 GetRun (AIP-131)

`functions/-/runs/{run}` resolves the run by id across functions. A run of
another key is `NOT_FOUND` `RUN_NOT_FOUND`. `view` defaults to `FULL`;
`view=BASIC` is accepted.

### 3.5 ListRuns (AIP-132, AIP-158, AIP-159, AIP-160)

`functions/-/runs` lists across functions. Query: `pageSize` (default 50,
max 200), `pageToken`, `filter`. Items are BASIC. Order is fixed:
`createTime desc`, ties broken by the `{run}` id (UUIDv7) `desc`; there is
no `orderBy` (deviation 4). The page token encodes the last item's
(`createTime`, `{run}`) plus the parent and `filter` hash (section 1).
`nextPageToken` is an empty string on the last page.

`filter` is the AIP-160 subset:

```
expression := term { "AND" term }
term       := "state" ( "=" | "!=" ) State
            | "createTime" ( ">=" | "<=" | ">" | "<" ) timestamp
            | "failureReason" "=" FailureReason
```

Timestamps are quoted RFC 3339 strings. Examples: `state = RUNNING`,
`state != SUCCEEDED AND createTime >= "2026-10-22T00:00:00Z"`. Anything
else is `INVALID_ARGUMENT` `FILTER_INVALID`.

### 3.6 WaitRun (AIP-136, modelled on AIP-151 WaitOperation)

Body: `{ "timeout": "30s" }`, optional, default and cap `Function.maxWait`.
Returns 200 with the FULL `Run` as soon as it is terminal, or when the
timeout elapses, or earlier at shutdown; the client reads `state`. No
error on timeout. Set the HTTP client timeout above `timeout`.

### 3.7 CancelRun (AIP-136)

Body: `{}`. From `QUEUED`, `SCHEDULED` or `RUNNING`: the run moves to
`CANCELLING` and the response is 200 with the FULL `Run`. Already
`CANCELLING` or `CANCELLED`: 200, no new transition. `SUCCEEDED` or
`FAILED`: `FAILED_PRECONDITION` `RUN_TERMINAL` with `metadata.state`.
Cancellation is best-effort and completes asynchronously: the function may
finish before the Job is deleted, so a `CANCELLED` run may carry a
`result` accepted before the cancel, never `resultUri`; `WaitRun` or
`WatchRun` observe `CANCELLED`.

### 3.8 GetRunResult (AIP-136, read-only custom method on GET)

Terminal run with an inline `result`: 200, body is the result document
itself, `Content-Type: application/json` (deviation 8). Terminal run with
`resultUri` only: 307 whose `Location` is a presigned URL on another
origin, valid for 300 seconds, sent with `Cache-Control: no-store`; the
client follows it at once without `Authorization` or any krun header
(object stores reject two authentication mechanisms), never stores it, and
calls `:getResult` again for a fresh URL after an expiry error. Terminal
run with neither: `NOT_FOUND` `RESULT_MISSING`. Not terminal:
`FAILED_PRECONDITION` `RUN_NOT_TERMINAL`. A 200 means a result exists, not
that the run succeeded: a `FAILED` or `CANCELLED` run may keep an inline
one; read `state`. A run never has both `result` and `resultUri`.

### 3.9 WatchRun (server-streaming custom method on GET)

`Content-Type: text/event-stream`. On connect: one `state` event with the
current BASIC `Run`; a terminal run gets that event, then the stream
closes. Then one event per changed field group: `event: state`, `status`
or `job_status`; `data:` the BASIC `Run`; `id:` the field's own time
(`createTime`, `scheduleTime`, `startTime` or `endTime` for `state`, the
read time for `CANCELLING`; `runtimeStatus.reportTime`;
`jobStatus.observeTime`). The stream closes after the terminal event and on
server shutdown; a stream that ends without a terminal `state` event is
not an error, the client reconnects and receives the snapshot again.
`Last-Event-ID` is ignored. Keepalive comments (`: keepalive`) every 15
seconds.

## 4. Errors (AIP-193)

Every error, including those raised by the framework for unknown routes,
methods, content types or malformed JSON, is:

```json
{ "error": {
    "code": 400,
    "message": "input does not match the function's input schema",
    "status": "INVALID_ARGUMENT",
    "details": [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "INPUT_SCHEMA_VIOLATION", "domain": "krun.io",
        "metadata": { "function": "report-generator" } },
      { "@type": "type.googleapis.com/google.rpc.BadRequest",
        "fieldViolations": [ { "field": "input.from", "description": "must match format \"date\"" } ] }
    ] } }
```

`code` is the HTTP status, `status` the canonical code, and the first
`details` entry is always an `ErrorInfo` whose `reason` is the stable
machine-readable identifier. Clients branch on `status` and `reason`,
never on `message`. Unknown internal failures are 500 `INTERNAL` with a
generic message.

| HTTP | `status` | `reason` | When |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | `REQUEST_INVALID` | malformed or empty JSON, `null` or unknown field, unknown query parameter, bad or mismatched page token, negative `pageSize`, bad duration, `priority` out of range |
| 400 | `INVALID_ARGUMENT` | `INPUT_SCHEMA_VIOLATION` | `input` fails `inputSchema`; `BadRequest.fieldViolations` lists each violation |
| 400 | `INVALID_ARGUMENT` | `FILTER_INVALID` | `filter` outside the grammar |
| 400 | `INVALID_ARGUMENT` | `CALLBACK_NOT_ALLOWED` | callback host outside the allowlist or resolving to a disallowed address; `fieldViolations[0].field` is `callback.url` |
| 400 | `FAILED_PRECONDITION` | `RUN_TERMINAL` | `CancelRun` on a `SUCCEEDED` or `FAILED` run; `metadata.state` |
| 400 | `FAILED_PRECONDITION` | `RUN_NOT_TERMINAL` | `GetRunResult` before the terminal state |
| 401 | `UNAUTHENTICATED` | `KEY_MISSING`, `KEY_INVALID` | no or unknown bearer key |
| 403 | `PERMISSION_DENIED` | `SCOPE_MISSING` | the key lacks the method's scope, or `runs:priority` for `priority` above 0; `metadata.scope` names it |
| 404 | `NOT_FOUND` | `ROUTE_NOT_FOUND` | unknown path or method on any listener |
| 404 | `NOT_FOUND` | `FUNCTION_NOT_FOUND` | missing, not Ready, or outside the key's globs; generic message |
| 404 | `NOT_FOUND` | `RUN_NOT_FOUND` | missing, or created by another key |
| 404 | `NOT_FOUND` | `RESULT_MISSING` | terminal run without a result |
| 409 | `ABORTED` | `IDEMPOTENCY_CONFLICT` | `requestId` reused with a different request fingerprint |
| 413 | `INVALID_ARGUMENT` | `INPUT_TOO_LARGE` | body above `Function.maxInputBytes` (deviation 5) |
| 415 | `INVALID_ARGUMENT` | `CONTENT_TYPE_UNSUPPORTED` | body `Content-Type` other than `application/json` (deviation 7) |
| 429 | `RESOURCE_EXHAUSTED` | `RATE_LIMITED` | per-key token bucket; `Retry-After: 1` |
| 429 | `RESOURCE_EXHAUSTED` | `QUEUE_FULL` | function `maxQueued` or the key's `maxQueued` reached; `Retry-After: 1`; `metadata.limit` is `function` or `key` |
| 500 | `INTERNAL` | `INTERNAL` | unexpected; `message` carries no internals |
| 503 | `UNAVAILABLE` | `NOT_READY` | database or Function informer not ready at startup; `Retry-After: 1`. During the SIGTERM drain `/v1` keeps serving normally and only `/readyz` is 503; after the listeners close, connections are refused |

Body size limits are enforced from `Content-Length` and the stream before
parsing.

## 5. Idempotency and retries

- `CreateRun` is the only non-idempotent method. Clients that retry it
  must send `requestId`; a replay returns the current run, not a snapshot.
- `CancelRun` is idempotent: repeats on a `CANCELLING` or `CANCELLED` run
  return 200.
- `WaitRun`, `GetRun`, `ListRuns`, `GetRunResult` and `WatchRun` are safe.
- On 429 and 503 honour `Retry-After`; on 5xx retry with backoff; on a
  refused connection retry with backoff (a rollout); never retry 4xx other
  than 429.
- Set the HTTP client timeout above any `wait` or `timeout` you send.

## 6. Rate limits and quotas

Per API key: `KRUN_RATE_LIMIT_RPS` requests per second with burst
`KRUN_RATE_LIMIT_BURST`, per gateway replica. Per function: `maxQueued`
queued runs; per key and function: the key's `maxQueued`. Exceeding any of
them is `RESOURCE_EXHAUSTED`. Input and result sizes and the wait cap are
readable on every `Function` (`maxInputBytes`, `maxResultBytes`,
`maxWait`).

## 7. Webhooks

When a run reaches a terminal state and has a `callback`, krun POSTs the
BASIC `Run` as JSON to `callback.url` with `Content-Type:
application/json` and the headers:

- `X-Krun-Delivery`: the delivery id, a UUID constant across every attempt
  of one delivery; receivers dedupe on it. Delivery is at-least-once: six
  attempts over about 15 hours, any 2xx acknowledges.
- `X-Krun-Run-Id`: the bare `{run}` UUIDv7; the payload `name` carries the
  full resource name.
- `X-Krun-Signature`: `t=<unix seconds at send>,v1=<hex HMAC-SHA256 of
  "<t>.<body>">`; `v1=` may repeat, one per secret configured during
  rotation. Receivers accept when any `v1=` matches their secret, comparing
  in constant time, and reject `|now - t| > 300` seconds.

The BASIC payload omits `result`; fetch it with `GetRunResult`.

```
POST /krun HTTP/1.1
Host: hooks.acme.com
Content-Type: application/json
X-Krun-Delivery: 019a1c11-5c2e-7a3b-8d4f-0e1f2a3b4c5d
X-Krun-Run-Id: 019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b
X-Krun-Signature: t=1761127240,v1=3f1a...,v1=9c0b...

{ "name": "functions/report-generator/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "state": "SUCCEEDED", "attempt": 1, "priority": 0,
  "resultUri": "s3://krun/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b/result.json",
  "jobStatus": { "podName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b-x7k2q", "phase": "Succeeded",
                 "exitCode": 0, "observeTime": "2026-10-22T10:00:40.000Z" },
  "jobName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b", "createdBy": "reports-service",
  "createTime": "2026-10-22T10:00:00.000Z", "scheduleTime": "2026-10-22T10:00:03.000Z",
  "startTime": "2026-10-22T10:00:09.000Z", "endTime": "2026-10-22T10:00:40.000Z" }
```

## 8. Examples

```sh
# create and wait up to 30 seconds
curl -sS -X POST "$KRUN_API_URL/v1/functions/report-generator/runs?requestId=$(uuidgen)&wait=30s" \
  -H "Authorization: Bearer $KRUN_API_KEY" -H "Content-Type: application/json" \
  -d '{ "input": { "from": "2026-10-01", "to": "2026-10-21" } }'

# replay the same request: 201, Idempotent-Replay: true, current state
curl -sSi -X POST "$KRUN_API_URL/v1/functions/report-generator/runs?requestId=$REQ" \
  -H "Authorization: Bearer $KRUN_API_KEY" -H "Content-Type: application/json" \
  -d '{ "input": { "from": "2026-10-01", "to": "2026-10-21" } }' | grep -i -e '^HTTP' -e '^Idempotent-Replay'

# poll
curl -sS "$KRUN_API_URL/v1/functions/-/runs/$RUN" -H "Authorization: Bearer $KRUN_API_KEY"

# wait again
curl -sS -X POST "$KRUN_API_URL/v1/functions/-/runs/$RUN:wait" \
  -H "Authorization: Bearer $KRUN_API_KEY" -H "Content-Type: application/json" -d '{ "timeout": "60s" }'

# result: the inline document, or a 307 to object storage (follow without the bearer header)
curl -sS "$KRUN_API_URL/v1/functions/-/runs/$RUN:getResult" -H "Authorization: Bearer $KRUN_API_KEY" -o result.json -w '%{http_code}\n'

# cancel
curl -sS -X POST "$KRUN_API_URL/v1/functions/-/runs/$RUN:cancel" \
  -H "Authorization: Bearer $KRUN_API_KEY" -H "Content-Type: application/json" -d '{}'

# list failed runs of one function since a time
curl -sS -G "$KRUN_API_URL/v1/functions/report-generator/runs" -H "Authorization: Bearer $KRUN_API_KEY" \
  --data-urlencode 'filter=state = FAILED AND createTime >= "2026-10-22T00:00:00Z"' --data-urlencode 'pageSize=20'

# watch
curl -sS -N "$KRUN_API_URL/v1/functions/-/runs/$RUN:watch" -H "Authorization: Bearer $KRUN_API_KEY"
```

`WatchRun` transcript, connect while `RUNNING`, one status report, then
completion:

```
event: state
id: 2026-10-22T10:00:09.000Z
data: {"name":"functions/report-generator/runs/019a...","state":"RUNNING",...}

event: status
id: 2026-10-22T10:00:12.000Z
data: {"name":"functions/report-generator/runs/019a...","state":"RUNNING","runtimeStatus":{"message":"loading","progress":0.1,"reportTime":"2026-10-22T10:00:12.000Z"},...}

: keepalive

event: state
id: 2026-10-22T10:00:40.000Z
data: {"name":"functions/report-generator/runs/019a...","state":"SUCCEEDED","endTime":"2026-10-22T10:00:40.000Z",...}
```

## 9. Compatibility and versioning (AIP-185)

- `/v1` is stable once v0.1.0 ships. Additive changes (new fields, new enum
  values, new methods, new `reason` values) are not breaking; clients must
  ignore unknown fields and treat unknown enum values as opaque.
- Removing or renaming a field, changing a type, tightening a limit or
  changing an error mapping is breaking and opens `/v2`; `/v1` stays served
  for at least one minor release after `/v2` ships.
- The OpenAPI 3.1 document generated from the routes
  (`docs/api/openapi-public.json`) is the machine-readable form of this
  contract; a diff between them is a bug. Response enums are typed
  `string` there, with the known values in `description`.

## 10. Mapping to storage and to earlier names

For implementers: the database keeps lowercase states and reasons
(`queued`, `exit_code`); the API renders them UPPER_SNAKE. Column to field:
`created_at` to `createTime`, `scheduled_at` to `scheduleTime`,
`started_at` to `startTime`, `finished_at` to `endTime`, `result_ref` to
`resultUri`, `request_hash` is the idempotency fingerprint,
`runtime_status.at` (set by the gateway at receipt) to
`runtimeStatus.reportTime`, `job_status.observedAt` to
`jobStatus.observeTime`, `error.source` values to UPPER_SNAKE. `toRun(row)`
and `toRunSummary(row)` in `packages/shared/src/store` are the only
row-to-wire mappers (SPEC.md section 6); `RunSummary` is the BASIC view.

## 11. Deviations from the AIPs, and why

1. Durations use the `^\d+(ms|s|m|h)$` grammar, not the `"30s"`-only
   seconds string of AIP-142, so one grammar serves the API, the CRD and
   every environment variable.
2. Unknown fields, `null` values and unknown parameters are rejected rather
   than ignored, so a misspelled `requestId` cannot silently create a
   duplicate run.
3. Runs are the long-running resource; no `Operation` type, no
   `operations/*` collection. A run is created once and only observed
   afterwards, so an Operation would duplicate it.
4. `ListRuns` has no `orderBy`; the cursor index serves one order.
5. HTTP 413 has no canonical code; it is returned with `status`
   `INVALID_ARGUMENT` and reason `INPUT_TOO_LARGE` so size rejections stay
   distinguishable at the HTTP layer.
6. Function resources are read-only here and created through Kubernetes,
   which is their system of record.
7. HTTP 415 likewise carries `INVALID_ARGUMENT` with reason
   `CONTENT_TYPE_UNSUPPORTED`.
8. `GetRunResult` returns the result document itself, or a 307 to the
   presigned URI, not a response wrapper, so clients receive the function's
   JSON unchanged; run metadata stays on `Run`.
9. An idempotent replay returns the run's current state rather than a
   stored copy of the original response, because the resource is the
   response and its state is what a retrying client needs.
