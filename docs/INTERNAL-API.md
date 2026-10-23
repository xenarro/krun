# krun internal API contract, v1

Status: normative for the internal API, 2026-10-22. This is the HTTP
contract between a function container and the krun gateway: how a run
fetches its input, reports progress, and hands back its result or its
error. SPEC.md section 4 summarises it and defers to it; the SDKs
(SPEC.md section 7.1) are one implementation of it, and anything with an
HTTP client is another. docs/API.md is the public, resource-oriented API
for callers; this one is private, per-run, token-scoped and served on a
separate listener.

## 1. Where it lives and who may call it

- Base path `/internal/v1`, served only on the gateway's internal listener
  (`KRUN_INTERNAL_LISTEN_ADDR`, default `:8081`) behind the Service
  `krun-gateway-internal`, reachable only from the jobs namespace through
  NetworkPolicy (SPEC.md section 9). Never behind the ingress. Plain HTTP
  inside the cluster in v1; the per-run token is the credential and the
  NetworkPolicy is the perimeter (section 10, note 1).
- The caller is the `function` container of one Job pod. It learns
  everything it needs from its environment (SPEC.md section 7):

| Variable | Meaning |
|---|---|
| `KRUN_GATEWAY_URL` | base URL, for example `http://krun-gateway-internal.krun.svc:8081` |
| `KRUN_RUN_ID` | the run id, a lowercase UUIDv7 |
| `KRUN_FUNCTION` | the function name |
| `KRUN_TOKEN` | the per-run bearer token, from the per-run Secret |
| `KRUN_MAX_RESULT_BYTES` | inline result cap in bytes |
| `KRUN_RESULT_UPLOAD_URL` | presigned PUT for a result above the cap; absent when object storage is not configured |
| `KRUN_HEARTBEAT_TIMEOUT` | seconds; present only when the Function sets `heartbeatTimeout` |

  No container variable carries the input size: the installation's
  `KRUN_MAX_INPUT_BYTES` was enforced at `CreateRun`, and `GetInput` always
  sends `Content-Length`.
- Version: the path segment `v1` is independent of the public `/v1`. SDK
  major N speaks `/internal/vN`. A path matching `^/internal/v([1-9]\d*)(/|$)`
  with a version other than 1 is 404 `UNSUPPORTED_API_VERSION`; any other
  unmatched path or method is 404 `ROUTE_NOT_FOUND`; both resolve before
  authentication. Additive changes (new optional fields, new endpoints,
  new `reason` values) are not breaking.
- `User-Agent` is logged on every call and never gated on; SDKs send
  `krun-sdk-<lang>/<version>`.
- `docs/api/openapi-internal.json` (OpenAPI 3.1, generated from the
  routes) is the machine-readable form of this contract; a diff between
  them is a bug.

## 2. The per-run token

- Minted by the scheduler before the Job exists, 32 random bytes,
  base64url, delivered through the immutable Secret `krun-<run id>` and
  the `KRUN_TOKEN` environment variable. Only its SHA-256 is stored.
- Sent as `Authorization: Bearer <token>` on every call. API keys are
  rejected on this listener.
- Scope: exactly one run, the one in the path. A token presented for
  another run id, or a `{run}` that is not a lowercase UUID or not a known
  run, is 401.
- Lifetime: valid while the run is `QUEUED` with a token set, `SCHEDULED`
  or `RUNNING`; dead from `CANCELLING` on and from the terminal transition
  (`SUCCEEDED`, `FAILED`, `CANCELLED`), at most `activeDeadlineSeconds`
  after the Job started. Every call after that is 401; a container that
  outlives its run is being deleted (section 5.1).
- Compared by SHA-256 with a constant-time comparison. Never logged, never
  echoed, never rotated: a run has one token for its whole life.
- Every 401 is the same `TOKEN_INVALID`: missing, malformed, unknown,
  wrong run, or wrong state are indistinguishable by design.

## 3. Endpoints

The run is the only resource; `input`, `result` and `error` are singleton
sub-resources of it, `status` is an append-only report.

| Operation | HTTP | Idempotent | Success |
|---|---|---|---|
| `GetInput` | `GET /internal/v1/runs/{run}/input` | safe | 200, the input document |
| `ReportStatus` | `POST /internal/v1/runs/{run}/status` | no, harmless to repeat | 204 |
| `SetResult` | `PUT /internal/v1/runs/{run}/result` | yes, replaces | 204 |
| `SetError` | `PUT /internal/v1/runs/{run}/error` | yes, replaces | 204 |

Body conventions:

- Bodies are `application/json`, UTF-8; `Content-Type` parameters such as
  `charset=utf-8` are ignored. Request bodies are validated before anything
  is written.
