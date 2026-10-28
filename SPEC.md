# krun specification

Status: v1 draft, 2026-10-23. This file is the source of truth for behavior.
PLAN.md holds the build order. Change this file only together with the
matching row in section 15 (Decisions), which holds decisions in force.

## 1. Purpose

krun runs HTTP-triggered functions as one-off Kubernetes Jobs. A client
sends an HTTP request that names a registered function and carries a JSON
input. krun validates the input,
persists the request, creates a Kubernetes Job, tracks the Job to completion,
stores the result, and exposes status and result over HTTP.

Target workload: functions that run from about 10 seconds to several hours,
submitted at up to a few runs per second sustained. Bursts are absorbed by
the queue.

Non-goals: workflows or DAGs, sub-second functions, cron scheduling (use
CronJob), web UI, multi-cluster, per-tenant namespaces, Kueue integration,
pool executor, automatic retries, log archiving, OIDC tokens, API key
management endpoints, table partitioning, failing fast on pods stuck before
start, a local gateway emulator, SDKs beyond Node.js and Python. Anything
not in this file is out of scope until a Decisions row adds it.

## 2. Architecture

```
 actor ──HTTP /v1 (:8080)──> krun-gateway ──SQL──> database <──SQL── krun-scheduler ──kube API──> Jobs
                               ^    ^                                      │                       (jobs namespace)
                               │    └──────────── pg_notify ───────────────┘                           │
                               │                                                                       │
                               └──── HTTP /internal/v1 (:8081), per-run token: input, status, result ──┘
 admin listener (:9090) on both: /healthz /readyz /metrics, probes and Prometheus only
 Function custom resources (functions.krun.io): informer in gateway and scheduler
 object storage (optional): results larger than KRUN_MAX_RESULT_BYTES via presigned PUT
```

Components:

| Component | Role | Replicas | Kubernetes RBAC | DB role |
|---|---|---|---|---|
| krun-gateway | public API `/v1`: auth, validation, idempotency, insert run, read status, wait, SSE, result, cancel request. Internal API `/internal/v1` on a second port: job pods fetch input, report status, write result and error | N, stateless | `functions.krun.io` read in the krun namespace | insert, select and update runs; insert run_events and deliveries |
| krun-scheduler | claim queued runs, create Jobs, watch Jobs and pods, state transitions, failure detection, heartbeat timeouts, cancel, webhook deliveries, retention sweep | 1 active, standby allowed, leader election via Kubernetes Lease | Roles in the jobs namespace and the krun namespace | update runs; insert run_events and deliveries |
| database | system of record for runs | managed Postgres, or SQLite in embedded mode | | |
| functions | `Function` custom resources in the krun namespace | informer in both | | |
| object storage | S3-compatible, optional | | | |
| jobs namespace | dedicated, hardened, holds Job pods and per-run Secrets | | | |

Contract between gateway and scheduler: the database only. No RPC between
them. When the scheduler is down, the gateway still accepts runs and they
queue. Cancel is a run state that the scheduler acts on.

One container image, four entrypoints: `krun gateway`, `krun scheduler`,
`krun migrate`, `krun validate`. The gateway serves three listeners: the
public API (`KRUN_LISTEN_ADDR`), the internal API
(`KRUN_INTERNAL_LISTEN_ADDR`) and the admin listener
(`KRUN_ADMIN_LISTEN_ADDR`) for probes and metrics. The scheduler serves only
the admin listener. Admin container ports are named `admin` on the gateway
and `admin-sched` on the scheduler.

Job pods never hold database or krun API-key credentials. Each pod gets a
per-run token from a per-run Secret and talks only to the gateway's
internal API: it fetches its input, reports runtime status, writes its
result or its error. Results larger than `KRUN_MAX_RESULT_BYTES` go to
object storage through a presigned URL.

Function images are built from the `krun init` template with the Node.js or
Python SDK (sections 7.1, 7.2). The contract stays plain HTTP, so any
language works without them.

## 3. Functions

A function definition is a custom resource `Function`, API group `krun.io`,
version `v1alpha1`, namespaced, in the krun namespace. Short name `kfn`.
Printer columns READY, IMAGE, AGE. There is no registry ConfigMap.
`kubectl get functions` is ambiguous on clusters that also run OpenFaaS or
Fission; use `functions.krun.io` or `kfn` there.

```yaml
apiVersion: krun.io/v1alpha1
kind: Function
metadata:
  name: report-generator                   # DNS-1123 label, unique per namespace
spec:
  image: ghcr.io/acme/report@sha256:...    # digest required, tags rejected
  inputSchema:                             # JSON Schema draft 2020-12, at most 64 KiB serialized
    type: object
    required: [from, to]
    properties:
      from: { type: string, format: date }
      to:   { type: string, format: date }
  serviceAccountName: krun-job-default     # optional, default shown; must be in KRUN_ALLOWED_SERVICE_ACCOUNTS
  runAsUser: 65532                         # optional, integer >= 1, CRD default 65532
  runAsGroup: 65532                        # optional, integer >= 1, CRD default 65532
  resources:                               # optional: cpu, memory, ephemeral-storage; LimitRange applies defaults and caps
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: "1",  memory: 512Mi }
  env:                                     # optional, plain values only
    - { name: REPORT_FORMAT, value: pdf }
  secretRefs: [report-secrets]             # optional, envFrom existing Secrets; names matching krun-* rejected
  activeDeadlineSeconds: 3600              # default 3600, max KRUN_MAX_ACTIVE_DEADLINE
  maxConcurrency: 10                       # default 10
  maxQueued: 1000                          # default 1000, max KRUN_MAX_QUEUED
  queueTimeout: 1h                         # default 1h
  heartbeatTimeout: 5m                     # optional; when set, the function must POST status at least this often once running
  nodeSelector: {}                         # optional
  imagePullSecrets: []                     # optional list of {name: existing-secret} references
  callback:                                # optional default webhook
    url: https://hooks.acme.com/krun
status:                                    # written by the scheduler leader only
  observedGeneration: 3
  conditions:
    - { type: Ready, status: "True", reason: Valid, message: "" }
```

Durations everywhere (Function fields, environment variables, `?wait`)
match `^\d+(ms|s|m|h)$`; the CRD carries that pattern.

Function create input requires `apiVersion: krun.io/v1alpha1`,
`kind: Function`, metadata with a DNS-1123 label `name`, and `spec`.
Standard Kubernetes metadata remains allowed; server-generated fields are
not required. Only `spec.image` and `spec.inputSchema` are required spec
inputs; an omitted input schema is not defaulted. Fields marked optional
or assigned defaults above are optional on input. Parsing and generated
schemas apply the documented defaults. `activeDeadlineSeconds` and
`maxConcurrency` are integers at least 1; `maxQueued` is an integer at least
0 (zero disables queued backlog, not running capacity). Installation
ceilings remain runtime validation, not fixed CRD limits.

`queueTimeout` must represent at least 1 ms and `heartbeatTimeout`, when
present, at least 30 seconds. Leading zeros and equivalent units are
accepted. Duration milliseconds must be a safe integer, consistently with
the shared configuration parser; overflow is rejected without changing
wire strings. The canonical grammar and the per-unit bounded numeric
patterns are shared by Zod, editor JSON Schema and the CRD, avoiding CEL
integer-conversion overflow.

`callback.url` is a raw absolute ASCII URI: its scheme-specific component
is nonempty; when `//` introduces an authority, its host is nonempty (an
RFC 3986 registered name or bracketed IP literal). Path, query and fragment
use RFC 3986 characters and complete percent escapes. Spaces, controls,
backslashes and malformed escapes are rejected, not trimmed, repaired or
normalized. Scheme/host case and escape spelling remain byte-preserved.
This is wire syntax only, not a transport-scheme, host, DNS or address
allowlist; the runtime webhook checks below remain separate. Ordinary HTTP
and HTTPS examples retain their meaning. One RE2-compatible pattern from
the canonical Zod source is emitted alongside `format: uri` for both CRD
and editor validation.

`inputSchema` remains opaque object data at this boundary, including own
JSON keys such as `__proto__` and `constructor`. Parsing validates object
presence/type without rebuilding or mutating that dictionary; it neither
applies user-schema defaults nor drops unknown keywords. The generator
maps only this explicitly identified Zod custom object boundary to its
object JSON Schema; all other unrepresentable schemas still fail closed.
User-schema compilation and rejection of invalid keywords remain layer two.

`status`, `observedGeneration` and `conditions` are optional;
`observedGeneration`, when present, is a nonnegative integer. A supplied
condition requires `type: Ready`, status `True`, `False` or `Unknown`, and
one of the reasons listed below. Its optional `message` defaults to the
empty string. There is at most one Ready condition, represented as a
Kubernetes map-list keyed by `type`. Missing status never synthesizes a
ready condition, and schema validation grants no status-write authority.

Schema: `packages/shared/src/functions/schema.ts` defines `spec` as a Zod
schema. It is the single source for the CRD `openAPIV3Schema` (generated by
`scripts/gen-crd.ts` as the plain manifest `deploy/crds/functions.krun.io.yaml`
and, derived from it, the chart template
`deploy/helm/krun/templates/crd-functions.yaml` wrapped in the `crds.install`
condition with the `crds.keep` annotation), the TypeScript type, and
`docs/schemas/function-v1alpha1.json` for editors. `krun validate` imports
the schema; it never reads these files. `make generate`
regenerates them; CI fails on a diff.

Validation, two layers:

- At apply, by the API server from the CRD: required fields, types, enums,
  minimums, the duration pattern, and a CEL rule that rejects an `image`
  without `@sha256:`.
- In the processes, on every informer event, by one shared pure function:
  `inputSchema` compiles with `new Ajv2020({ strict: true })` plus
  ajv-formats, synchronous `compile` only, any `$ref` not starting with `#`
  rejected, serialized size at most 64 KiB; `activeDeadlineSeconds` within
  `KRUN_MAX_ACTIVE_DEADLINE`; `maxQueued` within `KRUN_MAX_QUEUED`;
  `maxConcurrency` at least 1; `queueTimeout` and `heartbeatTimeout` parse,
  `heartbeatTimeout` at least 30 seconds; image prefix within
  `KRUN_ALLOWED_REGISTRIES`; `serviceAccountName` within
  `KRUN_ALLOWED_SERVICE_ACCOUNTS`; no `secretRefs` entry matching `krun-*`;
  `callback.url` host within `KRUN_WEBHOOK_ALLOWED_HOSTS`.

Reading: the gateway and the scheduler each run an informer on Functions
in `KRUN_NAMESPACE` and keep an in-memory map with the compiled validator
cached per `metadata.uid` and `metadata.generation`; resyncs and status
patches do not recompile. A Function that fails the second layer is not
served: `POST /v1/functions/{function}/runs` returns 404
`FUNCTION_NOT_FOUND` with the generic message, indistinguishable from a
missing or out-of-glob function (the reason is visible only on the
Function's `Ready` condition), and the scheduler claims nothing for it. Only the scheduler
leader writes status: condition `Ready` with reason `Valid`,
`SchemaInvalid`, `SchemaTooLarge`, `DeadlineAboveCeiling`,
`QueuedAboveCeiling`, `RegistryNotAllowed`, `ServiceAccountNotAllowed`,
`SecretRefNotAllowed`, `CallbackNotAllowed` or `InvalidDuration`, patched
only when `observedGeneration` or the condition changes. Readiness of both
processes waits for the informer's initial list; a failed initial list (404
while the CRD is not yet Established) is retried with backoff and readiness
stays 503 meanwhile. The informer's error handler restarts the watch with
backoff. A change reaches both processes within about one second of apply.

Gateway uses `name`, `inputSchema`, `maxQueued` and `callback` (the default
is copied into the run at create when the request carries none). Scheduler
uses everything else.

`krun validate <path>...` runs the CRD schema and the second layer over
Function documents in files or directories, prints one line per function,
exits 1 on any error. For CI in function repositories. It builds the
second-layer ceilings from `KRUN_MAX_ACTIVE_DEADLINE`, `KRUN_MAX_QUEUED`,
`KRUN_ALLOWED_REGISTRIES`, `KRUN_ALLOWED_SERVICE_ACCOUNTS` and
`KRUN_WEBHOOK_ALLOWED_HOSTS` with the section 12 defaults and prints the
values used on stderr; `krun deploy` runs it the same way.

## 4. HTTP API

Three listeners per gateway pod: public `/v1` on `KRUN_LISTEN_ADDR`,
internal `/internal/v1` on `KRUN_INTERNAL_LISTEN_ADDR`, admin on
`KRUN_ADMIN_LISTEN_ADDR`. The scheduler serves only the admin listener.
Each listener answers 404 for the other listeners' paths.

Admin listener, no authentication, never exposed outside the cluster:

| Method and path | Notes |
|---|---|
| `GET /healthz` | process alive, liveness probe |
| `GET /readyz` | database reachable and Function informer synced; 503 during shutdown; readiness probe |
| `GET /metrics` | Prometheus |

### Public API

docs/API.md is the normative contract: resource-oriented per the Google
AIPs, resource names `functions/{function}` and
`functions/{function}/runs/{run}`, `-` as the function wildcard, standard
methods, custom methods, AIP-193 errors, AIP-158 pagination, an AIP-160
filter subset, BASIC and FULL views. This section lists what the rest of
SPEC.md depends on.

| Method | HTTP | Scope |
|---|---|---|
| `ListFunctions` | `GET /v1/functions` | `functions:read` |
| `GetFunction` | `GET /v1/functions/{function}` | `functions:read` |
| `CreateRun` | `POST /v1/functions/{function}/runs?requestId=&wait=` | `runs:write` |
| `GetRun` | `GET /v1/functions/{function}/runs/{run}` | `runs:read` |
| `ListRuns` | `GET /v1/functions/{function}/runs?pageSize=&pageToken=&filter=` | `runs:read` |
| `WaitRun` | `POST /v1/functions/{function}/runs/{run}:wait` | `runs:read` |
| `CancelRun` | `POST /v1/functions/{function}/runs/{run}:cancel` | `runs:write` |
| `GetRunResult` | `GET /v1/functions/{function}/runs/{run}:getResult` | `runs:read` |
| `WatchRun` | `GET /v1/functions/{function}/runs/{run}:watch` | `runs:read` |

Rules the implementation must honour, all detailed in docs/API.md:

- Authentication `Authorization: Bearer <key>`; scopes `functions:read`,
  `runs:read`, `runs:write`, `runs:priority`, `admin`. A key sees only the
  functions matching its globs and the runs it created, others are
  `NOT_FOUND`; `admin` sees everything.
- Errors are AIP-193 envelopes: `{ error: { code, message, status,
  details: [ErrorInfo, ...] } }`; `ErrorInfo.reason` is the stable
  identifier (`INPUT_SCHEMA_VIOLATION`, `QUEUE_FULL`, `RUN_TERMINAL`, and
  the rest of the docs/API.md table). Every error, including framework
  ones (unknown route 404 `ROUTE_NOT_FOUND`, wrong content type 415,
  malformed JSON 400), uses the envelope through `setNotFoundHandler` and
  `setErrorHandler`; unknown failures are 500 `INTERNAL`.
- `CreateRun` returns 201 with the FULL `Run` and `Location`; `requestId`
  is the idempotency key: the fingerprint is the SHA-256 of the RFC 8785
  serialisation of `{ input, priority, callback }` as received (stored in
  `request_hash`), looked up after auth, rate limit, function resolution
  and parsing but before schema, callback and `maxQueued` checks; an equal
  fingerprint returns the run's current state with 201 and
  `Idempotent-Replay: true`, honouring `wait`; a different fingerprint is
  `ABORTED`. `wait` delays the response up to `KRUN_MAX_WAIT` and the
  status stays 201; the server may answer earlier at shutdown.
- `priority` is 0 to 9; above 0 needs `runs:priority`. The function's
  default `callback` is copied into the run when the request has none.
- `ListRuns` is ordered `createTime desc` then the run id `desc`, with
  opaque page tokens that bind the parent and the `filter` (a mismatch or
  a malformed token is `REQUEST_INVALID`); `filter` supports `state`,
  `failureReason` and `createTime` with `AND`; `pageSize` above 200 is
  coerced, negative is `REQUEST_INVALID`.
- Views: BASIC omits `input`, `result`, `logTail` and `error.details`;
  it is the list item (always; `ListRuns` has no `view`), the `WatchRun`
  event payload and the webhook payload (`RunSummary` in section 6). FULL
  is the single-run form; `GetRun` accepts `view=BASIC`.
- Presence: unset fields are omitted, never `null`; `null` on input is
  rejected; Zod schemas use `.optional()`, never `.nullable()`.
  Response enums are open (typed `string` in OpenAPI with known values in
  `description`); `jobStatus.phase`, `jobStatus.reason` and `error.type`
  are strings carried verbatim from their origin.
- `GetFunction` exposes `callback`, `queueTimeout`, `maxInputBytes`,
  `maxResultBytes` and `maxWait` beside the limits, so clients can read
  the installation's bounds.
- `WatchRun` streams SSE: one `state` event with the current BASIC run on
  connect (terminal: that event, then close), then one event per changed
  field group with `id` set to the field's own time; `Last-Event-ID`
  ignored; keepalive comments every 15 seconds; a stream ending without a
  terminal event is not an error, the client reconnects and gets the
  snapshot again.
- Enums are UPPER_SNAKE in the API and lowercase in the database;
  timestamps are `createTime`, `scheduleTime`, `startTime`, `endTime`
  (columns `created_at`, `scheduled_at`, `started_at`, `finished_at`);
  `result_ref` is `resultUri`; `runtimeStatus.reportTime` and
  `jobStatus.observeTime` are the JSON `at` and `observedAt` fields.
  `toRun(row)` and `toRunSummary(row)` in `packages/shared/src/store` are
  the only row-to-wire mappers (section 6).
- Rate limiting: token bucket per API key, `KRUN_RATE_LIMIT_RPS` and
  `KRUN_RATE_LIMIT_BURST`, per gateway replica; `RESOURCE_EXHAUSTED` with
  `Retry-After: 1`, as is `QUEUE_FULL`.
- `CancelRun` on `CANCELLING` or `CANCELLED` is 200 without a transition;
  on `SUCCEEDED` or `FAILED` it is `FAILED_PRECONDITION` `RUN_TERMINAL`.
  Once `cancelling`, the only terminal state is `cancelled`: the
  compare-and-set rejects a later completion event, so a cancelled run may
  still carry a result the function wrote.
- Body size limits are enforced from `Content-Length` and the stream
  before parsing; unknown fields and query parameters are rejected.
- `X-Request-Id`: accepted up to 128 characters, else replaced by a UUID;
  echoed on every response; `reqId` on every request-scoped log line.
- The OpenAPI 3.1 document generated from the routes
  (`docs/api/openapi-public.json`) must match docs/API.md.

Run fields and their meaning: `failureReason` is set with `FAILED` and is
one of `EXIT_CODE`, `OOM_KILLED`, `DEADLINE_EXCEEDED`, `EVICTED`,
`DISRUPTED`, `HEARTBEAT_TIMEOUT`, `JOB_CREATE_FAILED`, `JOB_LOST`,
`QUEUE_TIMEOUT`. `error` is `{ source, message, type, details }` with
`source` `FUNCTION` (reported through the internal API), `KUBERNETES` (pod
or Job reason and message) or `KRUN` (`HEARTBEAT_TIMEOUT`,
`JOB_CREATE_FAILED`, `JOB_LOST`, `QUEUE_TIMEOUT`). `logTail` holds the last
100 log lines, 16 KB cap, on failure when the container ran. `jobStatus`
is the scheduler's view of the Job and its pod, derived from Kubernetes
alone (section 8), set from `SCHEDULED` on and kept after the terminal
state. `runtimeStatus` is optional and informational: a function that
never calls the internal API is tracked exactly the same way. Clients
branch on `state` and `failureReason`, never on `error.message`.

Wait semantics: on `CreateRun` the gateway subscribes to the run id before
inserting the row so no event is missed. Client disconnect never cancels a
run.

### Internal API

docs/INTERNAL-API.md is the normative contract. Served only on
`KRUN_INTERNAL_LISTEN_ADDR`, authenticated with the per-run
token (`Authorization: Bearer <token>`). API keys are rejected here. The
token is valid only for the run in the path and only while the run is
`queued` with a token set, `scheduled` or `running`; anything else is 401.
The version segment is independent of `/v1`; SDK major N speaks
`/internal/vN`. An unknown version answers 404 with reason
`UNSUPPORTED_API_VERSION`. The gateway logs the `User-Agent` of internal
requests and never gates on it. Errors use the same AIP-193 envelope.
Check order and the 5 second store-call bound (503 `NOT_READY` on expiry)
are in docs/INTERNAL-API.md section 3.

| Method and path | Notes |
|---|---|
| `GET /internal/v1/runs/{id}/input` | 200 with a JSON document equal to the submitted input, re-serialised (key order, whitespace, number spelling not preserved), with `Content-Length` |
| `POST /internal/v1/runs/{id}/status` | body `{ "message": "...", "progress": 0.4, "data": {} }`; `message` up to 1 KB, `data` up to 4 KB, `progress` 0 to 1 optional; body cap 16384 bytes (413 `REQUEST_TOO_LARGE`); at most 1 accepted report per second per run per gateway replica, the window starting at the last 204, 429 `STATUS_RATE_LIMITED` beyond; stored as `runtime_status` `{ message, progress, data, at }`, replaced wholesale (a plain-HTTP heartbeat re-sends the full last status), `at` set by the gateway at receipt and never from the body, rendered as `runtimeStatus.reportTime`; publishes a notify, never written to `run_events`; 204 |
| `PUT /internal/v1/runs/{id}/result` | any JSON value except `null`, up to `KRUN_MAX_RESULT_BYTES`, 413 `RESULT_TOO_LARGE` beyond (body unread, connection closed); replaces `result`; 204 |
| `PUT /internal/v1/runs/{id}/error` | body `{ "message": "...", "type": "...", "details": {} }`; `message` up to 4 KB, `type` up to 128 bytes, `details` up to 8 KB, body cap 32768 bytes (413 `REQUEST_TOO_LARGE`); stored as `error` with `source: FUNCTION`, never overwritten by a later Kubernetes or krun error (`transition` writes `error = coalesce(error, patch.error)`); never changes the state, the exit code does; 204 |

## 5. Run lifecycle

States: `queued`, `scheduled`, `running`, `succeeded`, `failed`,
`cancelling`, `cancelled`. Terminal: `succeeded`, `failed`, `cancelled`.

| From | To | Who | Trigger |
|---|---|---|---|
| (none) | queued | gateway | POST accepted |
| queued | scheduled | scheduler | Job created |
| queued | failed | scheduler | permanent API error creating the Secret or Job (`job_create_failed`) |
| scheduled | running | scheduler | pod phase `Running` |
| scheduled | succeeded | scheduler | Job condition `Complete` observed without a `running` phase |
| running | succeeded | scheduler | Job condition `Complete` |
| scheduled, running | failed | scheduler | Job condition `Failed`, or Job missing after grace (`job_lost`) |
| running | failed | scheduler | no runtime status for `heartbeatTimeout` (`heartbeat_timeout`), Job deleted first |
| queued | failed | scheduler | queued longer than `queueTimeout` (`queue_timeout`); a deleted Function or an invalid duration uses the 1h default |
| queued, scheduled, running | cancelling | gateway | `CancelRun` (`POST .../runs/{run}:cancel`) |
| cancelling | cancelled | scheduler | Job deleted or absent |

Rules:

- Every transition is a compare-and-set: `update runs set state = $to ...
  where id = $id and state = $from`. Zero rows affected means a stale event.
  Ignore it and log at debug.
- Every successful transition appends a `run_events` row and publishes
  `pg_notify('krun_runs', '<id>:<state>')` in Postgres mode.
  `setRuntimeStatus` publishes `<id>:status`, `setJobStatus` publishes
  `<id>:job_status`.
- A transition to a terminal state, including `expireQueued` and the
  heartbeat and job-create failures, inserts the `deliveries` row in the
  same transaction when `callback_url` is set, payload the `RunSummary` of
  the updated row.
- `run_events` holds state transitions and `jobStatus` changes; a
  `jobStatus` row carries `from_state` equal to `to_state`, reason
  `job_status` and the new `jobStatus` as payload. Runtime status updates
  are not stored there, only the latest value on the run. Rows written by
  the gateway (`queued`, `cancelling`) carry `payload.actor` = key name.
- `createTime`, `scheduleTime`, `startTime` and `endTime` are set by
  `createRun`, `markScheduled`, the transition to `running` and the
  terminal transition; each equals the `at` of its `run_events` row. A
  terminal transition that skipped `running` sets `startTime` from the
  `function` container's `terminated.startedAt`, else the Job's
  `status.startTime`.
- States and reasons are lowercase in the database and in this document;
  the API renders them UPPER_SNAKE (docs/API.md section 10).
- `attempt` counts scheduler claims. There are no automatic retries in v1:
  Jobs run with `backoffLimit: 0`. A client retries by submitting a new run.
- On failure `error` is the function's own report when it called the error
  endpoint, otherwise the Kubernetes reason and message (for example
  `ImagePullBackOff` or `Unschedulable`), otherwise krun's reason. The
  precedence is enforced in the store: `transition` writes
  `error = coalesce(error, patch.error)`, so a report accepted before the
  terminal statement survives every path (informer, heartbeat, deadline,
  `job_lost`); `failureReason` still says why krun ended the run.
  `logTail` holds the last 100 log lines of the pod, capped at 16 KB, when
  the container ran. A function that reports an error and exits 0 still
  succeeds: the exit code is the truth.
- `state` and `jobStatus` never depend on the function calling the internal
  API.
- Every `failed` run carries `failureReason` (section 4), in the run row
  and as the `run_events` reason. Precedence when several apply:
  `oom_killed`, `deadline_exceeded`, `evicted`, `disrupted`, `exit_code`.

## 6. Data model

One schema, two dialects. Table and column names are identical. Migrations
live in `packages/shared/src/store/migrations/postgres` and
`packages/shared/src/store/migrations/sqlite`, run by the Kysely `Migrator`.
Migration policy is in section 13.

| Concept | Postgres | SQLite |
|---|---|---|
| `id` | `uuid` | `text` |
| JSON columns | `jsonb`, except opaque Run.input uses lossless `json` (D64) | `text`, read with JSON1 |
| timestamps | `timestamptz` | `text`, RFC 3339 UTC with milliseconds |
| `state` | `text` + `check` | `text` + `check` |
| partial indexes | yes | yes |
| `returning` | yes | yes (3.35+) |

The application generates all timestamps and ids. No database defaults for
time. Run ids are UUIDv7 so creation order and id order agree.

```sql
create table runs (
  id               uuid primary key,
  idempotency_key  text,
  idempotency_key_nul bytea, -- Postgres-only reversible identifier storage; D64
  request_hash     text not null,
  function_name    text not null,
  input            json not null, -- D64 preserves valid escaped Unicode NUL
  state            text not null
                   check (state in ('queued','scheduled','running',
                                    'succeeded','failed','cancelling','cancelled')),
  priority         int  not null default 0,
  attempt          int  not null default 0,
  lease_owner      text,
  lease_until      timestamptz,
  job_name         text,
  job_token_hash   text,
  result           jsonb,
  result_ref       text,
  error            jsonb,
  log_tail         text,
  failure_reason   text,
  runtime_status   jsonb,
  job_status       jsonb,
  callback_url     text,
  created_by       text not null,
  created_at       timestamptz not null,
  scheduled_at     timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz
);

create unique index runs_idem_idx on runs (created_by, function_name, idempotency_key)
  where idempotency_key is not null;
create index runs_queue_idx    on runs (function_name, priority desc, created_at) where state = 'queued';
create index runs_active_idx   on runs (function_name, state) where state in ('queued','scheduled','running','cancelling');
create index runs_function_idx on runs (function_name, created_at desc, id desc);
create index runs_owner_idx    on runs (created_by, created_at desc, id desc);
create index runs_created_idx  on runs (created_at desc, id desc);
create index runs_finished_idx on runs (finished_at) where finished_at is not null;

create table run_events (
  run_id     uuid not null references runs(id) on delete cascade,
  at         timestamptz not null,
  from_state text,
  to_state   text not null,
  reason     text,
  payload    jsonb
);
create index run_events_run_idx on run_events (run_id, at);

create table deliveries (
  id          uuid primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  url         text not null,
  payload     jsonb not null,
  attempt     int  not null default 0,
  next_at     timestamptz not null,
  state       text not null check (state in ('pending','delivered','dead')),
  last_error  text,
  created_at  timestamptz not null
);
create index deliveries_due_idx on deliveries (next_at) where state = 'pending';
create index deliveries_run_idx on deliveries (run_id);
```

No table partitioning in v1. Retention is a batched delete on
`runs_finished_idx`.

Claim query, Postgres:

```sql
update runs
set    lease_owner = $1, lease_until = $2, attempt = attempt + 1
where  id in (
  select id from runs
  where  state = 'queued' and function_name = $3
    and (lease_until is null or lease_until < $4)
  order  by priority desc, created_at
  for update skip locked
  limit  $5)
returning *;
```

SQLite: same statement without `for update skip locked`, inside
`begin immediate`. The claim takes a lease only. State changes after the Job
exists. An expired lease makes the row claimable again.

Store interface (module `packages/shared/src/store`), implemented for both
dialects and verified by one shared contract test suite:

```ts
interface Store {
  createRun(run: NewRun): Promise<{ run: Run; created: boolean }>;        // dedupe on idempotency key; when created, appends the queued run_events row (payload.actor = created_by) and notifies
  getRun(id: string): Promise<Run>;                                        // throws NotFoundError
  findRunByRequestId(fn: string, createdBy: string, requestId: string): Promise<Run | undefined>; // FULL current row; P3.3 pre-admission replay, bound unique-key lookup
  listRuns(filter: RunFilter, cursor: string | null, limit: number):
    Promise<{ runs: RunSummary[]; next: string | null }>;                 // selects every column except input, result, log_tail; toRunSummary
  listByState(states: State[], limit: number): Promise<Run[]>;             // non-terminal; the runs_active_idx predicate plus state in (<requested>)
  countByState(): Promise<Map<string, Map<State, number>>>;                // non-terminal runs per function and state; the runs_active_idx predicate
  countQueued(fn: string): Promise<number>;                                // queued per function, for maxQueued
  countQueuedBy(fn: string, createdBy: string): Promise<number>;           // queued per function and key, for the key's maxQueued
  claimQueued(fn: string, owner: string, leaseUntil: Date, limit: number): Promise<Run[]>;
  releaseLease(id: string): Promise<void>;
  setJobToken(id: string, jobName: string, tokenHash: string): Promise<void>; // before the Job exists; idempotent
  markScheduled(id: string): Promise<boolean>;                             // queued -> scheduled, clears lease, sets scheduled_at, appends a run_events row, notifies; false on stale state
  transition(id: string, from: State, to: State, reason: string | null, patch: Partial<Run>,
    event?: { actor: string }): Promise<boolean>;                        // event, when given, is the run_events payload; error written as coalesce(error, patch.error)                                                      // compare-and-set; sets started_at when to = running, finished_at when terminal; appends run_events; inserts the delivery when terminal and callback_url set
  setRuntimeStatus(id: string, status: RuntimeStatus): Promise<boolean>;  // queued with token, scheduled or running; publishes notify, no run_events row
  setResult(id: string, result: unknown): Promise<boolean>;                // queued with token, scheduled or running
  setError(id: string, error: RunError): Promise<boolean>;                 // queued with token, scheduled or running; source function
  setJobStatus(id: string, status: JobStatus): Promise<boolean>;           // scheduled, running or cancelling; writes and appends run_events only when a field other than observedAt changed
  expireQueued(fn: string, olderThan: Date): Promise<Run[]>;               // queued -> failed queue_timeout; sets finished_at; one run_events row, notify and delivery each
  listStale(fn: string, before: Date): Promise<Run[]>;                     // running runs whose later of runtime_status.at and started_at is < before
  subscribe(signal: AbortSignal): AsyncIterable<{ id: string; kind: "state" | "status" | "job_status" }>;
  claimDeliveries(now: Date, limit: number): Promise<Delivery[]>;         // sets next_at = now + 60s in the claim statement, ordered by next_at, skip locked
  updateDelivery(id: string, state: DeliveryState, attempt: number, nextAt: Date | null, lastError: string | null, expectedClaim?: { attempt: number; next_at: Date }): Promise<boolean>; // D105: guarded worker outcome returns applied/stale
  sweep(finishedBefore: Date, batch: number): Promise<number>;             // SQLite runs pragma incremental_vacuum after each batch
  migrate(): Promise<void>;
}
```

`listRuns` applies the cursor as the row-value comparison
`(created_at, id) < ($createdAt, $id)` in both dialects. `listStale` uses
`greatest((runtime_status->>'at')::timestamptz, started_at)` in Postgres
and `max(coalesce(json_extract(runtime_status,'$.at'), started_at),
started_at)` in SQLite, the `coalesce` because SQLite's scalar `max`
returns null on any null argument. `request_hash` is the lowercase hex SHA-256 of the RFC 8785 (JCS)
serialisation of `{ input, priority, callback }` as received, so key order
and whitespace do not matter. `toRun(row)` (FULL) and `toRunSummary(row)`
(BASIC: `toRun` minus `input`, `result`, `logTail`, `error.details`) in
`packages/shared/src/store` are the only row-to-wire mappers: resource
`name`, UPPER_SNAKE enums, RFC 3339 `*Time` fields, `resultUri`,
`runtimeStatus.reportTime`, `jobStatus.observeTime`; the delivery payload,
`listRuns`, SSE and the gateway all go through them. `countByState` and
`listByState` filter with the `runs_active_idx` predicate as literal text from one shared `sql` fragment, never bound parameters, so
both planners use the partial index. `RunSummary` and `toRunSummary(run)`,
which drops `input`, `result`, `logTail` and `error.details`, live in
`packages/shared/src/store` and are shared by `listRuns`, the delivery
payload in `transition`, SSE and the gateway.

Postgres `subscribe` uses `LISTEN krun_runs`. SQLite `subscribe` polls
`run_events where rowid > $last order by rowid` every 1 second, starting
from `max(rowid)` at subscribe time; rows with `from_state = to_state` emit
kind `job_status`, others `state`; runtime status reaches SSE clients there
through the handler's 1 second re-read. Both modes keep a 1 second poll
fallback in the wait and SSE handlers.

SQLite `run_events` additionally declares an internal `rowid INTEGER PRIMARY KEY
AUTOINCREMENT` alias. Its committed cursor allocation must not reuse deleted
rowids: retention may delete the highest event or empty the table while a
subscriber remains active. The existing strict `rowid > last` query, initial
history skip, one-second interval and no-replay behavior are unchanged. This
integer is storage-only, not a run identifier, timestamp or public field;
application-issued run ids and event timestamps remain unchanged. Forward
migration `0002_event_rowid` atomically rebuilds the SQLite event table,
preserving every existing rowid and all six shared columns, foreign-key cascade
and index. SQLite's internal `sqlite_sequence` maintains the allocator across
retention, incremental vacuum and connection restarts; application code does not
reset or update it. Previous code inserting the six shared columns continues to
work. Postgres schema and behavior are unchanged (D46).

Postgres pool: 5 connections per process, plus one dedicated client for
`LISTEN` outside the pool.

SQLite pragmas, set on every connection:

```
journal_mode = WAL
synchronous  = NORMAL
busy_timeout = 5000
foreign_keys = ON
auto_vacuum  = INCREMENTAL
```

One synchronous connection per process (Node's built-in `node:sqlite`
`Database`), no pool, no native addon. Kysely reaches it through an
in-house dialect adapter (`packages/shared/src/store/sqlite/dialect.ts`):
a `SqliteDialect`-compatible database object over `node:sqlite` prepared
statements, with transactions opened as `begin immediate`.

## 7. Job contract

Per claimed run the scheduler creates, in the jobs namespace:

1. Secret `krun-<run id>`, `immutable: true`, key `token` (32 random bytes,
   base64url; only its SHA-256 is stored in `runs.job_token_hash`, before
   the Job exists), labels `krun.io/run-id`, `krun.io/function`,
   `krun.io/created-by`, `app.kubernetes.io/managed-by: krun`. No owner
   reference. The scheduler deletes it on the terminal transition. A sweep
   deletes orphans older than 1 hour by label.
2. Job `krun-<run id>` (41 characters, within the 63 limit):

```yaml
metadata:
  labels: { krun.io/run-id: <id>, krun.io/function: <function>, krun.io/created-by: <key name>, app.kubernetes.io/managed-by: krun }
spec:
  backoffLimit: 0
  activeDeadlineSeconds: <function value>
  ttlSecondsAfterFinished: <KRUN_TTL_AFTER_FINISHED>
  template:
    metadata:
      labels: { krun.io/run-id: <id>, krun.io/function: <function>, krun.io/created-by: <key name>, app.kubernetes.io/managed-by: krun }
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 30
      hostUsers: <false when KRUN_JOB_HOST_USERS is false; omitted otherwise>
      serviceAccountName: <function value>
      automountServiceAccountToken: false
      imagePullSecrets: <function value>
      nodeSelector: <function value>
      tolerations:
        - { key: node.kubernetes.io/not-ready,   operator: Exists, effect: NoExecute, tolerationSeconds: 60 }
        - { key: node.kubernetes.io/unreachable, operator: Exists, effect: NoExecute, tolerationSeconds: 60 }
      securityContext:
        runAsNonRoot: true
        runAsUser: <function value, default 65532>
        runAsGroup: <function value, default 65532>
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: function
          image: <digest-pinned image>
          imagePullPolicy: IfNotPresent
          resources: <function value>
          env:
            - { name: HOME, value: /tmp }
            - { name: KRUN_RUN_ID, value: <id> }
            - { name: KRUN_FUNCTION, value: <function> }
            - { name: KRUN_GATEWAY_URL, value: <KRUN_GATEWAY_INTERNAL_URL> }
            - { name: KRUN_TOKEN, valueFrom: { secretKeyRef: { name: krun-<id>, key: token } } }
            - { name: KRUN_RESULT_UPLOAD_URL, value: <presigned PUT, only when object storage configured> }
            - { name: KRUN_MAX_RESULT_BYTES, value: <KRUN_MAX_RESULT_BYTES> }
            - { name: KRUN_HEARTBEAT_TIMEOUT, value: <seconds, only when the Function sets heartbeatTimeout> }
            - <function env>
          envFrom: [{ secretRef: { name: <each secretRef> } }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
```

Function container contract, every call with
`Authorization: Bearer $KRUN_TOKEN`:

- `GET $KRUN_GATEWAY_URL/internal/v1/runs/$KRUN_RUN_ID/input` to read the
  input: a JSON document equal to the submission, not its bytes.
- Optionally `POST .../status` with a progress message while running.
- On an application error: `PUT .../error` with `message`, `type` and
  `details`, then exit non-zero.
- `PUT .../result` with the JSON result, up to `KRUN_MAX_RESULT_BYTES`,
  before exit. Larger result: HTTP PUT the body to `KRUN_RESULT_UPLOAD_URL`
  instead. The URL expires with `activeDeadlineSeconds`.
- Exit code 0 means success. Any other code means failure.
- No krun library is needed inside the image, only an HTTP client.

On `Complete` the scheduler keeps whatever `result` the pod wrote. When
object storage is configured the object key is `runs/<id>/result.json` in
`KRUN_S3_BUCKET`; the scheduler presigns the PUT for that key and checks it
before the terminal compare-and-set, passing `result_ref` =
`s3://<bucket>/<key>` in the patch, so the delivery carries `resultUri`;
the check runs only when the Job completed and no inline `result` was
accepted, so a run never carries both and only `succeeded` runs carry
`result_ref`. The PUT is presigned at Job creation with only the host
signed (no `Content-Type`, no size condition; `requestChecksumCalculation:
WHEN_REQUIRED`) for `KRUN_S3_PRESIGN_TTL`, default the Function's
`activeDeadlineSeconds`. The gateway parses `result_ref` and presigns a GET
with a 300 second TTL.
krun never deletes objects; a bucket lifecycle rule of at least
`KRUN_RETENTION` does (docs/OPERATIONS.md). Both may be set. Neither set means `result` is null. The token stops
working at the terminal transition.

### 7.1 Function SDKs

Two SDKs implement docs/INTERNAL-API.md: `@krun/sdk` for Node.js 22 or
newer (`sdk/node`, npm; migration from the initial `packages/sdk-node` scaffold is scheduled at the start of PLAN P8.1) and `krun` for Python 3.11 or newer
(`sdk/python`, PyPI). Neither has runtime dependencies beyond the standard
library. Both are optional: the contract is plain HTTP.

One function shape in both languages:

```ts
import { run } from "@krun/sdk";
run(async (input, ctx) => {
  await ctx.status("loading", 0.1);
  return { rows: 42 };
});
```

```python
from krun import run

def handle(input, ctx):
    ctx.status("loading", 0.1)
    return {"rows": 42}

if __name__ == "__main__":
    run(handle)
```