- Whole-body caps are enforced from `Content-Length`, else from the counted
  stream, before parsing (per-route Fastify `bodyLimit`): `ReportStatus`
  16384 bytes, `SetError` 32768 bytes, `SetResult` `KRUN_MAX_RESULT_BYTES`.
  Above the cap the body is left unread, the response is 413 and the
  connection is closed.
- A per-field byte limit is the UTF-8 length of the field's compact JSON
  serialisation after parsing: no whitespace, non-ASCII unescaped (Node
  `JSON.stringify`; Python `json.dumps(v, separators=(",", ":"),
  ensure_ascii=False)`). The gateway's measure is authoritative; SDKs
  truncate with the same measure.
- Unknown-field rejection applies to the top-level fields of the `status`
  and `error` bodies; `data`, `details` and the whole `result` are opaque.
- Check order, the first failing check answers: route and version (404);
  token hash and run state (401); `Content-Type` (415); body cap (413);
  body validation (400); status rate limit (429, accepted reports only);
  then the store write, itself guarded by state in (`QUEUED` with token,
  `SCHEDULED`, `RUNNING`), where zero rows affected is 401 `TOKEN_INVALID`
  with nothing written or notified. Each store call is bounded to 5
  seconds, the timer starting after the body is read and validated; on
  expiry the query is cancelled and the answer is 503 `NOT_READY`.

### 3.1 GetInput

```
GET /internal/v1/runs/{run}/input
Authorization: Bearer <token>
```

200 with `Content-Type: application/json`, `Content-Length`, and a JSON
document equal to the submitted input (the value that passed the
Function's `inputSchema`), re-serialised by the gateway: whitespace, key
order, duplicate keys (last value wins at admission) and number spelling
are not preserved in either database mode. Compare parsed values; never
hash or diff the response bytes. Size is bounded by the installation's
`maxInputBytes` (default 262144, hard 1 MiB). Safe to call more than once.
The input never changes during a run.

### 3.2 ReportStatus

```
POST /internal/v1/runs/{run}/status
Authorization: Bearer <token>
Content-Type: application/json

{ "message": "loading rows", "progress": 0.25, "data": { "rows": 1200 } }
```

| Field | Type | Behaviour | Limit |
|---|---|---|---|
| `message` | string | REQUIRED, at least 1 byte | at most 1024 bytes |
| `progress` | number | OPTIONAL | 0 to 1 inclusive |
| `data` | object | OPTIONAL | at most 4096 bytes serialised |

204 on acceptance. The body replaces the run's `runtimeStatus` wholesale;
there is no merge, so a heartbeat re-sends the full last report. The
gateway stamps `reportTime` at receipt; a `reportTime` in the body is
`REQUEST_INVALID` like any unknown field.

Rate: at most one accepted report per second per run per gateway replica.
The one-second window starts at the last accepted (204) report on that
replica; a 429, any other 4xx or a failed write neither starts nor extends
it, so a function reporting faster than once a second still gets one
accepted report per second per replica. The next report inside the window
is 429 `STATUS_RATE_LIMITED` and is dropped, not queued. With N replicas up
to N reports per second are admitted; the last accepted one wins.

Semantics: informational only. Status never changes the run's `state`; a
function that never reports is tracked exactly like one that does. The
one exception is the heartbeat contract: when the Function sets
`heartbeatTimeout` (`KRUN_HEARTBEAT_TIMEOUT` present), the scheduler fails a
`RUNNING` run with `HEARTBEAT_TIMEOUT` when no accepted report arrives
within that window, measured from the later of the run's `startTime` (the
pod observed `Running`, so start-up work before the first report counts)
and the last accepted report. The run stays `RUNNING` until the pod exits,
so the window also covers result writing: report at least every third of
the window from start-up until the result or error call has returned.

### 3.3 SetResult

```
PUT /internal/v1/runs/{run}/result
Authorization: Bearer <token>
Content-Type: application/json

{ "rows": 42, "uri": "s3://reports/2026-10.csv" }
```

Body: any JSON value except `null`, at most `KRUN_MAX_RESULT_BYTES`
(default 262144, hard 1 MiB); above it, 413 `RESULT_TOO_LARGE` and the
caller must use `KRUN_RESULT_UPLOAD_URL` instead (section 4). 204 on
acceptance. Replaces any earlier result; the last accepted value is the
one the public API exposes. Call it before exiting: the result is read at
the terminal transition, which the pod's exit triggers. A function with
nothing to return sends no `SetResult` and exits 0: the run `SUCCEEDED`
without a result and `GetRunResult` answers `RESULT_MISSING`. Do not
combine `SetResult` with an upload (section 4).

### 3.4 SetError

```
PUT /internal/v1/runs/{run}/error
Authorization: Bearer <token>
Content-Type: application/json

{ "type": "ValidationError", "message": "column 'amount' missing",
  "details": { "stack": ["at parse (handler.js:12)", "..."] } }
```

| Field | Type | Behaviour | Limit |
|---|---|---|---|
| `message` | string | REQUIRED, at least 1 byte | at most 4096 bytes |
| `type` | string | OPTIONAL | at most 128 bytes, carried verbatim |
| `details` | object | OPTIONAL | at most 8192 bytes serialised |

204 on acceptance; replaces any earlier error. Stored as the run's `error`
with `source: FUNCTION` and surfaced to callers in preference to any
Kubernetes or krun reason: the terminal transition writes
`error = coalesce(error, <its own error>)`, so a report accepted before it
is never overwritten, whatever ends the run (`failureReason` still says
why). It does not change the state: the exit code does. Report, then exit
non-zero. A function that reports an error and exits 0 still `SUCCEEDED`
with the error attached.

## 4. Large results: the presigned upload

When `KRUN_RESULT_UPLOAD_URL` is present, a result above
`KRUN_MAX_RESULT_BYTES` is uploaded with a plain `PUT` of the raw JSON
bytes to that URL:

- The URL is presigned by the scheduler when the Job is created, for the
  object `runs/<run>/result.json`, with only the host signed: no
  `Content-Type` and no size condition (`maxResultBytes` caps the inline
  path only). Send `Content-Type: application/json` and `Content-Length`
  anyway, never chunked, no `Authorization` header (object stores reject
  two authentication mechanisms).
- TTL: `KRUN_S3_PRESIGN_TTL`, by default the Function's
  `activeDeadlineSeconds`. 200 is success. 403 or any other 4xx, including
  an expired URL: no retry; `SetError` with type `ResultWriteError`, exit
  1. Connection errors and 5xx: retry 3 times (1 s, 2 s, 4 s). Upload
  timeout 300 seconds, overriding the 10 second rule of section 7.
- After a successful upload the function does not call `SetResult`. The
  scheduler checks for the object only on the Job's `Complete` condition
  and only when no inline `result` was accepted, and sets `resultUri` on
  `SUCCEEDED`; an object left by a `FAILED` or `CANCELLED` run, or beside
  an accepted inline result, is ignored and left to the bucket lifecycle
  rule. A run therefore never carries both.
- When the variable is absent, a result above the cap cannot be stored:
  `SetError` with type `ResultWriteError` and exit 1.

## 5. The run from the container's point of view

```
container start                      (startTime: pod Running; the window has begun)
  GET  .../input                      200, work begins
  heartbeat loop (only when KRUN_HEARTBEAT_TIMEOUT is set):
    POST .../status {last report}     every third of the window, until the
                                      result or error call has returned
  POST .../status {...}  (optional)   204, or 429 dropped
  then one of:
    PUT  .../result {...}             204, exit 0
    PUT  (presigned URL) raw bytes    200, exit 0
    (nothing to return)               exit 0
    PUT  .../error {...}              204, exit 1
```

Order matters only at the end: the result or error must be accepted
before the process exits, because the exit is what the scheduler reacts
to. A rejected `SetResult` must end non-zero: call `SetError` first, while
the token still works. A result sent after the pod is already terminal is
401 and lost.

### 5.1 Cancellation

After `CancelRun` every internal call is 401 `TOKEN_INVALID`. The
scheduler deletes the Job; the pod receives SIGTERM and, 30 seconds later
(`terminationGracePeriodSeconds: 30` in the Job template), SIGKILL. A
container exits on the first 401, even from a status report, or on
SIGTERM, whichever comes first; the SDKs exit 1. A `CANCELLED` run keeps
only a result accepted before the cancel, never `resultUri`.

## 6. Errors

Same AIP-193 envelope as the public API, same `ErrorInfo.reason` rule:

```json
{ "error": { "code": 401, "message": "token invalid", "status": "UNAUTHENTICATED",
             "details": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                            "reason": "TOKEN_INVALID", "domain": "krun.io" } ] } }
```

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

Fastify's own body-size and content-type errors are rewritten into this
envelope.

## 7. Retries and timeouts for containers

- `GetInput`, `SetResult`, `SetError`: client timeout 10 seconds per call
  (connect, send, response); connection refused or reset, timeout, and
  5xx: retry 3 times with backoff (1 s, 2 s, 4 s). All three are safe to
  retry: `GetInput` is safe, the `PUT`s replace.