`run` is a plain call that never returns, never a decorator, so a test can
import `handle` without executing it. It does, in order: read
`KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`, `KRUN_TOKEN`,
`KRUN_MAX_RESULT_BYTES`, `KRUN_HEARTBEAT_TIMEOUT` and
`KRUN_RESULT_UPLOAD_URL`; `GET input`; call the handler. Status: the SDK
keeps the latest status payload, initially `{ message: "started" }` (never
posted eagerly); one send gate posts it at most once per second, keeps it
pending after a 429, and drops it once the result or error call has
returned; each `ctx.status` call replaces the payload. When
`KRUN_HEARTBEAT_TIMEOUT` is set a timer re-posts the latest payload every
third of the window, from the start of `run` until the result or error
call has returned, from a timer that never keeps the process alive
(`setInterval(...).unref()` in Node, a daemon thread in Python; a
CPU-bound synchronous handler or a GIL-holding extension starves it).
Status calls are one attempt with a 3 second timeout, so `ctx.status`
blocks at most 3 seconds and never throws: any 4xx, a 429 or a timeout
is logged and dropped. On return: `undefined`, `null` or `None` sends no
result and exits 0; otherwise serialise the value as JSON and `PUT result`
when it fits `KRUN_MAX_RESULT_BYTES`, else upload it to
`KRUN_RESULT_UPLOAD_URL` per docs/INTERNAL-API.md section 4 (300 second
timeout, `Content-Length`, no checksum header); when the result write
fails after retries, log the cause, `PUT error` with type
`ResultWriteError` and exit 1; otherwise exit 0. On a thrown error or
exception: `PUT error` with the error type, the message and the first 20
stack lines as `details.stack`, then exit 1. Before sending, the SDK
truncates to the contract's limits, measured as the compact JSON
serialisation in UTF-8 bytes on character boundaries: status `message` 1
KB, `data` omitted and logged when over 4 KB; error `message` 4 KB, `type`
128 bytes, `details.stack` lines dropped from the end until `details` fits
8 KB. `GetInput`, `SetResult` and `SetError` use a 10 second timeout per
call (`AbortSignal.timeout` in Node, `timeout=` in `urllib`) and retry 3
times with backoff on connection errors, timeouts and 5xx; a 401 ends the
process with exit 1 (the run was cancelled or is over), as does SIGTERM.
`ctx` exposes `runId`, `function`, `status(message, progress?, data?)` and
`log`, which writes one JSON line to stdout in the pod so `logTail` stays
readable.

Local mode: when `KRUN_GATEWAY_URL` is unset, `run` reads the input from
the file named by the first argument, or stdin, prints only the result to
stdout (nothing for a void handler), writes `ctx.log` and `ctx.status` to
stderr, and exits with the same codes. No cluster, no gateway.

SDK major versions track the internal API version: SDK 1.x speaks
`/internal/v1`. Each SDK sends `User-Agent: krun-sdk-<lang>/<version>`.

### 7.2 `krun init` and `krun deploy`

`krun init --lang node|python [--name <function>] <dir>` (`--name`
defaults to the directory's name; a missing `--lang` prompts on a TTY and
fails with a usage message otherwise) scaffolds a
function project from `packages/cli/templates/<lang>`:

- handler file with the function above and tests: Node, one subprocess
  local-mode test; Python, a pytest that imports `handle` and calls it
  with a fake `ctx`, plus one subprocess local-mode test; the Python
  Dockerfile runs `CMD ["python", "handler.py"]`;
- `package.json` or `pyproject.toml` depending on the SDK, with the SDK
  dependency at the CLI's own version (caret range, compatible release);
  one workspace version per tag;
- `Dockerfile`: multi-stage, copies the whole project before installing
  dependencies so a packed SDK in `vendor/` builds unpublished
  (`.dockerignore` never excludes `vendor/`), numeric `USER 65532:65532`,
  works with a read-only root filesystem, distroless or slim base;
- `function.yaml`: a `Function` resource with `image: REPLACE_WITH_DIGEST`,
  a starter `inputSchema` and `heartbeatTimeout: 5m`;
- `README.md` with the loop: test locally, `krun deploy`, POST a run with
  curl; and the manual steps behind `krun deploy`.

`krun deploy [--no-apply] [--namespace <ns>] [--api-url <url>] [dir]` is
the golden path from code to a Ready function: build the image, push it,
read the digest, write `image: <repo>@sha256:...` into `function.yaml`,
`krun validate`, `kubectl apply -f function.yaml` in `--namespace` or
`KRUN_NAMESPACE` (default `krun`), wait for `Ready=True` (120 second cap),
print a curl for a first run against `--api-url` or `KRUN_API_URL` using
`$KRUN_API_KEY`, print `kubectl logs -f -n <jobs namespace> job/krun-<id>`,
which works only while the run is `scheduled` or `running`, and the
`GetRun` curl whose `logTail` holds the last lines of a failed run. `--no-apply` stops after
writing the digest, for repositories where GitOps applies `function.yaml`.
The registry comes from `--registry` or `KRUN_REGISTRY`. The CLI never
reads `KRUN_GATEWAY_URL`: that variable switches SDKs out of local mode.

Deploying a function is `kubectl apply -f function.yaml`, by hand, by
`krun deploy`, or by a GitOps tool applying the repository. There is no
Helm chart per function: the resource is plain YAML and valid inside any
chart or GitOps tree. The platform chart never renders functions.

`krun init`, `krun deploy` and `krun validate` ship as `@krun/cli` on npm
(`npx @krun/cli ...`). `validate` is also a subcommand of the server binary
for CI images.

## 8. Scheduler

Only the leader runs the loops. The Function informer starts at process
start on every replica (readiness depends on it). The Job and Pod
informers, the loops and the Function status writer start only after Lease
acquisition and stop on loss or SIGTERM. The heartbeat loop, the `job_lost`
check and the reconcile timer start only after both the Job and Pod
informers' initial list is processed.

Leader election uses a Kubernetes Lease named `krun-scheduler` in the krun
namespace: 15 second lease, 10 second renew deadline, 2 second retry.
`holderIdentity` is the pod name (downward API `metadata.name`). The
contract: acquire and renew by `get` then `update` with the read
`resourceVersion`; a 409 or a changed `holderIdentity` fails the attempt,
retry in 2 seconds. A candidate deems the Lease expired 15 seconds after it
last saw `holderIdentity` or `renewTime` change, measured on its own clock,
never by comparing `renewTime` with local time. A leader with no successful
renew for 10 seconds stops its loops and informers, cancels in-flight API
calls and exits non-zero; Kubernetes restarts it as a standby.

Kubernetes API usage: one scheduler-wide limiter caps concurrent API calls
at `KRUN_K8S_CONCURRENCY` (default 8); every call aborts at 10 seconds
through `Effect.timeout`, which fires the request's `AbortSignal`. A 429 in the main loop releases the leases
of claimed runs not yet scheduled, pauses the loop for `Retry-After`
(default 1 second, cap 60) and logs at warn. Every Secret or Job delete
treats 404 as success.

Main loop, every 1 second and on each notify of kind `state`; `status` and
`job_status` notifies are ignored by it. Iterations never overlap: a
`state` notify during an iteration marks exactly one more. Each iteration
carries a 10 second deadline checked between steps and between runs in
step 4; past it, the leases of unprocessed claimed runs are released and
the iteration ends.

1. Read `countByState`. For every function name with queued runs call
   `expireQueued(fn, now - queueTimeout)`, using the cached Function's
   `queueTimeout` when it is in the informer map (Ready or not) and parses,
   else the CRD default 1h. Each expired run gets its `run_events` row,
   notify and delivery; an expired run with `jobTokenHash` set also gets
   its Job (foreground) and Secret deleted, as after a false
   `markScheduled`.
2. Free slots per function are `maxConcurrency - (scheduled + running)`,
   and globally `KRUN_MAX_RUNNING - sum(scheduled + running)`. Publish
   `krun_runs_current` from the same `countByState` result.
3. For each Ready function with free slots, claim up to the smaller of the
   two, lease 30 seconds.
4. For each claimed run, in this order: create the Secret with a fresh
   token (`AlreadyExists`: read the existing token); `setJobToken` with the
   Job name and the token hash; create the Job (`AlreadyExists` counts as
   success); `markScheduled`; when it returns false, delete the Job with
   foreground propagation and the Secret; when it returns true, run the
   informer handler once on the cached Job and pod for that run (informer
   cache, no API call), so a `Complete` that arrived first is not missed.
   Errors from the API server are classified by status: 403 quota, 429,
   5xx and network errors are transient: release the lease, back off that
   function for `2^n` seconds capped at 60, count
   `krun_job_create_errors_total{function,code}`,
   `krun_quota_rejections_total` for quota. Any other 4xx (400, 403 RBAC,
   404, 422 admission) is permanent: delete the Secret if created,
   transition `queued` to `failed` with `job_create_failed` and `error`
   `{ source: krun, message: <API server Status message>, details: { code:
   <HTTP status>, reason: <Status reason> } }`.
5. For each run in `cancelling`: delete the Job with foreground propagation,
   delete the Secret, transition to `cancelled`.
6. Lost Jobs, active only after the Job informer's initial list: for each
   run from `listByState(['scheduled','running'], KRUN_MAX_RUNNING)` whose
   Job is absent from the informer cache, record the first-absent time in a
   leader-local map (reset on leader change); past the 2 minute grace,
   transition to `failed` with `job_lost` and a `krun`-sourced error
   unless the function reported one, keep any `result` already written,
   then delete the Secret; drop the entry
   when the Job reappears.

Job and Pod informers: label selector `krun.io/run-id`, jobs namespace
only. `@kubernetes/client-node` informers have no resync period, so a
leader reconcile timer runs every 5 minutes, and once after the initial
sync: it re-runs the Job and Pod handler over the informer caches (no API
call, writes only on change) and the step 6 check. Their error handlers
restart the watch with backoff; without one an informer stops silently. On
each event the scheduler derives `jobStatus` from the Job conditions and
the pod: `podName`; `phase`; `reason` and `message` from the pod
conditions (`Unschedulable`, `DisruptionTarget`) or the `function`
container state (`ImagePullBackOff`, `ErrImagePull`,
`CreateContainerConfigError`, `OOMKilled`, `Error`, `DeadlineExceeded`);
`exitCode` once terminated; `observedAt`. A change is a deep inequality of
every field except `observedAt`; it calls `setJobStatus` only on change,
and `setJobStatus` applies the same comparison in its compare-and-set.
State mapping: pod phase `Running` to `running`, condition `Complete` to
`succeeded` (from `running`, or from `scheduled` when `running` was never
observed), condition `Failed` to `failed`. On the terminal transition, in
this order: when object storage is configured, the Job completed and no
inline `result` was accepted, check the run's object and carry
`result_ref` in the patch; compare-and-set the
transition with the final `jobStatus`, `failureReason`, `error`, `logTail`,
`startTime` when missing (the delivery is inserted in the same
transaction); delete the Secret; delete the Job with background
propagation. A run already terminal on read, or after a false
compare-and-set and re-read, gets no writes: its Secret and Job are deleted
as on the terminal path. An object store error other than not-found leaves
the run untransitioned; the next event or reconcile tick retries. Jobs
therefore disappear when krun has recorded them; `ttlSecondsAfterFinished`
is only the safety net.

Failure detection. The truth about a run comes from Kubernetes, never from
the function's own reports:

- Crash or non-zero exit: the Pod informer sees the `function` container
  terminated; the Job controller marks the Job `Failed` within seconds.
  `failureReason` is `oom_killed` when the container reason is `OOMKilled`,
  `deadline_exceeded` when the Job condition reason is `DeadlineExceeded`,
  `evicted` when the pod reason is `Evicted` (including ephemeral-storage
  eviction), `disrupted` when the pod carries condition `DisruptionTarget`
  or the Job failed with no `terminated` state on the `function`
  container, otherwise `exit_code`. Target: the run is `failed` within 10
  seconds of the container exit, measured by
  `krun_terminal_detect_seconds`.
- Log tail: on the first Pod event that shows the `function` container
  terminated with a non-zero exit code or `OOMKilled`, or the pod carrying
  a `deletionTimestamp`, the scheduler fetches the last 100 lines (16 KB
  cap) at once and keeps them in memory for the terminal transition as
  `logTail`. Successful exits fetch nothing. If the terminal event arrives
  first, it fetches then; if the pod is already gone, `logTail` stays null.
  Every `pods/log` call aborts after 10 seconds; on timeout `logTail` stays
  null and the loop continues. `error` is the function's report when
  present, otherwise the Kubernetes reason and message. Fetch before
  delete, always.
- Hang: a Function with `heartbeatTimeout` promises to POST status at least
  that often once `running`. The heartbeat loop, every 10 seconds after
  the informers' initial sync, calls `listStale` for each such Function
  with `now - heartbeatTimeout`; staleness is measured from `startTime` or
  the last status, whichever is later. It skips a stale run whose cached
  Job carries `Complete` or `Failed`, or whose cached pod is missing or not
  `Running`: the informer path owns those. For each remaining stale run, in
  this order: fetch the log tail, delete the Job with foreground
  propagation, transition `running` to `failed` with `heartbeat_timeout`, `error` `{ source: krun, message: "no status for
  <timeout>, last at <time>" }` unless the function reported one (the
  store's `coalesce` keeps it) and the tail as `logTail`, delete the
  Secret. Functions without
  `heartbeatTimeout` are never judged by their reports; a hang there ends
  at `activeDeadlineSeconds` as `deadline_exceeded`.
- Scheduler restart: the informers' initial list replays the current Job
  and pod state, so a failure that happened while the scheduler was down
  is processed on start. After sync the scheduler logs the count of
  `scheduled` or `running` runs with no Job. A Job already removed by
  `ttlSecondsAfterFinished` becomes `job_lost` after the grace period, so
  scheduler downtime must stay below the TTL.

Deliveries loop, every 5 seconds: `claimDeliveries(now, 40)` leases the
rows for 60 seconds in the claim statement; POST with concurrency 8, a 10
second timeout, redirects not followed; mark `delivered` on 2xx only; the
tick awaits the whole batch (worst case 50 seconds, under the lease) and a
full batch claims again at once. Otherwise increment `attempt`, set
`next_at` by the schedule 1m, 5m, 30m, 2h, 12h, and mark `dead` after the
sixth failure (six attempts in all). The signature is computed per attempt
(section 9).

Sweep loop, every 10 minutes: `sweep(now - KRUN_RETENTION, 1000)` until a
batch returns fewer than 1000, and delete Secrets in the jobs namespace with
label `krun.io/run-id` older than 1 hour that have no matching Job.

## 9. Security

### Trust boundaries

- A caller holds an API key. It reaches the functions matching its globs
  and the runs it created. Scope `admin` reaches every run and function.
- A function pod holds a per-run token. It reaches one run, from the moment
  the token is set until the terminal transition, at most
  `activeDeadlineSeconds` later.
- All function authors of one installation form one trust domain: a
  Function may reference any Secret the platform team placed in the jobs
  namespace and any ServiceAccount in `KRUN_ALLOWED_SERVICE_ACCOUNTS`.
  Authors have no rights in the jobs namespace; the platform team creates
  `secretRefs` Secrets there. Per-tenant namespaces are a non-goal.
  `inputSchema` `pattern` regexes are trusted; there is no ReDoS guard.
- The platform team holds the krun namespace, the jobs namespace and the
  API keys Secret.

### API keys

API keys live in a YAML file, key `keys.yaml` of a Secret mounted at the
parent directory of `KRUN_API_KEYS_PATH` (`/etc/krun`), never with
`subPath`, reloaded by a 30 second poll on the content hash. Comparison is
constant-time. No key management API in v1.

```yaml
keys:
  - name: reports-service          # valid label value; becomes created_by and krun.io/created-by
    key: <random, at least 32 bytes>   # a string, or a list of strings during rotation
    scopes: [runs:write, runs:read, functions:read]   # also runs:priority, admin
    functions: ["report-*"]        # glob list, required unless scope admin
    maxQueued: 200                 # optional, queued runs per function for this key
```

`key` accepts a string or a list; any listed secret authenticates as that
name. The loader rejects duplicate names. Rotation: append the new secret,
wait one 30 second reload, switch clients, remove the old secret.

Authorization: a key may act only on functions matching its globs. Runs are
visible to their creator and to `admin`. `created_by` stores the key name.
The key's `maxQueued` is enforced by the gateway through `countQueuedBy`
with 429 and `Retry-After`.

### Internal API

Per-run token only, hashed with SHA-256 and compared with `timingSafeEqual`
against `runs.job_token_hash`, valid while the run is `queued` with a token
set, `scheduled` or `running`. The internal listener is a separate port and
Service, never exposed through the ingress; a NetworkPolicy on the gateway
pods admits the internal port only from the jobs namespace and leaves the
public port open. Plain HTTP inside the cluster in v1: the token is the
credential, the NetworkPolicy the perimeter; a mesh with mTLS can wrap it.
The token is never logged.

### Pod labels

Every chart pod template carries `app.kubernetes.io/name: krun` and
`app.kubernetes.io/instance: <release>`. The gateway Deployment and the
embedded StatefulSet pod templates also carry `krun.io/gateway: "true"`.
NetworkPolicies for 8080 and 8081 select `krun.io/gateway`; deny-all, the
admin ports and the PodMonitor select name and instance.

### Jobs namespace

Resources that always render into `jobsNamespace.name`: the scheduler Role
and RoleBinding, `krun-job-default`, `krun-job-viewer`. When
`jobsNamespace.create` is true the chart also renders the Namespace with
its labels (and `helm.sh/resource-policy: keep` when `jobsNamespace.keep`
is true, so `helm uninstall` leaves the namespace, its Secrets and
in-flight Jobs), the NetworkPolicies, the LimitRange and the
ResourceQuota. With `create: false` the namespace must exist before
install and must already carry the PSA labels, a deny-all NetworkPolicy
plus the DNS, gateway-8081 and object storage egress below, a LimitRange
with defaults and `max`, and a ResourceQuota whose `pods` is at least
`config.maxRunning`; the chart's quota check is skipped.

- Pod Security Admission labels `enforce`, `warn` and `audit` set to
  `restricted`, each with `-version` from `jobsNamespace.podSecurityVersion`
  (default `v1.33`).
- ValidatingAdmissionPolicy `krun-jobs-digest` and its binding, scoped to
  the jobs namespace when `jobsNamespace.admissionPolicy` is true (default):
  denies a Job or Pod whose containers or init containers carry an image
  without `@sha256:`, so a digest-pinned image is enforced by the API
  server even for objects krun did not create.
- When `jobsNamespace.userNamespaces` is true, function pods run with
  `hostUsers: false`: container root maps to an unprivileged host UID.
  Requires Kubernetes 1.36 (GA) or 1.33 to 1.35 with the feature enabled,
  and a node runtime and kernel that support ID-mapped mounts; default
  false.
- NetworkPolicy: default deny ingress and egress, then allow egress (1) UDP
  and TCP 53 to the peers in `jobsNamespace.dnsEgress` (default: namespace
  `kubernetes.io/metadata.name: kube-system`, pods `k8s-app: kube-dns`;
  NodeLocal DNSCache clusters append an ipBlock for the local DNS address);
  (2) TCP 8081 to pods labelled `krun.io/gateway: "true"` in namespace
  `kubernetes.io/metadata.name: <release namespace>`; (3) when
  `objectStorage.enabled`, the peers in `objectStorage.egress` (ipBlock, or
  namespaceSelector and podSelector for in-cluster MinIO) on the port parsed
  from `objectStorage.endpoint` (default 443 or 80); (4)
  `jobsNamespace.egressCIDRs`, a list of NetworkPolicy `ipBlock` objects
  (`cidr`, optional `except`), rendered as `- ipBlock:` peers; the chart's
  NOTES.txt warns when a `0.0.0.0/0` or `::/0` entry has no `except`
  (docs/OPERATIONS.md has the internet-egress recipe). Per-function extra
  egress is added by the platform team, not by krun.
- LimitRange with default requests and limits and `max` for cpu, memory
  and ephemeral-storage (default max cpu 4, memory 8Gi, ephemeral-storage
  20Gi). ResourceQuota on pod count and cpu, memory and ephemeral-storage
  requests. A pod exceeding its ephemeral-storage limit (`/tmp` plus logs)
  is evicted by the kubelet and classified `evicted`.
- ServiceAccount `krun-job-default` with no RoleBindings and
  `automountServiceAccountToken: false`.
- Role for the scheduler: `jobs` create, get, list, watch, delete; `pods`
  get, list, watch; `pods/log` get; `secrets` create, get, list, delete.
  RoleBinding to the scheduler ServiceAccount. In the krun namespace:
  `coordination.k8s.io/leases` get and update with `resourceNames:
  [krun-scheduler]` plus create without `resourceNames`; `functions.krun.io`
  get, list, watch; `functions.krun.io/status` patch.
- Role for the gateway in the krun namespace: `functions.krun.io` get, list,
  watch. Nothing else. Nothing cluster-wide except the CRD object itself.
- Role `krun-function-author` in the krun namespace: `functions.krun.io`
  get, list, watch, create, update, patch, delete. Rendered without a
  binding; the platform team binds it to each function team's group.
- Role `krun-job-viewer` in the jobs namespace: `pods` get, list;
  `pods/log` get; `batch` `jobs` get, list. Rendered without a binding, for
  function authors who need logs of runs still in flight.

### krun namespace

The chart renders ingress NetworkPolicies selecting the release's pods by
name and instance, not the whole namespace: deny all ingress, then allow
8080 on `krun.io/gateway` pods from anywhere, 8081 on `krun.io/gateway`
pods from the jobs namespace, and the admin ports (9090, plus 9091 in
embedded mode) from `networkPolicy.metricsFrom` (a namespaceSelector; empty
allows all). No egress policy in the krun namespace in v1. The namespace is
expected to enforce PSA `restricted`; every chart pod satisfies it (section
13).

### Webhooks

Callback hosts must match `KRUN_WEBHOOK_ALLOWED_HOSTS` globs. The gateway
resolves the host before accepting the run, unwraps IPv4-mapped addresses
and accepts an address when it falls inside a CIDR listed in
`KRUN_WEBHOOK_ALLOWED_CIDRS` (ipaddr.js `subnetMatch`; default empty) or
when its ipaddr.js `range()` is `unicast`, which rejects loopback,
link-local, RFC 1918, carrier-grade NAT, `0.0.0.0/8`, `::1`, `fc00::/7`,
`fe80::/10` and multicast. In-cluster receivers need their pod or Service
CIDR in the allowlist. The scheduler resolves and checks again at delivery
time and connects through an undici `Agent` whose `connect.lookup` returns
only the checked address with `connect.servername` set to the URL host;
`fetch(url, { redirect: 'manual', dispatcher })`, any 3xx fails the
attempt.

Payloads are signed per attempt over the exact bytes sent:
`X-Krun-Signature: t=<unix seconds at send>,v1=<hex HMAC-SHA256 of
"<t>.<body>">`, one `v1=` per secret in `KRUN_WEBHOOK_SECRET`, which is
comma-separated for rotation; receivers accept when any `v1=` matches,
comparing in constant time. `X-Krun-Delivery` is the `deliveries` row id,
constant across every attempt of one delivery; `X-Krun-Run-Id` is the bare
run UUIDv7. Receivers must reject `|now - t| > 300` seconds and dedupe on
`X-Krun-Delivery`. The payload is the BASIC `Run` view (docs/API.md
section 7), `RunSummary` in section 6, at the terminal transition.

### Secrets, logs, images

Function secrets are referenced by name, never stored by krun. Input never
goes into env vars or the Job manifest. Logs never include input, results,
tokens or keys (section 11 lists the redactions).

Images: digest only. `KRUN_ALLOWED_REGISTRIES` optionally restricts image
prefixes. krun verifies no function-image signatures; enforce them with the
platform's admission policy (Kyverno `verifyImages` or Sigstore
policy-controller) on the jobs namespace. The krun image and the OCI chart
are signed with cosign keyless and carry a syft SPDX SBOM attestation
(section 13).