- `ReportStatus`, including heartbeat re-sends: one attempt with a 3
  second timeout, no retry on any outcome; the next heartbeat tick or
  `ctx.status` call is the retry. After a 429, re-send no sooner than 1
  second later.
- The presigned upload: section 4 (300 second timeout, retries on
  connection errors and 5xx only).
- 401: stop; the run is over. 4xx other than 429: a bug in the caller, do
  not retry.
- The gateway answers `GetInput` from the database in milliseconds; a slow
  answer is the database, retry.

## 8. Limits

| Limit | Value | Source |
|---|---|---|
| input | installation `maxInputBytes` (gateway `KRUN_MAX_INPUT_BYTES`, not in the container), default 262144, hard 1048576 | SPEC.md section 10 |
| inline result | `KRUN_MAX_RESULT_BYTES`, default 262144, hard 1048576 | SPEC.md section 10 |
| uploaded result | no cap | this document |
| status body | 16384 bytes | this document |
| status `message` | 1024 bytes | this document |
| status `data` | 4096 bytes | this document |
| status rate | 1 per second per run per replica | this document |
| error body | 32768 bytes | this document |
| error `message` | 4096 bytes | this document |
| error `type` | 128 bytes | this document |
| error `details` | 8192 bytes | this document |
| token | 32 bytes base64url | SPEC.md section 7 |
| store call | 5 seconds, then 503 | this document |

## 9. Example: a conforming function in shell

A `curlimages/curl` image is enough; the Phase 4 e2e uses exactly this
shape (PLAN.md).

```sh
#!/bin/sh
set -eu
C="curl -sS --fail-with-body --max-time 10 --retry 3 --retry-connrefused -H \"Authorization: Bearer $KRUN_TOKEN\""
S="curl -sS --fail-with-body --max-time 3 -H \"Authorization: Bearer $KRUN_TOKEN\""
BASE="$KRUN_GATEWAY_URL/internal/v1/runs/$KRUN_RUN_ID"

# fetch input
eval $C "$BASE/input" -o /tmp/input.json

# heartbeat, only when the Function sets heartbeatTimeout
echo '{ "message": "started" }' > /tmp/status.json
if [ -n "${KRUN_HEARTBEAT_TIMEOUT:-}" ]; then
  ( while sleep $((KRUN_HEARTBEAT_TIMEOUT / 3)); do
      eval $S -X POST "$BASE/status" -H '"Content-Type: application/json"' --data-binary @/tmp/status.json || true
    done ) &
  HB=$!
  trap 'kill $HB 2>/dev/null' EXIT
fi

# work, with an optional progress report (a dropped 429 must not fail the run)
echo '{ "message": "halfway", "progress": 0.5 }' > /tmp/status.json
eval $S -X POST "$BASE/status" -H '"Content-Type: application/json"' --data-binary @/tmp/status.json || true
echo '{ "rows": 42 }' > /tmp/result.json

# inline result, or the presigned upload when too large, or an error
if [ "$(wc -c < /tmp/result.json)" -le "$KRUN_MAX_RESULT_BYTES" ]; then
  eval $C -X PUT "$BASE/result" -H '"Content-Type: application/json"' --data-binary @/tmp/result.json
elif [ -n "${KRUN_RESULT_UPLOAD_URL:-}" ]; then
  curl -sS --fail-with-body --max-time 300 --retry 3 --retry-connrefused -X PUT "$KRUN_RESULT_UPLOAD_URL" \
    -H "Content-Type: application/json" --data-binary @/tmp/result.json
else
  eval $C -X PUT "$BASE/error" -H '"Content-Type: application/json"' \
    -d '"{ \"type\": \"ResultWriteError\", \"message\": \"result above the cap and no upload URL\" }"'
  exit 1
fi
```

`set -e` with `--fail-with-body` makes a rejected result or error call end
the script non-zero, so a lost result never looks like success; the
rejection envelope lands in `logTail`.

## 10. Notes and deviations

1. No TLS on the internal listener in v1. The token travels in clear on
   the cluster network between the jobs namespace and the gateway pods;
   the NetworkPolicy limits who can be on that path. A service mesh with
   mTLS can wrap it without changes to this contract.
2. No run-context endpoint. The environment carries the bootstrap
   (section 1); a function that needs its deadline computes nothing, the
   scheduler enforces it.
3. Not resource-oriented in the public API's sense: one run, three
   singletons and an append action. Custom-method naming (`:report`)
   was rejected because the sub-resource shape reads better from a shell.
4. The status rate limit is per gateway replica, so N replicas admit up
   to N reports per second; the last accepted one wins.