## 10. Backpressure defaults

| Setting | Default | Note |
|---|---|---|
| rate limit per key | 10 req/s, burst 50 | per gateway replica |
| `maxQueued` per function | 1000 | 429 `queue_full` beyond; ceiling `KRUN_MAX_QUEUED` |
| `maxQueued` per key | unset | 429 `queue_full` beyond |
| `priority` | 0 | 0 to 9, above 0 needs scope `runs:priority` |
| `KRUN_MAX_INPUT_BYTES` | 262144 | hard ceiling 1 MiB |
| `maxConcurrency` per function | 10 | |
| `KRUN_MAX_RUNNING` | 100 | global; chart fails when above `jobsNamespace.quota.pods` while `jobsNamespace.create` is true |
| `queueTimeout` | 1h | fails with `queue_timeout`; also the default for deleted Functions |
| `heartbeatTimeout` per function | unset | minimum 30s; stale runs fail with `heartbeat_timeout` |
| `activeDeadlineSeconds` | 3600 | ceiling `KRUN_MAX_ACTIVE_DEADLINE`, default 86400 |
| `backoffLimit` | 0 | no automatic retries |
| `ttlSecondsAfterFinished` | 86400 | safety net; the scheduler deletes Jobs itself |
| `KRUN_MAX_RESULT_BYTES` | 262144 | hard ceiling 1 MiB; larger results use object storage |
| status reports | 1 per second per run | per gateway replica, 429 beyond |
| `KRUN_K8S_CONCURRENCY` | 8 | concurrent Kubernetes API calls in the scheduler, 10 s timeout each |
| main loop iteration | 10 s | deadline; unprocessed claims released |
| `KRUN_MAX_WAIT` | 60s | below ingress timeout |
| webhook attempts | 6 over about 15h | at-least-once, 10 s timeout each, 60 s claim lease |
| `KRUN_RETENTION` | 720h | sweep batch 1000 |
| LimitRange `max` | cpu 4, memory 8Gi, ephemeral-storage 20Gi | per container in the jobs namespace |
| lease | 30s | scheduler claim |
| job lost grace | 2m | |

## 11. Observability

Telemetry is OpenTelemetry through `@effect/opentelemetry`. Metrics are
Effect `Metric`s exported by the OpenTelemetry Prometheus exporter on the
admin listener's `/metrics`; the exposed names are exactly those in the
table below (instrument names are chosen so the exporter's `_total` and
unit suffixes produce them). Traces: every `/v1` and `/internal/v1`
request, every scheduler loop iteration, every store call and every
Kubernetes API call is an Effect span (`Effect.withSpan`); spans are
exported over OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
else dropped. An incoming W3C `traceparent` on the public or internal API
is honoured; webhook deliveries send one. Every log line inside a span
carries `traceId` and `spanId`. Every span about a run carries the
attribute `krun.run_id`, which correlates a run's spans across the
gateway, the scheduler and the pod's internal calls; v1 does not join
them into one trace. Span attributes never contain input, results, tokens
or keys (the section 9 redaction list applies).

Metrics on the admin listener of each process:

| Metric | Owner | Meaning |
|---|---|---|
| `krun_http_requests_total{route,code}` | both | `route` is `request.routeOptions.url`, `unmatched` for 404 |
| `krun_http_request_seconds{route}` | both | |
| `krun_admission_rejections_total{reason}` | gateway | `rate_limit`, `max_queued`, `input_size`, `schema` |
| `krun_runs_transitions_total{function,to}` | scheduler leader | |
| `krun_runs_current{function,state}` | scheduler leader | from `countByState` each loop |
| `krun_runs_failed_total{function,reason}` | scheduler leader | `failureReason` values |
| `krun_queue_wait_seconds{function}` | scheduler leader | created to scheduled |
| `krun_cold_start_seconds{function}` | scheduler leader | scheduled to running |
| `krun_run_duration_seconds{function,state}` | scheduler leader | running to terminal |
| `krun_terminal_detect_seconds{function}` | scheduler leader | container exit to terminal state |
| `krun_job_create_errors_total{function,code}` | scheduler leader | API status on Secret or Job create |
| `krun_quota_rejections_total{function}` | scheduler leader | |
| `krun_scheduler_leader` | scheduler | 1 on the leader |
| `krun_functions_synced` | both | 1 after the Function informer's initial list |
| `krun_functions{ready}` | both | Function count by readiness |
| `krun_deliveries_total{state}` | scheduler leader | |
| `krun_sweep_deleted_total` | scheduler leader | |

Logs: JSON via pino, one line per event, fields `run_id`, `function`,
`state`, `reason`, `reqId` where relevant. Level from `KRUN_LOG_LEVEL`.
pino `redact` in both processes on every listener covers
`req.headers.authorization`, `input`, `result`, `runtimeStatus`,
`error.details` and `dsn`; bodies, Job manifests and env lists (presigned
URLs) are never logged.

Audit: every `/v1` request logs one line at info (warn for 401 and 403)
with `key` (name, or null), `client_ip` (Fastify `trustProxy: true`),
`user_agent`, `route`, `code`, `run_id`, `function` and `idempotency_key`
where present; never the key itself.

Health: `/healthz` always 200 when the process runs. `/readyz` checks the
database (bounded to 2 seconds, 503 when it stalls) and the Function
informer sync and returns 503 from the start of shutdown; the scheduler also reports leader status there without failing
readiness for standby replicas.

Shutdown on SIGTERM: the gateway first makes `/readyz` return 503, keeps
serving for `KRUN_SHUTDOWN_DELAY` (default 5s) so endpoints drain (`/v1`
never returns `NOT_READY` during the drain), then
closes the listeners, ends open SSE streams, answers in-flight `wait`
requests at once with the current state, closes the pool and exits 0. The
scheduler stops claiming, bounds the in-flight iteration to 10 seconds,
stops the informers, clears `holderIdentity` on the Lease so a standby takes
over at once, closes the pool and exits 0; unfinished leases expire
normally. Both fit the 30 second grace period.

## 12. Configuration

Environment variables. Flags are not supported except `--help`. Each
process validates its variables at startup and exits 1 naming the first bad
one: `KRUN_DB_DSN` empty in postgres mode; scheduler with
`KRUN_WEBHOOK_ALLOWED_HOSTS` set and `KRUN_WEBHOOK_SECRET` empty;
`KRUN_MAX_INPUT_BYTES` or `KRUN_MAX_RESULT_BYTES` above 1048576; a duration
not matching `^\d+(ms|s|m|h)$`; a CIDR that does not parse. An empty value
is unset: the default applies and no validation runs on it.

| Variable | Default | Used by |
|---|---|---|
| `KRUN_DB_MODE` | `postgres` | both. `postgres` or `embedded` |
| `KRUN_DB_DSN` | | both, postgres mode |
| `KRUN_DB_PATH` | `/data/krun.db` | both, embedded mode |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway |
| `KRUN_LISTEN_ADDR` | `:8080` | gateway, public API |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | gateway, internal API |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9090` | both, probes and metrics; the chart sets `:9091` on the scheduler in embedded mode |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | scheduler, injected into Jobs; the chart always sets it from the rendered internal Service name and port, the default serves non-chart deployments |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler |
| `KRUN_NAMESPACE` | pod namespace, read from the ServiceAccount `namespace` file | both: Functions and Lease |
| `KRUN_POD_NAME` | required by scheduler serving process; downward API `metadata.name` | scheduler Lease identity (D98) |
| `KRUN_MAX_RUNNING` | `100` | scheduler |
| `KRUN_MAX_QUEUED` | `1000` | both, ceiling for `maxQueued` |
| `KRUN_MAX_INPUT_BYTES` | `262144` | gateway |
| `KRUN_MAX_RESULT_BYTES` | `262144` | both |
| `KRUN_MAX_WAIT` | `60s` | gateway |
| `KRUN_SHUTDOWN_DELAY` | `5s` | gateway |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | both, Function validation |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | both, Function validation; comma-separated |
| `KRUN_K8S_CONCURRENCY` | `8` | scheduler |
| `KRUN_JOB_HOST_USERS` | `true` | scheduler; `false` sets `hostUsers: false` on function pods (chart value `jobsNamespace.userNamespaces`) |
| `KRUN_TTL_AFTER_FINISHED` | `86400` | scheduler |
| `KRUN_RETENTION` | `720h` | scheduler |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | scheduler, PUT presign; a duration. The gateway's GET presign is fixed at 300 s |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty, webhooks disabled | both |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | both; comma-separated CIDRs that pass the address check |
| `KRUN_WEBHOOK_SECRET` | | scheduler; comma-separated secrets, one signature each |
| `KRUN_LOG_LEVEL` | `info` | both |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty, traces dropped | both; standard OpenTelemetry variable, OTLP/HTTP |
| `OTEL_SERVICE_NAME` | `krun-gateway` or `krun-scheduler` | both |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio`, `0.1` | both |

`KRUN_API_URL`, `KRUN_API_KEY`, `KRUN_REGISTRY` are read by the CLI on a
developer machine only (section 7.2); `krun validate` and `krun deploy` also
read the five validation ceilings named in section 3.

## 13. Deployment

Helm chart at `deploy/helm/krun`, published as
`oci://ghcr.io/xenarro/charts/krun`. Values shape:

```yaml
image: { repository: ghcr.io/xenarro/krun, tag: "" }   # tag defaults to appVersion

gateway:
  replicas: 2
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 512Mi } }
scheduler:
  replicas: 1          # extra replicas are standby
  resources: { requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 512Mi } }
priorityClassName: ""
terminationGracePeriodSeconds: 30

config:                 # one camelCase key per section 12 tunable, rendered as env on both processes
  maxRunning: 100
  maxQueued: 1000
  maxInputBytes: 262144
  maxResultBytes: 262144
  maxWait: 60s
  shutdownDelay: 5s
  rateLimitRps: 10
  rateLimitBurst: 50
  maxActiveDeadline: 86400
  allowedServiceAccounts: krun-job-default
  k8sConcurrency: 8
  ttlAfterFinished: 86400
  retention: 720h
  allowedRegistries: ""
  s3PresignTtl: ""      # empty means unset: the run's activeDeadlineSeconds
  logLevel: info

db:
  mode: postgres        # postgres | embedded
  postgres:
    existingSecret: ""  # key: dsn; required in postgres mode, chart fails when empty
  embedded:
    storage: 1Gi
    storageClass: ""    # empty omits storageClassName (an empty string would disable dynamic provisioning)
    litestream:
      enabled: false
      image: ""         # pinned by digest; required when enabled
      url: s3://bucket/krun
      existingSecret: ""   # keys: LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY; required when enabled
      # rendered as a native sidecar: an init container with restartPolicy: Always

crds:
  install: true         # CRD templated into the release
  keep: true            # helm.sh/resource-policy: keep on the CRD
apiKeys:
  existingSecret: ""    # key: keys.yaml; required

jobsNamespace:
  name: krun-jobs
  create: true
  keep: true            # helm.sh/resource-policy: keep on the Namespace
  podSecurityVersion: v1.33
  admissionPolicy: true # ValidatingAdmissionPolicy requiring digest-pinned images
  userNamespaces: false # hostUsers: false on function pods; see section 9
  quota: { pods: "200", requests.cpu: "50", requests.memory: 100Gi, requests.ephemeral-storage: 100Gi }
  limitRange:
    defaultRequest: { cpu: 100m, memory: 128Mi, ephemeral-storage: 256Mi }
    default:        { cpu: "1",  memory: 1Gi,   ephemeral-storage: 2Gi }
    max:            { cpu: "4",  memory: 8Gi,   ephemeral-storage: 20Gi }
  dnsEgress:            # NetworkPolicyPeer list for UDP and TCP 53
    - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
      podSelector: { matchLabels: { k8s-app: kube-dns } }
  egressCIDRs: []       # ipBlock objects { cidr, except: [] }, extra egress for all functions

networkPolicy:
  metricsFrom: {}       # namespaceSelector allowed to scrape the admin ports; empty allows all

gatewayApi:
  httpRoute:            # Gateway API HTTPRoute for the public API (port 8080)
    enabled: false
    parentRefs: []      # Gateway references
    hostnames: []

observability:
  otlpEndpoint: ""      # OTEL_EXPORTER_OTLP_ENDPOINT on both processes; empty drops traces
  tracesSampleRatio: "0.1"

metrics:
  podMonitor: { enabled: false, labels: {} }
  prometheusRule:
    enabled: false
    labels: {}
    thresholds: { queueWaitP95Seconds: 60, jobLostPerHour: 1, heartbeatTimeoutsPerHour: 5, quotaRejectionsPerMinute: 1 }

objectStorage: { enabled: false, endpoint: "", bucket: "", region: "", existingSecret: "", egress: [] }
  # existingSecret keys: accessKey, secretKey; endpoint, bucket and existingSecret required when enabled
webhooks: { allowedHosts: [], allowedCIDRs: [], existingSecret: "" }
  # existingSecret key: secret (comma-separated); required when allowedHosts is set
```

Chart `fail` cases, each with a clear message: `apiKeys.existingSecret`
empty; `db.postgres.existingSecret` empty in postgres mode (a release Secret
does not exist when the pre-install hook runs); `webhooks.allowedHosts` set
without `existingSecret`; `objectStorage.enabled` with empty `endpoint`,
`bucket` or `existingSecret`; `db.embedded.litestream.enabled` with empty
`image` or `existingSecret`; `config.maxRunning` above
`jobsNamespace.quota.pods` while `jobsNamespace.create` is true;
`gateway.replicas` or `scheduler.replicas` above 1 in embedded mode. The
chart renders no `Secret` of its own. NOTES.txt warns when an `egressCIDRs`
entry for `0.0.0.0/0` or `::/0` has no `except`.

Every chart pod (Deployments, StatefulSet, migrate hook Job, init
containers, Litestream sidecar) sets `runAsNonRoot`, `runAsUser` and
`runAsGroup` 65532 (distroless nonroot), `seccompProfile: RuntimeDefault`,
`capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true` with an emptyDir at `/tmp`;
`automountServiceAccountToken` only on the gateway and the scheduler. The
pods satisfy PSA `restricted` and carry the section 9 labels; the chart
does not label the krun namespace, the platform team does
(docs/OPERATIONS.md). Every serving gateway or scheduler container has a readiness probe on
`/readyz` (`periodSeconds: 5`, `timeoutSeconds: 3`, `failureThreshold: 3`)
and a liveness probe on `/healthz` (`periodSeconds: 10`, `timeoutSeconds:
3`, `failureThreshold: 3`, never `/readyz`), no startup probe, each on its
own admin port, the default resources above with no CPU limit, and the
chart's `priorityClassName` and `terminationGracePeriodSeconds`. The
gateway gets a PodDisruptionBudget `minAvailable: 1` when `replicas > 1`
and hostname `topologySpreadConstraints` with `whenUnsatisfiable:
ScheduleAnyway`. The scheduler Deployment uses `RollingUpdate` with
`maxSurge: 1` and `maxUnavailable: 0`, so a Ready standby exists before the
leader receives SIGTERM.

Postgres mode renders two Deployments. Migrations run in a Helm hook Job
(`helm.sh/hook: pre-install,pre-upgrade`, `helm.sh/hook-weight: "0"`,
`helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`,
`restartPolicy: Never`, `backoffLimit: 1`, `activeDeadlineSeconds: 240`)
executing `krun migrate` as ServiceAccount `krun-migrate`, itself rendered
as a hook resource with the same hook and delete-policy annotations and
`helm.sh/hook-weight: "-5"`, with no Role and
`automountServiceAccountToken: false`; `krun migrate` reads only the
`KRUN_DB_*` variables. The one-shot migrate hook starts no admin HTTP listener
and has no readiness, liveness or startup probes; Job completion, process exit,
retry and deadline bounds govern its health instead.

Embedded mode renders one StatefulSet with one replica and two containers,
gateway and scheduler, sharing one PVC with `fsGroup: 65532` and
`fsGroupChangePolicy: OnRootMismatch`; `volumeClaimTemplates` sets
`storageClassName` only when `db.embedded.storageClass` is non-empty. The
pod runs as the scheduler ServiceAccount (its krun-namespace Role is a
superset of the gateway's); embedded mode renders no gateway ServiceAccount
or RoleBinding. A headless Service (`clusterIP: None`, no ports, selector
name and instance) is the `serviceName`. The scheduler container runs with
`KRUN_ADMIN_LISTEN_ADDR=:9091` and port name `admin-sched`; each container
declares its ports and probes on its own admin port. Init containers run
in order: Litestream restore (removes orphan `-wal` and `-shm` files when
`krun.db` is absent, then `-if-replica-exists -if-db-not-exists`, when
enabled) then `krun migrate`. With Litestream enabled, a native sidecar
(an init container with `restartPolicy: Always`, placed after the restore
init container and before `krun migrate`) from
`db.embedded.litestream.image` streams the WAL to object storage; the
kubelet starts it before the app containers and stops it after them, so no
WAL write is missed at shutdown. SQLite in
WAL mode supports two processes on one local volume. Network filesystems
are not supported. One replica means an upgrade is a brief downtime.

Both modes render: the CRD as a template when `crds.install` is true, with
`helm.sh/resource-policy: keep` when `crds.keep` is true, so `helm upgrade`
upgrades it and `helm uninstall` leaves it (`crds.install=false` installs
apply `deploy/crds/functions.krun.io.yaml` by hand before every
`helm upgrade`); Services (public, and `krun-gateway-internal` for the
internal port; no Service exposes the admin ports); the krun namespace
NetworkPolicies from section 9; ServiceAccounts, Roles and RoleBindings for
the gateway, the scheduler and the migrate hook; the Roles
`krun-function-author` and `krun-job-viewer`; the ValidatingAdmissionPolicy
and binding when `jobsNamespace.admissionPolicy` is true; an HTTPRoute to
the public Service when `gatewayApi.httpRoute.enabled`; a PodMonitor (one endpoint
per admin port name) and a PrometheusRule when enabled under `metrics`;
and the jobs namespace resources per the section 9 rendering rule, the
Namespace kept on uninstall when `jobsNamespace.keep` is true. The chart
renders no Function resources: functions are deployed by their owners
(section 7.2), never by the platform release. A separate CRD-only chart is
not needed until a second API version exists.

`keep` consequences: a kept CRD or Namespace retains the old release's
`meta.helm.sh` annotations. Re-install with the same release name and
namespace, or run `kubectl annotate <crd functions.krun.io | namespace
<jobs ns>> meta.helm.sh/release-name=<name>
meta.helm.sh/release-namespace=<ns> --overwrite`. Deleting the CRD deletes
every Function; `helm uninstall` removes krun's LimitRange, ResourceQuota
and NetworkPolicies from a kept jobs namespace but leaves the namespace,
its Secrets and in-flight Jobs.

Alert rules rendered by `metrics.prometheusRule`:

| Rule | Expression | For | Severity |
|---|---|---|---|
| `KrunNoLeader` | `max(krun_scheduler_leader) == 0 or absent(krun_scheduler_leader)` | 2m | critical |
| `KrunFunctionsNotSynced` | `min(krun_functions_synced) == 0` | 2m | critical |
| `KrunJobLost` | `sum(increase(krun_runs_failed_total{reason="job_lost"}[1h])) > thresholds.jobLostPerHour` | 0m | warning |
| `KrunHeartbeatTimeouts` | `sum(increase(krun_runs_failed_total{reason="heartbeat_timeout"}[1h])) > thresholds.heartbeatTimeoutsPerHour` | 0m | warning |
| `KrunDeliveriesDead` | `increase(krun_deliveries_total{state="dead"}[1h]) > 0` | 0m | warning |
| `KrunQuotaRejections` | `sum(rate(krun_quota_rejections_total[5m])) * 60 > thresholds.quotaRejectionsPerMinute` | 10m | warning |
| `KrunQueueWaitHigh` | `histogram_quantile(0.95, sum(rate(krun_queue_wait_seconds_bucket[10m])) by (le)) > thresholds.queueWaitP95Seconds` | 10m | warning |

docs/OPERATIONS.md explains each rule by name and its first checks.

Upgrade policy: migrations are forward-only and expand/contract: each
migration keeps the previous minor's code working, drops ship one minor
later; `helm rollback` by one minor is supported; before `migrateToLatest`,
`krun migrate` reads `kysely_migration` and diffs it against the binary's
migration names: unknown names with nothing pending warn and exit 0,
unknown names with pending migrations exit 1. CRD `v1alpha1` is
additive-only: new fields are optional with defaults; a breaking change
opens `v1alpha2` by a Decisions row, without a conversion webhook in v1;
`v1alpha1` stays `served: true, storage: true` until then. One SemVer
version per tag for the image, the chart (`version` and `appVersion`), the
SDKs and the CLI; `release.yml` stamps it on `v*` tags, signs the image and
the OCI chart with cosign keyless and attaches a syft SPDX SBOM. Scheduler
downtime must stay below `KRUN_TTL_AFTER_FINISHED`.

## 14. Limits and boundaries

- Submission rate: a few runs per second sustained. The bound is Job
  creation and pod scheduling, not the database. Measured numbers go in the
  README after Phase 9.
- Cold start: seconds, dominated by scheduling and image pull. Functions
  shorter than their cold start belong in a worker pool, not in krun.
- Input: 256 KB default, 1 MiB hard.
- Inline result: 256 KB default, 1 MiB hard. Larger results need object
  storage.
- Error report: 4 KB message, 8 KB details. Log tail: 16 KB. Input schema:
  64 KiB.
- Run history: retention window, default 30 days. Export for longer history
  is out of scope.
- Kubernetes 1.33 or newer: CEL validation rules in the CRD, Pod Security
  Admission labels, `DisruptionTarget` pod condition, native sidecar
  containers, ValidatingAdmissionPolicy. User namespaces for function pods
  need 1.36, or the feature enabled on 1.33 to 1.35. A CNI that enforces
  NetworkPolicy; the isolation in section 9 is void without one. Gateway
  API CRDs only when the HTTPRoute is enabled.
- Postgres 16 or newer; CI runs the contract suite against Postgres 18.
- Node.js 26 for krun's own image; the Node SDK supports Node 22 or newer
  (Node 20 reached end of life in April 2026).
- One trust domain per installation for function authors.

## 15. Decisions

Each row is the decision in force. Ids are stable references; a gap means
the number is unused.

| Id | Decision | Why |
|---|---|---|
| D2 | Runs live in krun's database; Kubernetes is the execution engine. The only custom resource is the `Function` definition (D17); there is no operator for runs | a database gives run history, filtering and pagination that etcd objects cannot |
| D3 | Postgres is the system of record; SQLite is `db.mode: embedded` | every krun need maps to a built-in database feature; one SQL shape for both; Litestream backs up embedded mode |
| D4 | No Kafka, Redis, RocksDB, LevelDB or other KV engines | Kafka has no lookup or update by id; Redis is not a system of record; KV engines mean hand-built indexes with no gain at this write rate |
| D5 | Gateway and scheduler are separate processes and Deployments; the only contract between them is the database | independent scaling, no RPC coupling, the gateway keeps accepting runs when the scheduler is down |
| D6 | Job pods never hold database or API-key credentials; they reach krun only through the internal API with a per-run token (D16) | one compromised function image must not read other runs' data |
| D7 | API keys live in a mounted Secret file, not in the database | no key management API in v1; the Secret is the protection boundary |
| D8 | No automatic retries; Jobs run with `backoffLimit: 0` | retries with side effects must be visible and chosen by the client |
| D9 | Run ids are UUIDv7 | time-ordered ids give stable cursor pagination and match `created_at` order |
| D10 | No table partitioning in v1 | Postgres requires the partition key inside unique constraints, which breaks the idempotency index; batched delete suffices |
| D11 | The per-run Secret has no owner reference; the scheduler deletes it at the terminal transition, an orphan sweep catches the rest | avoids a create-then-patch dance against the Job UID |
| D12 | API keys reload by a 30 second poll on the mounted file's content hash, not a file watcher | Secret mounts update through a symlink swap; polling is enough and needs no dependency |
| D13 | A failed run stores a log tail; a successful run stores no logs | enough to debug a failure without a log pipeline |
| D14 | Target workload: runs of tens of seconds to hours | Job-per-run cold start and API server load make sub-second or high-rate functions a poor fit |
| D15 | TypeScript 7 on Node.js 26, ES modules, one pnpm workspace (`packages/shared`, `packages/sdk-node`, `packages/cli`, `apps/gateway`, `apps/scheduler`), one container image with the `gateway`, `scheduler`, `migrate` and `validate` entrypoints. docs/STACK.md is the normative list of libraries | one language across services, CLI and SDK; Node 26 is LTS to April 2029 |
| D16 | Job pods fetch input, report status and write results or errors through the gateway's internal API with a per-run token from a per-run Secret (docs/INTERNAL-API.md) | input and result sizes are not bound by Secret or termination-message limits; runtime status reaches callers; the token is scoped to one run and dies at its end |
| D17 | Function definitions are a CRD (`functions.krun.io`, `v1alpha1`) read by an informer in the gateway and the scheduler | one etcd object per function with no aggregate size cap, per-team RBAC, apply-time validation through OpenAPI and CEL, status on the resource, propagation within a second |
| D18 | Run `state` and `jobStatus` derive from Job and Pod informers only; `running` means the pod phase is `Running`; `runtimeStatus` never drives state | a function that ignores the contract is still tracked; a pod stuck before start is visible on the run |
| D19 | Failure truth comes from Kubernetes: a `failureReason` on every failed run, a log tail captured on the first terminating pod event, and an opt-in per-function `heartbeatTimeout` that kills and fails a silent run | crashes are classified within seconds; a hung function is bounded by its own promise; long silent computations stay safe |
| D20 | Node.js and Python SDKs and the `krun init` templates implement the internal API; the SDKs have no runtime dependencies and a local mode; the contract stays plain HTTP | template plus SDK is the golden path, curl the escape hatch |
| D21 | The custom resource is `Function` (short name `kfn`) and the whole vocabulary follows it: `/v1/functions`, `functions:read`, `KRUN_FUNCTION`, `krun.io/function`, `function_name` | one word everywhere; the short name and the qualified name resolve clashes with other `functions` CRDs |
| D22 | The platform chart templates the CRD (`crds.install`, `crds.keep`) and renders no Function resources; functions deploy by `kubectl apply`, `krun deploy` or GitOps; Role `krun-function-author` is rendered without a binding | the platform team owns the type, function teams own instances; `helm upgrade` upgrades the CRD |
| D23 | Secret and Job create errors are classified by status: 403 quota, 429, 5xx and network errors back off; any other 4xx fails the run with `job_create_failed` | a persistent admission or RBAC rejection surfaces within seconds; a control-plane blip fails nothing |
| D24 | The internal API is versioned at `/internal/v1`, independent of `/v1`; SDK major N speaks `/internal/vN`; OpenAPI documents for both APIs are generated from the Zod route schemas | SDKs and gateway evolve separately; curl stays allowed |
| D25 | `priority` is 0 to 9 and needs scope `runs:priority` above 0; keys carry an optional per-key `maxQueued`; Jobs carry `krun.io/created-by` | fairness between keys sharing a function, cost attribution |
| D26 | One trust domain per installation for function authors; `KRUN_ALLOWED_SERVICE_ACCOUNTS` and the `krun-*` `secretRefs` rule bound what a Function may reference; `LimitRange.max` caps one function | pods are isolated from krun; authors are not isolated from each other, and per-tenant namespaces are a non-goal |
| D27 | The per-run token is persisted before the Job exists and accepted while the run is `queued` with a token; Secrets are immutable; `markScheduled` returning false deletes Job and Secret | no 401 window at pod start, no stranded tokens, no orphan Jobs |
| D28 | The scheduler deletes Jobs after recording the terminal state; `ttlSecondsAfterFinished` defaults to 86400 as a safety net; `job_lost` keeps a written result | a scheduler outage must not turn successes into failures |
| D29 | Deliveries are inserted in the terminal transaction; webhook signatures carry a timestamp and one signature per secret; receivers reject skew over 300 seconds | no lost deliveries on a crash, no replay, secret rotation without downtime |
| D30 | Probes and metrics live on an admin listener (`:9090`), never on the public port; per-pod ingress NetworkPolicies in the krun namespace; every chart pod satisfies PSA `restricted`; the gateway drains for `KRUN_SHUTDOWN_DELAY` before closing | unauthenticated endpoints stay inside the cluster; rollouts without 502s |
| D31 | Webhook targets pass the address check when inside `KRUN_WEBHOOK_ALLOWED_CIDRS` or when their range is `unicast` | in-cluster receivers are a real use; an explicit allowlist keeps the SSRF guard as the default |
| D32 | The jobs namespace is kept on `helm uninstall` (`jobsNamespace.keep`); `egressCIDRs` are `ipBlock` objects with `except`; LimitRange and ResourceQuota bound ephemeral-storage | the platform team's Secrets and in-flight Jobs survive a release removal; cloud metadata stays unreachable; one function cannot fill a node disk |
| D33 | A leader reconcile timer re-runs the Job and Pod handlers over the informer caches every 5 minutes; the heartbeat loop and the `job_lost` check start only after the informers' initial sync and defer to the informer path for runs whose cached Job is terminal | `@kubernetes/client-node` informers have no resync; a completed run is never killed as `heartbeat_timeout` |
| D34 | The public API is resource-oriented per the Google AIPs, normative in docs/API.md | one well-known convention for clients, filters, pagination and errors; deviations are listed in docs/API.md section 11 |
| D35 | Effect 4 is the foundation of every process (services, layers, typed errors, scopes, schedules, streams, clock) with Fastify 5 as the HTTP engine inside it; Zod 4 is the only schema language for krun's own schemas and generates the CRD and OpenAPI; Ajv compiles only user `inputSchema`; time comes from Effect `Clock`, `DateTime`, `Duration`; tests run on Vitest with `@effect/vitest` | every concurrency rule in section 8 maps to an Effect primitive and every timer is testable with `TestClock`; one schema source for routes, CRD, config and OpenAPI |
| D36 | Data through Kysely on `pg` and Node's built-in `node:sqlite`; telemetry through OpenTelemetry (`@effect/opentelemetry`: Prometheus `/metrics`, OTLP traces when configured); Kubernetes 1.33 minimum with Litestream as a native sidecar, a digest ValidatingAdmissionPolicy, optional user namespaces and an optional Gateway API HTTPRoute; Postgres 16 minimum, CI on 18 | no native addons in the image; a run is traceable across gateway, store and Kubernetes; image policy enforced by the API server |
| D37 | Vite 8 is a development-only dependency supplying Vitest 5's required peer; automatic peer installation stays disabled and process entrypoints import `@effect/platform-node/NodeRuntime` directly | Vitest 5 cannot start or type-check without Vite; disabling automatic peers avoids installing unused Redis support from the platform-node barrel; no Vite or Redis enters the runtime image |
| D38 | Pin the OpenTelemetry API range to `~1.9.0` with the allowed stable SDK 2.12 / experimental 0.223 family, and import `@effect/opentelemetry/NodeSdk` directly | SDK 2.12 declares API `<1.10.0`; `^1.9.0` would still admit incompatible 1.10. The browser SDK is an optional peer, not a Node runtime dependency. Declared peer compatibility does not waive release-age checks or prove installation/runtime acceptance. |
| D39 | Apply a tracked pnpm declaration-only patch to Fastify/pino's transitive `thread-stream@4.2.0`, deriving its transfer-list type from `Worker.postMessage` | Its published declaration references `worker_threads.TransferListItem`, removed from Node 26 types. The installed graph otherwise fails strict compilation. Keep library checking, package integrity and release-age policy enabled, change no runtime JavaScript, and include the patch before both container installs; remove the patch when upstream supplies the compatible declaration. |
| D40 | Function input requires image and an explicit object inputSchema; documented defaults remain optional on input. Deadline/concurrency floors are 1, queue capacity floor 0; queue timeout floor 1 ms and heartbeat floor 30 s, with safe-integer milliseconds and leading-zero/equivalent-unit parity in Zod, editor and CRD patterns. Status is optional, Ready conditions form a map-list keyed by type with required type/status/reason and message default empty | User-delegated schema decisions resolve prior ambiguities without inventing installation ceilings, unrestricted input defaults or create-time readiness. Shared bounded duration patterns avoid CEL conversion overflow; native-source generation and independent review verify the contract before delivery. |
| D41 | Development-only generated-editor conformance tests may evaluate Zod-emitted JSON Schema with the already allowed Ajv2020 and ajv-formats; application/runtime validation of krun-owned schemas remains Zod-only | Independent standards evaluation of emitted floor/overflow/newline semantics avoids relying on reverse conversion through the same schema library. This adds no application validator or new runtime dependency. |
| D42 | Function callback wire strings use a shared raw RFC 3986 ASCII URI pattern with a nonempty scheme-specific component and nonempty authority host, without WHATWG normalization; inputSchema uses an identity-preserving Zod custom object boundary with an explicit, identity-scoped object JSON Schema mapping | Independent reviews reproduced URL/editor acceptance and output differences plus loss of own __proto__ keys in Zod records. Representable syntax preserves HTTP examples and keeps transport/host/DNS policy in runtime validation. The sole custom projection validates object type without rebuilding opaque user data; unrelated unrepresentable types still fail closed. |
| D43 | The in-house node:sqlite Kysely adapter declares transactional DDL support, retaining single-connection serialization and `begin immediate` | Kysely 0.29.7's default SQLite adapter declares it false; a reproduced late initial-migration failure left earlier tables behind. Node 26 SQLite supports transactional schema changes, so the adapter must let Migrator atomically roll back DDL and migration history. This changes no public contract, dependency policy or migration-history checks. |
| D44 | Explicitly deny the dev-only Testcontainers transitive install scripts for `cpu-features`, `ssh2` and `protobufjs` through pnpm 12 `allowBuilds` | Parent-authorized inspection found optional native SSH/CPU acceleration and a dependency-notation warning, none required by local Docker/Postgres tests. A frozen install and real Testcontainers acceptance validate the script-free path; no native addon, global script bypass, release-age exception or automatic peer installation is enabled. |
| D45 | Build implemented Store methods as typed Database-backed factories until the full declared Store can be assembled; do not stub later methods. Keep JCS request hashing shared and separate from `createRun(NewRun)` | P1.3 is the first method slice and NewRun already carries application-issued id, time and request_hash. A shared helper hashes only API 3.3's fixed input/priority/callback projection (absent priority as 0 and absent callback as null), before applying the Function's default callback; requestId and wait stay excluded. `makeCreateRun` supplies exactly StoreShape's createRun signature; later tasks compose real methods into the unchanged Store service. This changes no public interface, idempotency policy or remaining acceptance gates. |
| D46 | SQLite event rowids are a storage-only `INTEGER PRIMARY KEY AUTOINCREMENT` alias, introduced by compatible forward migration `0002_event_rowid` without rewriting `0001_init` | Independent P1.8 probes reproduce a live strict rowid cursor missing new transitions after normal retention deletes the old maximum/all events. SQLite documents that ordinary rowids may be reused, while AUTOINCREMENT preserves committed allocation in `sqlite_sequence` (https://www.sqlite.org/autoinc.html). Accept its per-insert bookkeeping cost for this required invariant. Atomically copy existing rowids and all six shared event columns, preserving index/cascade and old writers; test rollback, restart, empty-table and deleted-maximum retention with no replay. No cursor reset, public API/security/non-goal change, new dependency or Postgres change. |
| D47 | Add `@types/picomatch` `^4.0` as a development-only declaration companion for the already approved picomatch 4 runtime | P2.1 consumes the STACK-approved glob implementation directly. Installed picomatch 4.0.7 has no bundled declarations; registry metadata confirms the corresponding DefinitelyTyped 4.0.3 package. Prefer maintained companion types over handwritten declarations or unchecked runtime imports. No new runtime library, glob grammar, security-policy exception, release-age exemption or SDK dependency is introduced. |
| D48 | Apply a tracked pnpm runtime/source patch to approved Ajv 8.20.0 so own JSON schema-map names, including `__proto__`, participate in property/pattern/additional/dependency validation; use null-prototype property/dependency/evaluation dictionaries and register the actual default ajv-formats plugin | Independent P2.2 reviews reproduced admitted standard constraints being omitted by Ajv's schema-map filter and missing comparison keywords when only format definitions were supplied. Preserve original schemas, local references, strict synchronous compilation, ownership and bounded errors: no key ban/rename, schema rewrite, unknown-keyword ignore, loader or policy exception. Keep published source and emitted compiler changes aligned and the patch before both frozen container installs; retain all-map/unevaluated/ordinary-property controls and plugin inclusive/exclusive boundary regressions, and remove the patch when a tested upstream version supplies faithful own-name support. |
| D49 | `validate` visits explicit files in argument order and immediate lowercase `.yaml`/`.yml` directory entries in sorted order, deduplicating resolved paths without recursive traversal. Parse all YAML documents, skip other kinds, and validate every `kind: Function` against the source resource schema then the shared pure validator, including unsupported Function versions as failures. Print one `OK`/`FAIL` line per decoded Function with a quoted single-line file path and validated name or document index; keep bounded file/parser/config diagnostics on stderr. Zero Function documents and usage errors exit 1; help exits 0. | The specification fixes validation and exit-on-error, not directory depth, empty-set behavior or line format. Deterministic non-recursive discovery avoids silently validating unrelated nested projects; fail-loud empty input prevents false CI success. Escape control characters and never echo native parser diagnostics, invalid field names, Function environment/input-schema contents or callback URLs. This changes no HTTP/security contract, schema rule, validation reason, command flag or cluster behavior. |
| D50 | Internal CLI consumers declare `@krun/shared` as a workspace dependency and import its built `dist` modules; recursive pnpm builds supply shared declarations/runtime before consumers. `make lint` depends on the normal build, retaining all existing no-emit/lint checks after dependency artifacts exist. | P2.5 is the first cross-package runtime schema/validator consumer. A clean checkout otherwise type-checks consumers before the `test` prerequisite builds shared declarations. Keep one source/implementation, native Node ESM and package-root build boundaries rather than duplicating schemas, importing shared TypeScript into the CLI output tree, disabling checks or adding a bundler. |
| D51 | Inspect reference keywords at JSON Schema nodes, traversing schema-valued applicators/maps/arrays (including unused definitions and legacy schema dependencies), not arbitrary instance/annotation data or map-entry names. Explicit local JSON Pointers also promote their targets to inspected schemas; keep the owned snapshot unchanged and compile with the same strict synchronous Ajv2020/plugin without a loader. | P25-C1 reproduces five valid schemas rejected by the old context-free object walk: ordinary `$ref`/`$dynamicRef` property/definition names and default/enum data were mistaken for reference keywords. Match the installed compiler's supported JSON Schema locations while preserving the local-fragment-only rule at every actual schema, including pointer-promoted data. Retain native good/bad controls, all own-name semantics, unused-definition remote-reference checks, size/privacy bounds and shared CLI/cache behavior. No key ban, schema rewrite, new dependency, unknown-keyword relaxation or reference/security-policy exception. |
| D52 | Build the public app as a scoped, non-listening factory over the existing Store, Functions and Keys services, exposed to descendant route plugins through native Fastify encapsulation. Require explicit method-scope/function-parameter metadata at route registration; use one tagged public ApiError with a closed reason union and the API section 4 mapping. Preserve the owning Effect context at callback edges and settle aborted request roots before closing dependencies. | P3.1a supplies infrastructure without placeholder implementations of P3.2-P3.7 methods or implicit public admin routes. Native encapsulation needs no extra plugin-wrapper dependency. Strict Zod request objects, an empty strict default query schema, pre-parsing authentication, generic hidden-function errors and canonical redacted failures implement the existing API contract; no public route, error reason, authorization policy, drain policy or non-goal changes. Root request objects are made strict without replacing authored nested opaque-data schemas; dependent owned objects remain strict in their authored Zod schemas. Reject duplicate Authorization fields using native raw headers because Node retains only the first normalized value. |
| D53 | Route bootstrap `frameworkErrors` through the same canonical public renderer as handler failures; classify malformed URL encoding and native parameter overflow as existing 400 REQUEST_INVALID. Strict root request objects may be wrapped only in Optional, ExactOptional, Default, Prefault, Readonly and NonOptional; normalize those inner root objects without changing authored schemas, checks, metadata or default getters, and reject other root forms at registration. Preserve an absent declared body through Fastify's undefined-to-null validator boundary with a private adapter marker. | Independent P3.1a reviews reproduce raw router JSON/path reflection and wrapped objects silently stripping unknown members. Use installed Fastify/Zod extension points, not parallel envelopes, native-message reflection, deep rewriting of opaque nested schemas or relaxed validation. Catch/nullable/transform/union/lazy and other unsupported root forms fail closed rather than silently bypassing the root-object invariant. Explicit null remains invalid, legitimate optional/default omission remains distinct, and no public method, status/reason, authorization/security policy or dependency changes. |
| D54 | Share HTTP correlation, bounded metrics and pino options between the public factory and admin app. Read an optional owning Config service (default info for isolated factories), never ambient env; a scoped LogDestination reference supports process/test sinks. A native Fastify LogController disables duplicate/default raw request logs, echoes validated IDs at incomingRequest and observes completion exactly once via its completion callback plus a deduplicated native finish fallback for bootstrap router failures. | P3.1b requires every response to echo X-Request-Id, including pre-routing failures that bypass ordinary hooks. Preserve a single nonempty HTTP-field-safe ID of at most128 characters; replace missing,empty,duplicate,oversized or non-wire values with UUIDv7 using the owning Effect Clock. Keep exactly the existing metric names/labels with404 mapped to unmatched and observe reply.elapsedTime in seconds using stable buckets. Public /v1 completion audits record authenticated key names (null for failed authentication),trusted-proxy IP and approved correlation fields only; optional request.audit supplies handler-created run metadata. Shared pino redaction removes sensitive structured fields and serializers omit raw URLs/headers/bodies/exceptions; request Effect logs replace the console logger with the same pino child and add active span IDs without raw causes. No dependency,flag,public method,security-rule,listener or request-span/exporter wiring addition. |
| D55 | Audit public membership from the registered /v1 template or an origin/absolute-form target with only its HTTP(S) authority stripped; preserve raw path segments rather than applying WHATWG dot-segment normalization. Extract fallback idempotency correlation only from an own bounded string query requestId, never a Run body member; explicit handler-owned request.audit remains authoritative. | Native sockets preserve absolute targets that inject normalizes, so origin-only prefix checks silently omitted required audits. docs/API.md defines CreateRun requestId in query, including correlation before handlers run; body extraction could publish rejected members. These are extraction repairs only, with native origin/absolute, unauthenticated, invalid-body and query/body conflict regressions. No public API, security-policy or dependency change. |
| D56 | Define public method contracts as reusable Zod route descriptors, with open response enum strings/known-value descriptions and separate FULL/BASIC shapes. Generate OpenAPI 3.1 through the installed Swagger dynamic plugin/provider transforms in a development-only scoped, non-listening documentation app. Documentation routes fail closed if invoked and are never installed in the production factory; future real method plugins consume the same descriptors. | P3.1c must document every normative method before P3.2-P5 handlers exist, without inventing working endpoints or acquiring Store, keys, cluster, config or exporters. Swagger registers before real Fastify route events;native parameter formatting handles literal custom-method colons. An isolated schema registry and canonical JSON make independent generation deterministic. The native converter hook preserves authored per-node descriptions/readOnly annotations with the isolated registry; unsupported conversions fail closed. A no-JSON-body 307 uses Zod never and transport projection because installed Swagger rejects an empty content object; the final 307 has no content schema. Transport headers/SSE/no-body 307 metadata describe the existing API, not new behavior. Keep Swagger as an existing development-only dependency; no security/API/non-goal or supply-chain changes. |
| D57 | Preserve opaque public JSON object identity with exact custom-leaf JSON Schema projection. Separate CreateRun writable validation from response schemas; per-field bidirectional codecs recognize and discard known output-only non-null JSON values while retaining the supported strict object root. | Independent P3.1c reviews reproduced record-parser own-key loss and response constraints rejecting ignored request members. Follow D42’s identity-preserving boundary, never rebuild opaque dictionaries or ban keys. Only explicitly supported opaque leaves have a projection; other unrepresentable schemas still fail closed. Read-only request values decode to absence, while real input, priority, callback, unknown-field and null checks remain strict. This restores existing API semantics, changes no security/API policy and adds no dependency or production method. |
| D58 | Implement Function reads as a composable real route plugin using the shared public descriptors, validated Function cache and authenticated principal. Snapshot only the parsed gateway input/result/wait caps supplied by the owning caller; do not read ambient configuration or start listeners. Use name-keyset cursors bound to method, key name and current grants, with canonical bounded base64url decoding; always reapply current Ready/glob visibility. | P3.2 needs real handlers before P3.7 owns process/listener composition. Valid zero installation byte caps are emitted as zero, matching the parsed configuration rather than an undocumented positive-only response constraint. Explicit parsed configuration preserves installation caps without enlarging the factory dependency contract or inventing per-Function settings. Versioned cursors are opaque navigation state, not authorization or snapshots; no new signing secret or expiry. Page size may change; missing/zero means 50 and values above 200 are capped. Whole-second maxWait is rendered as seconds, otherwise milliseconds, preserving parsed duration meaning. Hidden, missing and invalid definitions remain indistinguishable; an unsynced cache is 503 NOT_READY. |
| D59 | Apply the existing public Function int32 range to canonical maxConcurrency, maxQueued and activeDeadlineSeconds admission, preserving their existing minima and defaults. Generate the identical upper bound through Zod, editor schema and structural CRD/Helm artifacts; existing out-of-contract definitions become invalid and hidden rather than poisoning a public page. | Independent P3.2 reviews reproduced cache-valid values above 2147483647 causing GET and whole-list 500 serialization failures. This corrects permissive canonical validation to the already normative int32 resource contract, not a widening of public types or a new field/security policy. Do not clamp or discard configured values, weaken output validation, hide healthy neighbors or ban high installation ceilings: ceilings remain upper limits, while each admitted field must itself be representable. Regress exact maximum/outside bounds, real parsed non-default ceilings, Ready eligibility and native mixed-page isolation. |
| D60 | Compose CreateRun as a scoped real route plugin with caller-owned parsed limits/webhook policy and one Store notification consumer. Add the private Store.findRunByRequestId lookup (FULL row or absent, bound by key/function/request id) required before admission checks, and reuse the existing JCS requestHash helper. Per-replica token buckets use owning Clock time and per-Function admission serialization excludes response waits; DB uniqueness remains the cross-replica dedupe authority. Preserve exact 201/Location/replay semantics and register scoped wait queues before insertion, with Store hints and the specified one-second fallback under Effect time. | P3.3 cannot implement normative pre-validation replay with only getRun(id) and BASIC list queries. This internal Store extension is not a new HTTP method or security policy. Defaults are applied after hashing; no public schema widening, fake Store or raw gateway SQL. Zero caps are enforced with a native counted preParsing stream as well as declared length; authorization/scope precede rate, Function, content/type/size and parsing. The CreateRun-only native JSON parser retains own opaque JSON keys without prototype assignment; strict owned-root schemas still reject unknown/null members. All resource lifetime, insertion interruption, callback address checks and bounded rejection metrics require real regression evidence. |
| D61 | Classify cancellation from the actual HTTP transport: incomplete/aborted request or destroyed/closed unfinished response. Guard the native Fastify request signal against ordinary complete-body close. | Fastify5.12.7 request.signal listens to IncomingMessage.close without checking complete. On Node26 a successfully consumed native POST therefore aborts this signal before its handler; blindly propagating it interrupts every accepted native CreateRun despite green inject tests. Retain raw aborted, unfinished response close, app-stop interruption and finalizer joining. A permanent native HTTP POST regression plus native disconnect/persisted-row controls prove both sides; this is not an exemption from cancellation or drain policy. |
| D62 | Capture the owning Effect context for synchronous native CreateRun error-hook metrics, matching the existing HTTP metrics bridge. | A fresh Effect.runPromise in onError uses the default MetricRegistry rather than the explicitly owned telemetry registry. The strengthened isolated-registry regression reproduces missing input_size while the other three reasons count correctly; capture runSyncWith at plugin acquisition, retain bounded labels and prove all four reasons in both isolated unit and production-image native contexts. No global registry or exporter is introduced. |
| D63 | Enforce the current positive-priority grant after request decoding and before fingerprint/replay lookup. | P33-C1 reproduces an unauthorized replay-only exemption. docs/API.md and SPEC scope requirements override the non-normative skill order and an incorrect authored test. Schema, callback and quota admission still follow replay; authorized same-owner priority changes retain 409 and revoked positive-priority replay is 403 without mutation. |
| D64 | Preserve the complete public Unicode domain with a forward Postgres migration: Run.input uses native json rather than jsonb; an additive nullable bytea idempotency_key_nul plus its scoped partial unique index stores only request IDs containing U+0000, encoded reversibly as UTF-16LE. Ordinary and absent IDs retain the shipped text column/index. | P33-C2 reproduces jsonb/text rejection of valid escaped NUL values/keys and opaque IDs. Native json retains those escapes and pg decodes the original object; input has no SQL JSON-operator/index dependency. The disjoint NUL identifier domain cannot collide with ordinary text or printable escape strings; one trusted storage adapter serves insert, conflict retry and lookup and the infrastructure decoder restores the exact identifier. Preserve shipped0001, legacy data/indexes/writers and public/domain fields; append physical metadata only, with both-dialect migration/rollback/concurrency/legacy-writer and literal-wire tests. No truncation/replacement, request normalization, hashing-only identity, backend-specific client rejection, blanket DatabaseError remapping or API/security exception. |
| D65 | Compose GetRun/ListRuns from the real Store and current principal; keep persisted Run visibility independent of the live Function informer. Resolve actual stored function/owner before FULL or BASIC mapping. Set successful single-Run audit metadata from the authorized stored resource, never the wildcard path. Named list parents outside current globs are generic FUNCTION_NOT_FOUND; wildcard collections apply owner SQL scoping plus current compiled globs before visible page boundaries. Wrap opaque Store cursors with a versioned bounded canonical UTF-8/base64url envelope bound to parent, exact filter, key name and current grants. Expose a pure existing Store-cursor validator for the HTTP boundary. | P3.4 reads stored history, not Function resources: deleted/not-Ready/unsynced Function metadata must not erase accessible Runs. Fill visible pages in real BASIC Store batches no larger than remaining slots; after a full page probe ahead in bounded batches for another visible row before emitting a continuation, retaining the cursor after the returned page. This preserves keyset order, full page sizes, no hidden-tail token and no cursor reconstruction/raw gateway SQL; worst-case scans traverse the scoped stored history and remain request-interruptible between batches. Tokens are navigation, never authorization; current owner/globs always reapply. The pure decoder classifies malformed inner cursors as REQUEST_INVALID without mapping genuine DatabaseError to client error. No public fields, readiness/security exception, new dependency or later method. |
| D66 | Compose CancelRun under the existing scoped public factory and strict declared custom-method contract. Authorize current stored function/owner on every read; for queued/scheduled/running call the existing transactional Store.transition CAS to cancelling with an empty patch, null reason and event.actor set to the current authenticated key name. Re-read after both winning and losing CAS; cancelling/cancelled return canonical FULL, succeeded/failed return RUN_TERMINAL with current public metadata.state. | P3.5 must not synthesize success from a stale pre-CAS snapshot, perform raw gateway SQL, create another Store mutation API, finalize the Job synchronously or generate duplicate state events/callbacks on retries. A scheduler/peer may win between read and CAS; current state decides retry versus idempotent success versus terminal failure. The finite forward lifecycle and yield points between actual Store operations retain request interruption without timer polling or a replica-local mutex. Successful authorized stored-resource audit metadata matches Run reads; existing Function informer readiness does not erase persisted Run visibility. No public/security/non-goal or dependency change. |
| D67 | Compose GetRunResult through the existing public factory, real stored-resource authorization and canonical method schema. Keep only an optional effectful GET-presigner port at this boundary (reference plus literal300-second TTL), with no default fake implementation; concrete ObjectStore/S3 lifetime and credentials remain P6.1/process wiring. Check terminal state before presence, distinguish null from false/zero/empty inline values, and use the existing compiled response serializer explicitly for all JSON roots. For reference-only results validate the canonical stored S3 reference against its Run, call the port afresh and return bodyless307 with the exact validated HTTP(S),different-origin Location and no-store. | P3.6 explicitly requires fake-object-store acceptance before P6.1; the real route must not import nonexistent S3 services,add premature dependencies,proxy/HEAD the object,cache signing URLs,normalize opaque keys or gate stored history on informer readiness. Fastify5 bypasses the ordinary serializer for root strings,so use its already compiled Zod response serializer rather than return unquoted text or bypass owned schemas. Missing offload configuration,malformed persisted reference/target and signer/database failures are generic INTERNAL,not a false RESULT_MISSING. Presigned credentials never enter errors/logs; ordinary current owner/glob/parent privacy and wildcard audit identity remain unchanged. No public/security/non-goal change. |
| D68 | Add forward-only PostgreSQL0003_opaque_results to change only runs.result from jsonb to native json using result::json. Preserve shipped0001/0002,SQLite storage,all writer interfaces and shared pg JSON parsing. Existing setResult and transition-patch writes both infer their column type,so this one storage-domain repair covers every result persistence entrypoint without a sentinel or escape adapter. | P3.6 native PostgreSQL acceptance reproduced rejection of a documented valid non-null JSON string containing NUL in Store.setResult; matching SQLite and direct route cases pass. Native json,as already chosen for opaque input in D64,preserves escaped NUL keys/values and own JSON keys while remaining compatible with existing explicit-column writers/readers. Add both-dialect report/CAS regressions and real upgrade/data/history preservation controls;adapt only exact PostgreSQL migration-history expectations. No accepted public value is narrowed,existing migration rewritten,unrelated JSON-status schema changed,or dependency/security/API policy changed. |
| D69 | Enable GET entity parsing through Fastify's supported addHttpMethod override in the shared public factory, retaining its bounded parser, existing error mapping and strict Zod empty-object boundary before all GET handlers. A GET with no framed entity remains omission even with application/json headers or Content-Length zero; unsupported media types still reach the existing authenticated check. | Native P3.6 review reproduced Fastify's default bodyless-GET bypass for unknown owned fields, literal null and malformed JSON with both Content-Length and chunked framing. Repair the factory, not only GetRunResult. Permanent real SQLite/PostgreSQL socket matrices cover all current sibling GET methods, inline/offload signing isolation, omission/empty-object controls, body caps, auth/scope ordering and media-type envelopes. No raw unbounded collector, parser dependency, relaxed owned schema or public-policy change. |
| D70 | Validate presigner output as an explicitly authority-qualified HTTP(S) URL and compare client redirect resolution against the standalone target origin before returning the original exact Location bytes. Retain different-origin, userinfo/control-character, bodyless307/no-store and literal300-second checks. | Standalone new URL accepts same-scheme authority-less/single-backslash forms that a redirect client resolves as a gateway-relative path. Reject this malformed adapter output as generic INTERNAL before setting Location; never normalize a signed path, percent escape or query. Permanent rejected-form and exact encoded-query controls plus real native manual/automatic-follow cases cover the ambiguity without proxying, following or logging signing data in application code. No public/security policy or ObjectStore scope change. |
| D71 | Assemble the gateway from real scoped Config, Telemetry, Database/Store, readiness, Kubernetes LIST/WATCH Function cache, keys and separate public/internal/admin listener layers under NodeRuntime.runMain. Keep schema migration in the existing explicit migrate/init command; validate Store access before readiness. Start listeners without waiting for Kubernetes initial LIST, so admin liveness and unavailable readiness remain observable. Register one drain above all listeners: mark draining, wait the configured fixed delay once, then close transports before dependencies. Map pure interruption to exit0 and failures to exit1, suppress raw runtime cause diagnostics and arm a finalizer-owned25-second last-resort watchdog. | P3.7 replaces a finite scaffold, not the HTTP contracts or scheduler. Reuse existing concrete route/cache/key/store/health/telemetry implementations and native client cancellation. An internal listener with only canonical not-found handling reserves isolation; actual internal methods remain P3.8. No automatic per-replica migrations, readiness shortcut, custom signal handlers, production kube context in tests or premature S3 signer. Keep gateway --help finite and update only obsolete finite gateway smoke assertions; scheduler is unchanged. |
| D72 | Share one scoped gateway shutdown signal and native response tracker with existing CreateRun waits. At the end of the drain delay complete that signal, let waits re-read their current stored Run and finish their201 response, then close listeners and cancel remaining work. Preserve disconnected-request interruption, response finalizer settlement and the existing wait timeout/notification behavior outside shutdown. | P3.7 must answer already implemented CreateRun waits during graceful stop rather than cancelling them into generic500 or waiting the full maximum timeout. Track native finish/close events, not timer polling, and keep the Store usable until response completion. This does not implement later WaitRun/SSE methods or add public fields or new request options. |
| D73 | Register CreateRun responses before admission/semaphore/Store work, not after commit. Seal registration synchronously before the shutdown response snapshot; after the configured grace, reject unregistered admission with existing NOT_READY before mutation while previously owned responses settle against live dependencies. Route internal constructor framework errors through the same existing sanitized error mapper as ordinary internal and public errors. | Independent P3.7 reviews reproduced a PostgreSQL transaction committing across drain and returning INTERNAL, plus malformed internal paths bypassing the canonical envelope. Native pre-commit lock, post-seal rejection and malformed percent/UTF-8 regressions cover these ownership/transport boundaries. Normal grace serving, real client-disconnect cancellation, public schemas and security policy are unchanged. |
| D74 | Preserve the complete documented internal JSON domain with forward PostgreSQL0004_opaque_reports: runtime_status, error and event/delivery payloads use native json. Add an additive nullable runtime_status_at timestamptz projection, backfill shipped status timestamps and invalidate it on every status UPDATE with a database trigger. New writers republish it in the same row-locked transaction. listStale prefilters by start/projection and decodes authoritative status.at in the application for candidate rows, including legacy writers with a null projection. SQLite and domain/wire fields stay unchanged. | Native P3.8 tests reproduce jsonb rejecting escaped NUL/unpaired Unicode in otherwise valid status/error documents, and PostgreSQL JSON extraction decoding unrelated opaque fields even when selecting only at. A physical timestamp projection keeps heartbeat queries independent of opaque Unicode; pg retains existing JSON decoding. Preserve shipped migrations, rows, callback/error precedence and Store signatures; verify rollback/retry, legacy-row backfill and terminal event/delivery payloads. The invalidation trigger covers old writers without changing their SQL; the null-projection fallback preserves opaque Unicode rather than reintroducing PostgreSQL JSON text extraction. Verify mixed-writer freshness and rollback if projection publication fails; no public/security-policy narrowing or replacement characters. |
| D75 | Mount four real internal contracts on the separate scoped Fastify instance. Authenticate the current accepting Run by SHA-256/timingSafeEqual before media/cap/validation; guarded Store writes enforce state again. Serialize only same-run status attempts and start a replica-local one-second window after a successful write; use Effect time for receipt and deadlines. Bound each internal Store call to five seconds, including pool acquisition, via a call-local cancellation signal; use pg query_timeout5000 plus server statement_timeout5000 for these calls only and settle rollback/release before returning. | P3.8 cannot safely implement a timeout by abandoning an uninterruptible Store promise: the locked write can still commit. Preserve the shared five-connection pool and ordinary10000ms driver default, reset statement timeout on ordinary reservations, cancel active server work on deadline and release late pool acquisitions without executing SQL. Own Kysely driver cancellation/settlement rather than its background-error-printing high-level cancellation API. Header-only and chunked native tests verify unread cap rejection and connection closure; close unread failed-auth transports too. Keep internal work serving during configured drain and settle active bounded calls before dependency closure. No extra Store methods, dependencies, API keys, production context or publication. |
| D76 | Build P4.1 Job/Secret resources as pure functions over the validated Function, Run identity and parsed scheduler configuration. Return Effect Result with a bounded field-only ManifestInvalid for invalid resource identity/token/duration, not thrown input-bearing diagnostics. Inject the existing per-run token and optional already-presigned PUT URL; do not generate credentials, sign URLs, acquire services or call Kubernetes in builders. Preserve optional-field omission, exact env order and independent output snapshots. Express heartbeat milliseconds as exact seconds, including a fractional remainder, rather than truncating a valid Function duration. | Keeps manifest construction independently golden-testable and ready for the later Secret-before-Job orchestration without implementing it prematurely. Reuse existing Zod identity and configuration schemas and native client-node models. Native client serialization and goldens cover hardening, defaults, user namespaces, selector copying and absence of input/plaintext tokens. Only test fixtures mask ephemeral token data; actual Secret data contains base64 of the injected base64url token. No manifest extras, API/security-policy changes or new libraries. |
| D77 | Implement P4.2 as an interruptible Lease API layer over the existing KubeConnection and a scoped runLeaderElection effect accepting the leader-only resource acquisition program. Fix Lease duration/retry/renew-deadline at 15/2/10 seconds. Candidates, including same-pod-name restarts, observe a held Lease for a full local-clock interval; only holderIdentity or renewTime changes reset that observation. Known holder loss fails immediately. An independent renew watchdog covers stalled calls and leader initialization, cancels leader-scoped resources and fails LeaderLost; no process.exit or polling of work state. Release reads ownership and resourceVersion again, closes work before clearing our holder, and is one bounded best-effort attempt. | Keeps every future leader-only informer, loop and status writer owned by one scope without implementing those later components or scheduler serving prematurely. Reuse real CoordinationV1Api object methods, per-call Observable signal middleware and dispatcher destruction, existing sanitized KubeApiError, Readiness leader state and Effect Metric gauge krun_scheduler_leader. DateTime supplies native Date timestamps; Clock supplies elapsed deadlines, never remote timestamp age. Pod name is an explicit validated argument from future process wiring; no new environment variable or configurable election constants. Lost leadership propagates a typed failure for NodeRuntime.runMain to exit nonzero; interruption releases cleanly. Native process probes use the existing gateway-style teardown to map interruption to zero, since the installed runner default returns 130; future scheduler process wiring must retain that explicit exit policy. No public/API/security-policy or dependency-pin changes. |
| D78 | Adapt the installed client-node 2.0.1 Lease MicroTime boundary without changing dependencies: its V1LeaseSpec advertises V1MicroTime extends Date, but generated ObjectSerializer does not register that type and returns the wire timestamp string unchanged. LeaseApi validates either a finite native Date or an ISO timestamp string; expose that private read-result union, compare timestamp strings at full precision for observation, and keep outgoing replace/create bodies native V1Lease with DateTime-produced timestamps. | The first real loopback GET failed the Date-only boundary although stubbed Date tests passed. Converting every timestamp to milliseconds would also miss microsecond-only renewTime changes and could expire a live Lease early. Retain raw valid string precision for equality, never compute elapsed age from remote time; no custom timestamp parser, unsafe type assertion, library substitution, release-age exception or owner-policy change. Native transport plus microsecond-change regressions gate this adapter. |
| D79 | Implement P4.3a as a native scheduler Kube service over the single existing KubeConnection and a leader-local creation policy built from Effect Clock/Ref/Metric. Share interruptible native middleware/dispatcher cleanup with Lease calls; wrap permit wait plus request in named spans. Preserve API Status message/reason only in a private WeakMap keyed by the sanitized KubeApiError, exposed explicitly for the documented permanent RunError projection; never attach response bodies/headers/messages to serializable errors or span attributes. | The installed ApiException.message embeds the complete body and headers. Status projection is required by SPEC8 but automatic Effect failure tracing/logging must remain credential-safe. Retain only validated Status strings and Retry-After privately, detect quota403 from Forbidden/exceeded quota, count create failures at the explicit policy boundary, classify create409/AlreadyExists for later adoption, and return capped per-function exponential backoff plus a separate interruptible429 pause for later loop lease-release ordering. No automatic API retries, Store transitions, scheduler process composition, new dependencies, public/security-policy changes or owner-only publication. |
| D80 | Decode the native client-node ApiException body when it is a JSON string before validating the private Status message/reason view; keep already-decoded object support and reject malformed bodies without leaking raw text. | Actual P4.3a loopback422 returned Unknown/fallback despite a valid JSON Status: installed ResponseContext.getBodyAsAny explicitly returns body.text(), not parsed JSON. Direct-object stubs hid the mismatch. Regress through real create Secret/Job requests for503/422/quota403/429, keep Retry-After normalization and sanitized failure/span channels; no native client replacement or schema-policy change. |
| D81 | Repair P4.3a by placing the shared semaphore acquisition inside the existing ten-second Effect.timeout, so queue wait and native execution consume one call budget. Check the Effect Clock again after acquiring a permit to prevent native dispatch when permit release races the deadline tick; expired/cancelled waiters never gain a new request budget. Retry-After HTTP dates accept IMF-fixdate, RFC850 and asctime forms, explicitly normalized to UTC with the RFC9110 two-digit-year rule relative to Effect Clock; preserve delta/default/cap behavior. | Independent C1 native/clock tests show queued calls exceeding ten seconds under saturation; C2 native host/image tests show valid obsolete HTTP dates incorrectly falling back to one second. Correct the shared boundary and HTTP-date compatibility without changing public API, security policy, dependencies, worker settings, loop/Store scope or election constants. Add permanent queue-budget/no-late-dispatch and date/year-window/UTC regressions, rebuild the runtime image and re-exercise both Kube and Lease call paths. |
| D82 | Implement P4.3b as a leader-local main-loop constructor over the actual Store, Functions cache, Kube and P4.3a creation policy. One scoped loop consumes a sliding capacity-one wake queue fed by state notifications and the specified one-second ticker; one shared gate serializes iterations, including Retry-After pauses outside the iteration deadline. Count/expire precede capacity/claim; retain only already-known failed/interrupted expiry or false-mark cleanup as leader-local cleanup debt, retried after countByState without listing Jobs or terminal database rows. Non-create429 responses reuse the date parser and pause after claim release without incrementing creation counters. Preserve Secret adoption and hash-before-Job order; a required cached-handler replay capability invokes the later informer handler after successful markScheduled, without adding informer construction or a second terminal-state implementation here. | Keep the finite process scaffold and P4.3c/P4.4/P4.5/P4.6/P4.11 wiring out of this slice. Track unscheduled claims before interruption can lose a completed claim result, release them on every iteration exit, check the Effect Clock between steps and runs, and retain Store transaction settlement semantics rather than abandoning a late database write. Bound interruptible cleanup attempts, preserve the existing driver bounds for uninterruptible Store transactions, sanitize loop logs and carry run correlation in schedule-run spans. Use actual Store transitions for permanent failures and queue expiry so events/deliveries remain atomic. No API/security/non-goal, dependency or worker-policy changes. |
| D83 | Preserve P4.3b successful-scheduling replay ownership atomically with markScheduled settlement, before forgetting the claim. Keep leader-local known replay debt until the interruptible cached handler completes; drain it after countByState in a later active iteration if deadline, handler failure or interruption prevented completion. Preserve operation provenance during Secret adoption: GET failures use the non-create path, never creation counters or function creation backoff; GET429 still releases claims before the existing global Retry-After pause. | Repairs independently reproduced C1/C2 without starting work in teardown, masking arbitrary handler work, deleting scheduled Jobs, adding an API re-read or terminal-row scanner, changing public/security policy, or composing future informers/processes. The count snapshot remains conservative if replay frees capacity. New leader terms start fresh and retain the specified later informer initial reconciliation contract. |
| D84 | Implement P4.3c as main-loop step 5 after scheduling: read cancelling runs in bounded KRUN_MAX_RUNNING batches, delete each Job with explicit foreground propagation, delete its Secret, then compare-and-set cancelling to cancelled with null reason and an empty patch. Drain further batches while the existing iteration deadline permits; check the Effect Clock between reads, runs, deletes and the transition. | Reuse the real Store terminal transaction for timestamps, events, notifications and callback delivery; native deletes already treat 404 as success. A failed/interrupted deletion leaves the row cancelling for retry; a losing terminal CAS never overwrites the winner. Cancellation is independent of Function readiness/existence and can drain a backlog larger than running capacity without unbounded reads. Reuse the non-create429 pause and typed-error privacy paths; add correlated scheduler.cancel_run spans without new metrics. Keep process/informer composition and whole-phase e2e separate; no API/security/non-goal/dependency changes. |
| D85 | Isolate non-global cancellation resource/terminal-write failures per run, retaining the affected row as cancelling and attempting it at most once per iteration. Keep normal bounded active-prefix draining; after a failure or unchanged attempted prefix, traverse the existing state-filtered listRuns keyset pages instead of re-reading the poisoned prefix. Retain only one pending page and its cursor within the leader term across iteration deadlines, advancing past an attempted row before interruptible resource work. End each fallback sweep at its captured cursor boundary before retrying failed rows in a later iteration. | Both P4.3c reviews independently reproduced persistent oldest-row Job/Secret deletion failures starving healthy rows with batch size one. Bounded cursor progress prevents prefix starvation and hot-loop retries without a new Store API or unbounded read; concurrent newer cancellations wait for the next sweep, and interrupted/failed rows remain discoverable for retry. Keep explicit foreground Job then Secret then actual Store CAS, sanitized run-correlated warnings, global429 pause, leader interruption and Store transaction settlement. No public/security/non-goal/dependency changes. |
| D86 | Use client-node 2.0.1’s public ListWatch constructor (the cache implementation selected by makeInformer), with a scoped Watch subclass and native typed LIST clients, for the leader’s Job/Pod informers. Gate sync only after each LIST has been applied to that cache, including empty lists; never on its pre-LIST connect event. The owned transport shares the scheduler limiter and ten-second LIST/watch-handshake budget, authenticates through the installed KubeConfig, aborts pending acquisitions/requests and streaming bodies on leader-scope close, and destroys its dispatchers. Watch bodies are leader-scoped streams, not ten-second request acquisitions. Run reconnect delays on Effect Clock, preserve native resourceVersion/410 cache behavior, and restart stopped attempts with bounded backoff. | Installed makeInformer cannot accept a scoped transport: stop aborts only an already-returned watch controller, not its pending LIST/authentication/handshake, and connect fires before LIST. Its public ListWatch/Watch extension points preserve the real native informer/cache without private-field mutation, global monkey patches, a dependency version change or a false initial-sync signal. P4.4 retains native HTTP lifecycle tests. |
| D87 | Resolve inline-result precedence over a checked result_ref atomically in the existing Store transition CAS: a non-null inline result excludes the object reference from the updated row and its transactional callback. Preserve explicit patch-result semantics and JSON-null absence in both dialects. | P4.4’s result HEAD can race a function result accepted while the run is still active. A second pre-CAS read cannot close that race; SQLite/PostgreSQL failing-first contracts reproduce the otherwise simultaneous result/resultUri, which the existing public contract forbids. No Store method, schema or public API is added. |
| D88 | Retain one compact outstanding terminal deletion observation per run in the leader-owned controller before queued-state gating or fallible Store/object work. Retain only Job terminal conditions/start time and the relevant Pod metadata/status, never spec/env; merge later Pod deletion observations, include retained IDs in replay/reconciliation and serialize them with live events. Prune on successful ordered cleanup, resolved cancellation/orphan disposition, or scope close; never evict unresolved work on a retry error or an arbitrary timer. | Both P4.4 reviews reproduce a deleted Complete lost before markScheduled or after a transient result check, despite native cache/event correctness. The cache cannot resupply an evicted Job. Outstanding-work retention, not historical-object caching, closes both paths without Kubernetes rereads, a Store API/schema change, or teardown replay. Its population follows unresolved observed runs rather than run history; discarding old debt merely to cap the map would recreate the loss. Restore the existing terminated-container then Job startTime fallback and cancelling status-only contract unchanged. |
| D89 | Implement P4.5 as a required cache-backed main-loop step-6 capability and the same controller initial/five-minute reconciliation check. After both processed LISTs, use exactly listByState([scheduled,running], KRUN_MAX_RUNNING), canonical native cache lookup and leader-local Clock first-absent times with a full two-minute grace. Share the existing per-run gate; cached/retained terminal observations belong to the informer path, never job_lost. Job ADD/UPDATE envelopes retain only a presence flag so a processed reappearance clears the grace even when its following DELETE has already evicted the cache. A loss CAS patches only its classification and krun fallback error, leaving accepted result/reported error to existing Store semantics. Atomically remember a compact Secret-cleanup target with settled winning CAS; retry only Secret deletion in active passes, never during teardown or by reclassifying another terminal winner. | Bounded first-absence records are pruned when a Job reappears or a run leaves the current active selection; known cleanup debt survives removal from active Store lists. Serialize concurrent main/reconcile passes, isolate per-run failures while preserving the main-loop global 429 path, and clear leader-owned maps on scope close. Advance a bounded-selection cursor and rotate cleanup debt before interruptible work; active checks precede retry-only debt and no Secret is retried twice in a pass, preventing a poisoned deletion from pinning later runs across iteration deadlines. No new Store method, schema, dependency, Kubernetes reread, terminal-row scanner, Job deletion or public/security/non-goal policy change. Production process composition remains P4.11. |
| D90 | Fence P4.5 loss decisions with leader-scoped per-run Job observation generations registered synchronously by native LIST/watch add/update/delete callbacks before enqueueing. Each envelope carries its generation; a single latest-pending generation per run stays visible independently of a blocked stream consumer. The controller acknowledges only that exact generation, synchronously after resetting observed presence and retaining any terminal deletion in D88 work, before fallible Store/object work. An older acknowledgement cannot clear a newer observation. | Received reappearance or Complete must not lose to an old first-absence grace merely because another run blocks the ordered consumer. Pending observations reset/defer only their own run, are checked again after the fresh Store read and immediately before dispatching the loss CAS, and have no timeout/cap that silently discards terminal knowledge. Safe handoff prunes the latest entry; leader-scope close clears pending generations without replay. This is compact ownership metadata, not another object/history cache, a global handler barrier, polling or a Kubernetes reread; it is not a cross-system transaction that cancels an already-dispatched Store CAS on a later observation. No public API, schema, dependency, security or non-goal changes. |
| D91 | Record leader-owned lifecycle telemetry from the exact decoded rows returned by successful committed markScheduled, transition and expireQueued transactions, through an Effect-local observer that defaults to no-op. Only the leader main-loop/controller Store views enable it; the shared gateway Store never emits scheduler metrics. Update the five P4.6 metric families with only SPEC labels, using persisted lifecycle timestamp differences in seconds. Ignore stale/rolled-back writes and same-state status events; a terminal row with a recovered start timestamp may supply run duration without fabricating a running transition or cold-start sample. | Post-read instrumentation can fail after a committed CAS, double-count retries or use a later concurrent row. A post-commit, uninterruptible observer uses no extra read, scanner, durable telemetry cursor or schema/API change; metrics remain process-lifetime best-effort signals, not an exactly-once audit across crashes. Publish countByState from the same first-loop snapshot, zero previously present missing pairs, and clear owned gauges on leader-scope close without replay. Multi-run iteration spans keep no misleading single run id; existing per-run child spans carry krun.run_id and correlate with request/native spans without storing or joining trace context. Production composition remains P4.11; failure-specific metrics remain P4.8. |
| D92 | Complete P4.6 request tracing at the existing native Fastify LogController boundary: create a server span with the routed template (unmatched when absent), parse a single valid W3C version-00 traceparent in house and ignore invalid/zero/multiple values, carry that span into every request-runner Effect, and end it exactly once on response completion or transport close. Late CreateRun audit metadata supplies krun.run_id at completion; internal/run routes use their path id. | Existing HTTP metrics/audits alone did not implement request spans or propagation. The boundary covers authenticated handlers and pre-handler errors without wrapping each route, exposing raw URLs/bodies/credentials, adding a propagation dependency or joining scheduler traces. Admin probes/scrapes have no request span. Run-specific scheduler spans remain children of the aggregate iteration, not one cross-process trace; no trace metadata is persisted or sent to Job env. |
| D93 | Before attaching HTTP krun.run_id, validate the already-selected audit/path correlation value with the existing Zod UUIDv7 Run identity contract. Omit an invalid selected value; do not normalize it, repair it or fall back to another path value after validation fails. Preserve valid identities exactly, including on denied requests, while leaving route templates, response status, incoming traceparent and span lifetime unchanged. | P4.6 contracts review P46-C1 reproduces arbitrary malformed route data exported even on unauthenticated401 responses. Shared completion validation fixes both public/internal path and late audit sources without changing HTTP admission, public schemas, existing audit-log policy, metrics or tracing ownership. Permanent invalid/valid/precedence controls and native sockets on both Store backends verify the telemetry privacy boundary. |
| D94 | Implement P4.7 as an explicitly leader-scoped Function status writer over a separate capability returned by makeFunctions, without adding writer methods to the gateway-facing Functions service. Broadcast bounded, replay-one invalidation signals, never a queue of historical Function documents; every pass reads the current complete cache, including invalid Functions, and refreshes each entry before dispatch. Compare observedGeneration and Ready type/status/reason/message with the cached status; patch only the desired status through the shared bounded/cancellable native CustomObjectsApi transport with an explicit JSON Merge Patch content type. Include UID and resourceVersion preconditions so an old generation or replacement cannot receive a stale validation result. | A successful patch acknowledges only its exact input UID/generation/resourceVersion until a newer cache observation arrives, suppressing repeated pre-echo inputs without a permanent last-written-status assumption. Every new resourceVersion is compared against the real cached status, so status erasure or external drift is repaired; failures acknowledge nothing and do not starve other Functions. Prune acknowledgements on deletion/replacement and scope close. The change stream replays a wake-up before its initial cache pass and coalesces later events, avoiding promotion/subscription gaps without a second informer, polling or retained resource bodies. Writer run/reconcile capabilities stop at scope closure; next cache event or explicit leader reconcile retries failed writes. Production process assembly remains P4.11; no new Ready reason, timestamp, public/schema/security policy or dependency. |
| D95 | Complete P4.8 with one bounded leader-local log capture per run, a ten-second interruptible capture deadline in addition to the native transport budget, and UTF-8-safe truncation that never exceeds the 16 KiB stored-tail cap. Keep only the captured string and first observed container exit time until disposition; carry an early tail through job_lost, and clear both observations on cleanup, cancellation, Store-row absence or leader-scope closure. | Publish krun_runs_failed_total from the existing post-commit RunChange observer using only the exact committed failure_reason, including queue expiry, provisioning failure and job_lost. A fiber-local optional TerminalExitAt reference supplies known container exit time to that same observer; sample krun_terminal_detect_seconds after a successful terminal commit against Effect Clock, with only the function label and no invented sample when the exit is unknown. False CAS, rollback, status-only and plain gateway Store calls emit neither failure nor detection samples. Existing failure/error precedence and atomic Store writes are unchanged; no extra Store read, public/schema/security-policy/dependency change or production assembly claim. |
| D96 | Implement P4.9 as a leader-scoped, non-overlapping ten-second heartbeat component behind the Job/Pod LIST readiness barrier (and the Function cache sync), using the existing `Store.listStale` and validated Function durations. Trace every synchronized pass, including empty/fresh/error/debt passes, with an aggregate span without a run ID and correlated per-run child spans. Share the Job controller's per-run gate and bounded log reader, refresh the current same-UID Function validity/timeout before each candidate and again after log capture (recomputing its cutoff/message), recheck current Store freshness and terminal/pending native observations, then await the native foreground DELETE acknowledgement before the running-only terminal CAS and Secret deletion. Retain only leader-local post-DELETE CAS/Secret debt so vanished Pods, informer deletion events or a removed timeout cannot steal or strand that already-started disposition. SQL publication and debt flags settle together without masking Kubernetes cancellation; false CAS yields to its winner, and only the committed observer counts a heartbeat failure. Read-only Functions/gateway and public Store/Kubernetes ports stay unchanged. P4.11 owns starting this component in the leader scope; fake native HTTP verifies request ordering/abort, not Kubernetes garbage-collector completion or the later whole-phase kind gate. | An independent timer/controller could let its own foreground deletion be reclassified by the informer, lose a pending CAS when both cached objects disappear, or repeat publication while retrying a Secret. Bounded ephemeral debt and the existing per-run gate close those in-scope races without a new database operation, durable claim or production assembly ahead of its task. |
| D97 | Implement P4.10 as an immediate and then ten-minute, non-overlapping leader-scoped sweep behind Job/Pod initial LIST readiness. Freeze one Clock-derived retention cutoff per pass; drain existing Store.sweep in batches of 1000 and publish only committed run deletions, atomically with each settled batch, to krun_sweep_deleted_total (no Secret count or run labels). Then page native label-selected Secrets in the jobs namespace through the existing shared bounded connection; delete only valid, strictly older-than-one-hour metadata with no current/pending cached Job, fencing Secret identity with UID/resourceVersion preconditions. Recheck cache presence after permit wait; skip malformed/replaced objects, isolate per-Secret failures, stop further acquisitions on 429, and retry failed passes at the normal interval. Trace sweep and native calls without Secret data, tokens or continuation cursors. Keep Store/Kube public ports and RBAC unchanged; P4.11 owns production assembly. |
| D98 | Assemble P4.11 from one scoped Config/Telemetry/Database/Store/shared Kubernetes connection, process-wide Function cache and admin server, then the existing Lease election with a leader-only Job/Pod/controller/main/heartbeat/sweep/status graph. Add scheduler-only KRUN_POD_NAME, supplied by downward API metadata.name and required by the serving process (optional only for isolated component configuration); never infer identity from a hostname. Reuse the approved Fastify dependency for the process logger. Gate claiming behind Function and both Job/Pod initial LISTs, keep standby readiness independent of leadership, propagate elected-work/renewal failures to process exit, and mark draining before cancellation. Use the election outer pre-release cleanup hook so the process Function informer closes after leader resources and before Lease release even when cancellation prevents leader-work entry; close admin and Store before telemetry; apply the existing25-second watchdog and sanitized teardown. | P4.11 composes real existing ports, not a second scheduler. Explicit migrations remain separate. Disabled object storage returns no external result; configured storage fails the existing ResultCheckError boundary until P6.2 supplies its real adapter, never fabricating not-found. Webhook delivery remains P5.3 and actual kind/admission/Job execution P4.12/P4.13. No public API,security/RBAC,release policy or new library family changes. |
| D99 | Build P4.12 as an isolated disposable kind foundation pinned by .kind-version to v0.33.0 and its published Kubernetes 1.37 node digest, using the same SHA-pinned helm/kind-action installer locally/CI version contract. Follow the registry:2 localhost:5001 recipe with per-node containerd hosts.toml and local-registry-hosting ConfigMap. Scope every kubectl call to a private kubeconfig and kind-krun-test-e2e context; fence the fixed kind-registry name with an ownership label before reuse or deletion. | Use the existing hardened local image for both embedded processes and a real open/deny/reopen pod-network probe, accepting only explicit client outcomes and failing on Kubernetes/exec errors. Keep the mandatory foundation verification before the zero-scenario Vitest runner. Raw namespace/RBAC/network/resource policies mirror section 9; generated credentials remain private and never enter logs. Normalize native Lease Date write fields through client-node V1MicroTime so the real API accepts six-digit timestamps while read strings retain precision. This adds infrastructure tests, not P4.13 behavioural scenarios or a whole-phase acceptance claim. |
| D100 | Prove P4.13 with five separate native-kind scenario files over the P4.12 embedded foundation. Build four tiny shell entrypoints FROM a digest-pinned curlimages/curl image and push only to the owned localhost registry; use an absent local digest for the pull/deadline case. Keep Function v1 shape unchanged: it has no command/args override. | Observe native Pods from an anchored LIST resourceVersion through raw WATCH so fast terminal events cannot disappear before the witness; preserve missing/null never-started timestamps as unknown,never invent exit time. Verify public FULL Run results/statuses,sub-ten-second exit detection against native finishedAt,60-second pull deadline and30-second heartbeat within60seconds with positive Job-existence/deletion proof. Use bounded tri-state reads,fail closed on API/watch errors,check generated-data/credential absence in process logs and Pod manifests,and clean per-file owned Functions/Jobs/Secrets/Pods and kubectl children. P4.12 enforcement remains mandatory and the runner now rejects an empty suite. No application behaviour,public API,security policy,new dependency or release/publishing authority changes. |
| D101 | Complete P5.1 by sharing the existing scoped CreateRun notification consumer and per-Run sliding wake-up queues with WaitRun in the same route plugin. Register before insert/read, re-read authoritative Store rows on hints or the mandatory one-second fallback, and race bounded waits against the existing gateway shutdown signal. | Preserve 201 CreateRun and 200 WaitRun responses at completion, timeout or graceful shutdown; cap/default waits with KRUN_MAX_WAIT and authorize stored function/owner on every WaitRun read, including wildcard/deleted Function history. Accept omitted WaitRun bodies as the existing optional contract specifies. Keep one Store subscription, scoped queue cleanup, retry on subscription failure and existing native response tracking. No new service graph, dependency, public field, security-policy change, SSE or webhook behavior is added. |
| D102 | Implement P5.2 WatchRun in the existing CreateRun/WaitRun route plugin, sharing its single scoped Store subscriber and per-Run sliding wake queue. Register before the first authorized read, then stream canonical toRunSummary BASIC snapshots through the declared WatchRun contract using raw SSE after hijack. | Compare state, runtime-status report time and semantic job-status fields (excluding observation-only time); emit changed status/job groups before a terminal state so every observed changed group is delivered before EOF. Use each group's own timestamp, Effect-clock read time only for CANCELLING, the mandatory one-second authoritative fallback and an independent15-second Effect keepalive. Preserve stored-owner/function checks on every read, canonical pre-header errors and close-only failure after headers. Scope transport, timers and queue cleanup to the request; race streaming against the existing shutdown signal and apply bounded serialized drain handling for backpressure as corrected by D103. No second notifier, new dependency, public field, security-policy change or webhook behavior. |
| D103 | Repair P52-C1 by treating native write(false) as an accepted buffered frame, not proof of a slow client. Serialize SSE writes with one request-local semaphore, await native drain before producing the next frame, and bound each drain wait to two Effect-clock seconds. Race the entire stream, including the initial snapshot write, against gateway shutdown; cancellation, transport error/close or a drain deadline destroys only the owned response and removes all wait listeners. | A legal BASIC JobStatus message can exceed the native high-water mark; normal clients and reconnects must still receive that initial snapshot, including terminal-at-connect EOF. A genuinely non-reading client remains bounded without unbounded queued writes, replaying a frame, changing public schemas or weakening shutdown/security policy. Keep per-Run hint coalescing and the independent keepalive, but serialize its bytes with data frames. Add native normal-large-reader/reconnect and paused-reader deadline/shutdown regressions; no dependency, public field, configurable policy or webhook change. |
| D104 | Implement P5.3 as one scheduler leader-scoped delivery component alongside existing controllers. Claim 40 rows, await every batch with eight concurrent P2.1 pinned POSTs, and immediately re-claim after a full batch; repeat short passes every five Effect-clock seconds. Empty configured host allowlist disables claims. Use stored BASIC snapshots, one encoded buffer for each attempt's HMAC and POST, fresh attempt span/traceparent and the existing ten-second transport deadline. Persist the five fixed failure delays and dead after the sixth failure; interruption leaves leased pending rows unchanged. | Reuse existing Store leasing/update methods, parsed scheduler configuration, P2.1 DNS/pinned transport and signer without a second HTTP client or in-memory retry queue. Serialize passes with one gate; component scope closure interrupts active sends and awaits their resource/write cleanup. Failure to persist one outcome leaves its lease for replay and does not cancel the other attempts; only committed updates increment krun_deliveries_total with state=pending/delivered/dead. Logs and last_error use bounded failure discriminants/status only, never URLs, payloads, response bodies, signatures, secrets or native error causes. Leadership, shutdown, persistent retry and native receiver tests are required; full Phase 5 kind wait/signed-webhook gate remains P5.4. |
| D105 | Fence P5.3 delivery outcome writes by the exact claimed pending row: expected attempt and leased next_at. Extend the existing internal updateDelivery method with an optional expected-claim argument and return whether a row actually changed; the delivery worker always supplies its claim and only applied writes publish state counters. Legacy unguarded internal calls retain their existing update semantics, with the new boolean result safe to ignore. | A delayed old owner can outlive the nominal network batch bound, and retention can remove a row during HTTP. Use a single conditional UPDATE/RETURNING in both dialects, not a read-before-write or an assumption that every batch always finishes within 60 seconds. The existing next_at lease is a generation token: a re-claim is due only at or after the old value and writes now+60 seconds, so its generation is strictly newer without a schema migration. Keep POST cancellation and interruption-safe settled writes; missing/stale outcomes return false without metrics. This is an internal persistence correction, not a public API, DDL, retry, security or phase-gate change. |
| D106 | Implement P6.1 as a scoped ObjectStore S3 adapter with explicit parsed endpoint/bucket/region/static credentials. Use one force-path-style client with WHEN_REQUIRED request checksums and one attempt per call; presign only fixed Run result keys, PUT TTLs of 1–604800 whole seconds and GET TTL 300, passing Effect-clock signing dates. Bound operations to ten Effect seconds and forward cancellation to HeadObject/HeadBucket. Retain only bounded tagged failure operations, never raw SDK causes, credentials or URLs. Process wiring and per-Function TTL selection remain P6.2. | A HeadObject NotFound/404 is ambiguous for a missing bucket; verify HeadBucket before interpreting it as a missing object. Other failures remain retryable infrastructure errors. MinIO vendor registries reject anonymous pulls for the pinned release, so the disposable test fixture builds genuine upstream AMD64/ARM64 release binaries with GitHub-reported SHA256 checks enforced by Docker ADD, on a digest-pinned base; no fake S3 implementation or supply-chain exception. |
| D107 | Wire P6.2 with one scoped optional S3 adapter per process, acquired from the five parsed S3 settings; all absent disables it, a partial group fails startup with only the missing variable name. Sign the Job upload URL before provisioning resources and pass it through the existing manifest input; select the Function deadline unless an explicit duration is set, rounding fractional seconds upward for the whole-second S3 protocol and rejecting configured TTLs outside 1–604800 seconds at adapter acquisition. Reuse the terminal controller check-before-CAS seam and atomic inline-result precedence; GET signing is supplied to the existing gateway result route. | The process owns client cleanup, including partial startup and interruption, without an ambient credential chain or per-request client. Presign errors release queued claims without creating Secret/Job resources; object-check errors remain typed and leave terminal transition/cleanup for the next controller retry. The existing Store transaction publishes resultUri only when an object exists and no inline result wins. No schema, security policy, dependency, retry budget or native Phase 6 gate change; P6.3 still owns MinIO-in-kind resultUri/307 acceptance. |
| D108 | Bound P6.2 result-storage failures without changing API or failure semantics: a scheduler installation whose maximum Function deadline exceeds the S3 SigV4 ceiling of 604800 seconds must configure an explicit representable `KRUN_S3_PRESIGN_TTL`; reject an unsafe default with variable-only `ConfigInvalid` before acquiring its S3 client (gateway GET signing has no PUT-ceiling restriction). Keep the actual requested TTL, never clamp it. Release and isolate each typed PUT-signing failure so later claims, cancellation and loss checks proceed within the existing iteration bound. Consume Job/Pod observations with scoped bounded unordered dispatch across independent Run IDs, preserving the existing same-Run gates and ingress ACK fences. Coalesce repeated observations only for an already active Run, retaining presence, newest ingress generation and compact terminal deletion/Pod evidence, so one hot Run cannot occupy all dispatch slots. Keep the existing ten-second call/detection targets, five-minute retry and error-is-not-absence rule. | P6.2 independent reviews reproduced batch poisoning from an unrepresentable default TTL and unrelated failure detection delayed 20016 ms by sequential HEAD consumers; explicit configuration and bounded per-Run isolation repair the causes without silent TTL changes, unbounded fibers, dropped terminal work or broader API/security changes. |
| D109 | Prove the Phase 6 gate in the existing owned kind foundation with the genuine D106 checksum-pinned MinIO fixture, an ephemeral restricted namespace and bucket, generated private credentials referenced by Secret in both process graphs, and a raw jobs NetworkPolicy allowing only the MinIO namespace plus server Pod selector on TCP9000. Retain the jobs default deny and mandatory policy-enforcement probe. Run a real Node26 author Function from the already-verified runtime image: fetch its opaque input, upload exactly one MiB of JSON through KRUN_RESULT_UPLOAD_URL with no S3 account credentials or inline result, then exit zero. Read the persisted FULL Run, require external-only resultUri, verify the authenticated public no-store307 and fixed300-second signed GET, and download/hash the raw bytes with a separate client that never receives the krun API key; unsigned object access must fail403. | D107 necessarily places one per-Run signed PUT capability in its designated Function env field. Validate that exact field against the native Pod run identity, service endpoint and owned key before excluding only its value from the Pod privacy scan; reject all other presigned URLs and continue scanning every actual input/token/API/webhook/S3 credential and all process/MinIO logs. This corrects the pre-storage test oracle, not the section11 no-body/no-env-list logging policy. Reuse existing Node/AWS/Zod tooling without dependencies, production chart changes or release authority. Preserve all earlier native scenarios with S3 enabled so inline precedence and absent-object paths remain exercised. |
| D110 | Repair the P6.3 upload-capability privacy oracle before excluding its designated Pod env value: require a closed single-valued SigV4/PutObject query, a valid signing date and matching credential date/region/service scope, a representable positive PUT expiry, and the actual generated public access-key identity. Scan both raw and decoded query material for known private input, tokens, API/webhook/S3 secrets before exclusion. Allow the public access-key value only in its credential component; distinguish previously validated capabilities/signatures from private canaries so repeated native Pod observations remain valid. | Independent P63-C1 controls demonstrate that an extra or duplicate query could hide private material inside the permitted field. Reject malformed/private-bearing capabilities with a bounded generic error before observing or mutating them. Preserve the required per-Run capability, existing no-body/no-env-list logging policy, native deadlines, application APIs, dependencies and raw NetworkPolicy isolation. No actual application leak is inferred from controlled mutations that invalidate the signature. |
| D111 | Make the disposable P6.3 bucket initializer idempotent with the same explicit S3 client: HEAD the owned bucket, create it only after an actual HTTP404, fail on403/other infrastructure errors, and always destroy the client. Retain the90-second Job and10-second per-request bounds. | Native investigation reproduced an already-owned-bucket failure on a repeated CreateBucket after a successful initialization; that cannot be treated as fresh setup or solved by ignoring arbitrary errors. Existing/new-bucket and denied/unavailable unit controls plus genuine MinIO diagnostics preserve the bootstrap contract. The earlier canonical Job deadline and reviewer interruptions remain separately qualified; no causal or production-runtime fix is inferred from them. |
| D112 | Build P7.1 as the common Helm foundation: preserve the generated CRD template and controls, expose the section13 values verbatim, fail clearly on a missing API-key reference, and render shared Services, mode-appropriate ServiceAccounts and the conditional gateway PDB. Use reusable label, selector, image, environment, hardening, probe and scheduling partials in actual baseline Postgres Deployments so the common pod contract is not tested vacuously. | P7.2 adds and verifies the Postgres migration hook lifecycle;P7.3 adds the embedded StatefulSet/PVC/Litestream lifecycle;P7.4 owns RBAC,namespace isolation/admission and optional integrations. Those tasks and P7.6 chart-installed embedded/Postgres e2e remain mandatory before the Phase7 gate is claimed. P7.1 tests real Helm renders for both common-resource modes and secure concrete Postgres pods without changing section9 policy,adding values/dependencies,claiming chart installation readiness or closing later tasks. |
| D113 | Give the public Service a dedicated `krun.publicServiceName` helper rather than use the general workload fullname. Preserve an ordinary DNS1035-label-safe release name unless it equals the mandatory fixed internal Service name. Otherwise replace release-name dots with hyphens,prefix `krun-`,bound the result to63 characters and trim a trailing hyphen;prefix again if normalization itself produces the fixed internal name. Keep release/selector identity and workload names unchanged;public backend references,including future HTTPRoute work,must use this helper. | Both P7.1 independent reviews reproduce duplicate public/internal Service identity for release `krun-gateway-internal`;native Kubernetes additionally rejects dotted public names despite Helm accepting the release. A Service-specific derivation also supports numeric-leading releases without relying on a newer Service-name feature gate. This changes no values,public HTTP/API contract or fixed internal endpoint,and does not complete deferred mode/security/native chart-install tasks. |
| D114 | Complete P7.2 with the Postgres-only pre-install/pre-upgrade migration Job and earlier hook ServiceAccount, preserving the specified weights, delete policies, retry/deadline bounds and least privilege. Reuse scheduler resources and shared config/image/security/lifecycle helpers; expose only DB Secret references and harmless config env on the hook. Clarify section13 probes as serving gateway/scheduler probes: the one-shot migrate hook has no admin listener and no probes. | Actual `packages/shared/src/store/migrate.ts` parses only DB settings, migrates and terminates; the project chart hook reference explicitly excludes probes. Attaching serving HTTP probes would target a nonexistent listener and can kill a healthy long migration. Job completion/exit status with backoff1 and deadline240 is the genuine hook health contract, not a fake health server. Helm4.3.0 source orders hooks by weight and defers succeeded cleanup until all hooks finish, so the weight-5 ServiceAccount exists for the weight0 Job and successful cleanup runs in reverse. No section9 policy, values, public API, runtime dependency or later Phase7 gate is changed. |
| D115 | Implement P7.3 with the single embedded StatefulSet and ordered restore/native-sidecar/migrate lifecycle. Derive its headless Service from the existing DNS-label-safe public name with a bounded `-headless` suffix, so it is distinct from both serving Services without changing their names. Disable automatic pod token mounts and explicitly project the standard rotating token/CA/namespace only into gateway and scheduler; init and Litestream containers receive none. Set `KRUN_NAMESPACE` from the actual release namespace in shared serving env. | The public Service already uses the ordinary release name, so using that again as the headless Service duplicates its identity. Kubernetes automatic token injection otherwise reaches all init containers, contrary to the existing section13 app-only token rule. Serving processes must use the release namespace for Functions and Leases rather than the runtime default namespace. Restore passes its URL as a positional shell argument, removes only orphan WAL/SHM when the DB is absent, and uses the documented Litestream restore/replicate CLI; no new values, API shape or section9 policy are introduced. |
| D116 | Implement P7.4a as the jobs Namespace/PSA/keep, LimitRange, ResourceQuota, always-present tokenless job ServiceAccount and optional fixed-name digest admission policy/binding, plus the remaining required quota/webhook/object-storage fail cases. The binding uses the API-populated namespace name label; the CEL variable selects Job versus Pod spec through the admission request resource. | Keep section9 policy and section13 values unchanged: creation gates Namespace and resource budgets, not the ServiceAccount or enabled admission objects. CEL applies the exact required digest-marker check to regular/init images on Job/Pod CREATE/UPDATE and is verified against the real API server. NetworkPolicy, RBAC, optional feature env and full chart-installed two-mode data-plane acceptance remain their later tasks. |
