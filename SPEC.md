# krun specification

Status: v1 draft, 2026-10-22. This file is the source of truth for behavior.
PLAN.md holds the build order. Change this file only together with a new
entry in section 15 (Decisions).

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
  maxQueueTime: 1h                         # default 1h
  heartbeatTimeout: 5m                     # optional; when set, the function must POST status at least this often once running
  nodeSelector: {}                         # optional
  imagePullSecrets: []                     # optional
  callback:                                # optional default webhook
    url: https://hooks.acme.com/krun
status:                                    # written by the scheduler leader only
  observedGeneration: 3
  conditions:
    - { type: Ready, status: "True", reason: Valid, message: "" }
```

Durations everywhere (Function fields, environment variables, `?wait`)
match `^\d+(ms|s|m|h)$`; the CRD carries that pattern.

Schema: `packages/shared/src/functions/schema.ts` defines `spec` with
TypeBox. It is the single source for the CRD `openAPIV3Schema` (generated by
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
  `maxConcurrency` at least 1; `maxQueueTime` and `heartbeatTimeout` parse,
  `heartbeatTimeout` at least 30 seconds; image prefix within
  `KRUN_ALLOWED_REGISTRIES`; `serviceAccountName` within
  `KRUN_ALLOWED_SERVICE_ACCOUNTS`; no `secretRefs` entry matching `krun-*`;
  `callback.url` host within `KRUN_WEBHOOK_ALLOWED_HOSTS`.

Reading: the gateway and the scheduler each run an informer on Functions
in `KRUN_NAMESPACE` and keep an in-memory map with the compiled validator
cached per `metadata.uid` and `metadata.generation`; resyncs and status
patches do not recompile. A Function that fails the second layer is not
served: `POST /v1/functions/{function}/runs` returns 404 with the reason in
the message, and the scheduler claims nothing for it. Only the scheduler
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

Public API. Base path `/v1`. JSON bodies. Errors:

```json
{ "error": { "code": "schema_invalid", "message": "...", "details": [] } }
```

| Status | `code` |
|---|---|
| 400 | `request_invalid`, `schema_invalid` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict` |
| 413 | `payload_too_large` |
| 422 | `idempotency_conflict` |
| 429 | `rate_limited`, `queue_full` |

Authentication: `Authorization: Bearer <key>`. Keys come from a mounted file
(section 9). Every endpoint under `/v1` requires a key.

| Method and path | Scope | Notes |
|---|---|---|
| `GET /v1/functions` | functions:read | Ready functions the key may use: names and input schemas; `next` always null |
| `GET /v1/functions/{function}` | functions:read | 404 unless Ready |
| `POST /v1/functions/{function}/runs` | runs:write | create run, optional `?wait=30s` |
| `GET /v1/runs/{id}` | runs:read | optional `?wait=30s` |
| `GET /v1/runs` | runs:read | filters `function`, `state`, `since`, `until` (on `createdAt`), `limit` (default 50, max 200), `cursor`; order `createdAt desc, id desc`; cursor is base64url of `createdAt|id`, malformed cursor 400 `request_invalid`; items are `RunSummary` |
| `GET /v1/runs/{id}/events` | runs:read | SSE of state changes, status reports and job status updates, closes after terminal state |
| `GET /v1/runs/{id}/result` | runs:read | 200 inline JSON when `result` is set, else 307 to a presigned GET (300 s TTL) when `resultRef` is set, else 404; 409 when not terminal |
| `DELETE /v1/runs/{id}` | runs:write | cancel: 202 with the full run from queued, scheduled, running, and when already `cancelling` (no new transition); 409 if terminal |

List responses are `{ "items": [...], "next": "<cursor>" | null }`. Every
429 carries `Retry-After: 1`.

A key sees only runs it created; a run of another key is 404. Scope `admin`
implies every scope and every function.

Internal API, served only on `KRUN_INTERNAL_LISTEN_ADDR`, authenticated
with the per-run token (`Authorization: Bearer <token>`). API keys are
rejected here. The token is valid only for the run in the path and only
while the run is `queued` with a token set, `scheduled` or `running`;
anything else is 401. The version segment is independent of `/v1`; SDK major
N speaks `/internal/vN`. An unknown version answers 404 with code
`unsupported_api_version`. The gateway logs the `User-Agent` of internal
requests and never gates on it.

| Method and path | Notes |
|---|---|
| `GET /internal/v1/runs/{id}/input` | 200 with the input JSON |
| `POST /internal/v1/runs/{id}/status` | body `{ "message": "...", "progress": 0.4, "data": {} }`; `message` up to 1 KB, `data` up to 4 KB, `progress` 0 to 1 optional; at most 1 per second per run per gateway replica, 429 beyond; replaces `runtimeStatus` wholesale (a plain-HTTP heartbeat re-sends the full last status) with an `at` timestamp and publishes a notify, never written to `run_events`; 204 |
| `PUT /internal/v1/runs/{id}/result` | JSON body up to `KRUN_MAX_RESULT_BYTES`, 413 beyond; replaces `result`; 204 |
| `PUT /internal/v1/runs/{id}/error` | body `{ "message": "...", "type": "...", "details": {} }`; `message` up to 4 KB, `type` up to 128 bytes, `details` up to 8 KB; stored as `error` with `source: function`; never changes the state, the exit code does; 204 |

Body size limits are enforced from `Content-Length` and the stream before
the body is parsed.

Create run request:

```json
{ "input": { "from": "2026-10-01", "to": "2026-10-21" },
  "priority": 0,
  "callback": { "url": "https://hooks.acme.com/krun" } }
```

`priority` is an integer 0 to 9, default 0, higher first; a value above 0
requires scope `runs:priority`, else 403; outside the range, 400.

Create run responses:

| Code | When |
|---|---|
| 202 | run created, not finished within `wait` (or no `wait`), `Location: /v1/runs/{id}` |
| 200 | finished within `wait`, or idempotent replay (header `Idempotent-Replay: true`) |
| 400 | input fails schema, details list each violation; `priority` out of range; callback host disallowed or unresolvable (`request_invalid`, `details[0].path` `callback.url`) |
| 401 / 403 | missing key, key not allowed for this function, or `priority` without scope |
| 404 | function missing or not `Ready`, message holds the reason |
| 413 | input larger than `KRUN_MAX_INPUT_BYTES` |
| 422 | `Idempotency-Key` reused with different input |
| 429 | rate limit (`rate_limited`), function `maxQueued` or the key's `maxQueued` reached (`queue_full`), with `Retry-After` |

Run representation (full form, returned by `POST .../runs` and
`GET /v1/runs/{id}` with or without `wait`):

```json
{ "id": "019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "function": "report-generator",
  "state": "running",
  "attempt": 1,
  "priority": 0,
  "input": { },
  "result": null,
  "resultRef": null,
  "error": null,
  "logTail": null,
  "failureReason": null,
  "runtimeStatus": null,
  "jobStatus": { "podName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b-x7k2q",
                 "phase": "Running", "reason": null, "message": null,
                 "exitCode": null, "observedAt": "2026-10-22T10:00:09.000Z" },
  "jobName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "createdBy": "reports-service",
  "createdAt": "2026-10-22T10:00:00.000Z",
  "scheduledAt": null, "startedAt": null, "finishedAt": null }
```

`RunSummary` is the same object without `input`, `result`, `logTail` and
`error.details`. It is the item type of `GET /v1/runs`, the `data` of every
SSE message and the webhook payload. One TypeBox schema each and one
projection function.

`jobStatus` is the scheduler's view of the Kubernetes Job and its pod,
derived from Kubernetes alone (section 8). It is set from `scheduled` on and
kept after the terminal state; `observedAt` is the time of the last change.
`runtimeStatus` is optional and informational: a function that never calls
the internal API is tracked exactly the same way.

`failureReason` is set with `failed` and is one of `exit_code`, `oom_killed`,
`deadline_exceeded`, `evicted`, `disrupted`, `heartbeat_timeout`,
`job_create_failed`, `job_lost`, `queue_timeout`. `error` is an object
`{ source, message, type, details }`; `source` is `function` (reported
through the internal API), `kubernetes` (pod or Job reason and message) or
`krun` (`heartbeat_timeout`, `job_create_failed`, `job_lost`,
`queue_timeout`). `logTail` holds the last 100 log lines, 16 KB cap, on
failure when the container ran. Clients branch on `failureReason`, never on
`error`.

SSE: on connect the handler reads the run and sends one `state` message
with its `RunSummary`; a terminal run at connect gets that message, then
EOF. Then it re-reads the run on each notify and at least every second and
emits one message per field changed since the last message sent: `event`
`state`, `status` or `job_status`, `data` the `RunSummary`, `id` the
field's own time in RFC 3339 (`state`: `createdAt`, `scheduledAt`,
`startedAt` or `finishedAt` matching the state, the read time for
`cancelling`; `status`: `runtimeStatus.at`; `job_status`:
`jobStatus.observedAt`). `Last-Event-ID` is ignored: the snapshot replaces
replay.

Wait semantics: `wait` is capped at `KRUN_MAX_WAIT` (default 60s, keep below
the ingress timeout). On create, the gateway subscribes to the run id before
inserting the row so no event is missed. Client disconnect never cancels a
run.

Idempotency:

- Header `Idempotency-Key`, optional, at most 128 characters. Unique per
  (key name, function). Stored with a SHA-256 of the canonical JSON input.
- Same key and same hash: 200 with the existing run. Same key and different
  hash: 422. No key: every request creates a new run.
- A key lives as long as the run row. Retention is the idempotency window.

Rate limiting: token bucket per API key, `KRUN_RATE_LIMIT_RPS` and
`KRUN_RATE_LIMIT_BURST`, enforced per gateway replica.

Request ids: Fastify `requestIdHeader: 'x-request-id'`; a value over 128
characters is replaced by a generated UUID; every response echoes
`X-Request-Id`; every request-scoped log line carries `reqId`.

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
| queued | failed | scheduler | queued longer than `maxQueueTime` (`queue_timeout`); a deleted Function or an invalid duration uses the 1h default |
| queued, scheduled, running | cancelling | gateway | DELETE |
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
- `createdAt`, `scheduledAt`, `startedAt` and `finishedAt` are set by
  `createRun`, `markScheduled`, the transition to `running` and the
  terminal transition; each equals the `at` of its `run_events` row. A
  terminal transition that skipped `running` sets `startedAt` from the
  `function` container's `terminated.startedAt`, else the Job's
  `status.startTime`.
- `attempt` counts scheduler claims. There are no automatic retries in v1:
  Jobs run with `backoffLimit: 0`. A client retries by submitting a new run.
- On failure `error` is the function's own report when it called the error
  endpoint, otherwise the Kubernetes reason and message (for example
  `ImagePullBackOff` or `Unschedulable`), otherwise krun's reason.
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
| JSON columns | `jsonb` | `text`, read with JSON1 |
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
  input_hash       text not null,
  function_name    text not null,
  input            jsonb not null,
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
    event?: { actor: string }): Promise<boolean>;                        // event, when given, is the run_events payload                                                      // compare-and-set; sets started_at when to = running, finished_at when terminal; appends run_events; inserts the delivery when terminal and callback_url set
  setRuntimeStatus(id: string, status: RuntimeStatus): Promise<boolean>;  // queued with token, scheduled or running; publishes notify, no run_events row
  setResult(id: string, result: unknown): Promise<boolean>;                // queued with token, scheduled or running
  setError(id: string, error: RunError): Promise<boolean>;                 // queued with token, scheduled or running; source function
  setJobStatus(id: string, status: JobStatus): Promise<boolean>;           // scheduled, running or cancelling; writes and appends run_events only when a field other than observedAt changed
  expireQueued(fn: string, olderThan: Date): Promise<Run[]>;               // queued -> failed queue_timeout; sets finished_at; one run_events row, notify and delivery each
  listStale(fn: string, before: Date): Promise<Run[]>;                     // running runs whose later of runtime_status.at and started_at is < before
  subscribe(signal: AbortSignal): AsyncIterable<{ id: string; kind: "state" | "status" | "job_status" }>;
  claimDeliveries(now: Date, limit: number): Promise<Delivery[]>;         // sets next_at = now + 60s in the claim statement, ordered by next_at, skip locked
  updateDelivery(id: string, state: DeliveryState, attempt: number, nextAt: Date | null, lastError: string | null): Promise<void>;
  sweep(finishedBefore: Date, batch: number): Promise<number>;             // SQLite runs pragma incremental_vacuum after each batch
  migrate(): Promise<void>;
}
```

`listRuns` applies the cursor as the row-value comparison
`(created_at, id) < ($createdAt, $id)` in both dialects. `listStale` uses
`greatest((runtime_status->>'at')::timestamptz, started_at)` in Postgres
and `max(coalesce(json_extract(runtime_status,'$.at'), started_at),
started_at)` in SQLite, the `coalesce` because SQLite's scalar `max`
returns null on any null argument. `countByState` and `listByState` filter
with the `runs_active_idx` predicate as literal text from one shared `sql` fragment, never bound parameters, so
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

One synchronous connection per process (`better-sqlite3`), no pool.
Transactions open with `begin immediate` through a `SqliteDriver` subclass.

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
  input.
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
`s3://<bucket>/<key>` in the patch, so the delivery carries `resultRef`;
the gateway parses `result_ref` and presigns a GET with a 300 second TTL.
krun never deletes objects; a bucket lifecycle rule of at least
`KRUN_RETENTION` does (docs/OPERATIONS.md). Both may be set. Neither set means `result` is null. The token stops
working at the terminal transition.

### 7.1 Function SDKs

Two SDKs implement the contract: `@krun/sdk` for Node.js 20 or newer
(`packages/sdk-node`, npm) and `krun` for Python 3.11 or newer
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

@run
def handle(input, ctx):
    ctx.status("loading", 0.1)
    return {"rows": 42}
```

`run` does, in order: read `KRUN_RUN_ID`, `KRUN_FUNCTION`,
`KRUN_GATEWAY_URL`, `KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`,
`KRUN_HEARTBEAT_TIMEOUT` and `KRUN_RESULT_UPLOAD_URL`; `GET input`;
`POST status` `{ message: "started" }`; the SDK keeps the last status
payload, each `ctx.status` call replaces it and restarts the heartbeat
timer; while the handler runs and `KRUN_HEARTBEAT_TIMEOUT` is set, the timer
re-POSTs that payload unchanged every third of it, and never keeps the
process alive (`setInterval(...).unref()` in Node, a daemon thread in
Python; a CPU-bound synchronous handler or a GIL-holding extension starves
it); on return, serialize the value as JSON and `PUT result` when it fits
`KRUN_MAX_RESULT_BYTES`, otherwise upload it to `KRUN_RESULT_UPLOAD_URL`;
when the result write fails after retries, log the cause, `PUT error` with
type `ResultWriteError` and exit 1; otherwise exit 0. On a thrown error or
exception: `PUT error` with the error type, the message and the first 20
stack lines as `details.stack`, then exit 1. Before sending, the SDK
truncates to the section 4 limits, measured in UTF-8 bytes on character
boundaries: status `message` 1 KB, `data` omitted and logged when over 4
KB; error `message` 4 KB, `type` 128 bytes, `details.stack` lines dropped
from the end until `details` fits 8 KB. Every call retries 3 times with
backoff on connection errors and 5xx. `ctx.status` never throws: any 4xx,
a 429 or exhausted retries are logged and dropped. `ctx` exposes `runId`,
`function`, `status(message, progress?, data?)` and `log`, which writes one
JSON line to stdout in the pod so `logTail` stays readable.

Local mode: when `KRUN_GATEWAY_URL` is unset, `run` reads the input from
the file named by the first argument, or stdin, prints only the result to
stdout, writes `ctx.log` and `ctx.status` to stderr, and exits with the same
codes. No cluster, no gateway.

SDK major versions track the internal API version: SDK 1.x speaks
`/internal/v1`. Each SDK sends `User-Agent: krun-sdk-<lang>/<version>`.

### 7.2 `krun init` and `krun deploy`

`krun init --lang node|python [--name <function>] <dir>` scaffolds a
function project from `packages/cli/templates/<lang>`:

- handler file with the function above and one test that runs it through
  local mode;
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
`GET /v1/runs/{id}` curl whose `logTail` holds the last lines of a failed
run. `--no-apply` stops after
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
through `AbortSignal.timeout`. A 429 in the main loop releases the leases
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
   `expireQueued(fn, now - maxQueueTime)`, using the cached Function's
   `maxQueueTime` when it is in the informer map (Ready or not) and parses,
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
   transition to `failed` with `job_lost` and a `krun`-sourced error, keep
   any `result` already written, then delete the Secret; drop the entry
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
this order: when object storage is configured and the Job completed, check
the run's object and carry `result_ref` in the patch; compare-and-set the
transition with the final `jobStatus`, `failureReason`, `error`, `logTail`,
`startedAt` when missing (the delivery is inserted in the same
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
  with `now - heartbeatTimeout`; staleness is measured from `startedAt` or
  the last status, whichever is later. It skips a stale run whose cached
  Job carries `Complete` or `Failed`, or whose cached pod is missing or not
  `Running`: the informer path owns those. For each remaining stale run, in
  this order: fetch the log tail, delete the Job with foreground
  propagation, transition `running` to `failed` with `heartbeat_timeout`,
  `error` `{ source: krun, message: "no status for <timeout>, last at
  <time>" }` and the tail as `logTail`, delete the Secret. Functions without
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
public port open. The token is never logged.

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
  (default `v1.29`).
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
comma-separated for rotation. Headers `X-Krun-Delivery` and `X-Krun-Run-Id`
accompany it. Receivers must reject `|now - t| > 300` seconds and dedupe on
`X-Krun-Delivery`. The payload is the `RunSummary` at the terminal
transition.

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
| `maxQueueTime` | 1h | fails with `queue_timeout`; also the default for deleted Functions |
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

Prometheus metrics on the admin listener of each process:

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
serving for `KRUN_SHUTDOWN_DELAY` (default 5s) so endpoints drain, then
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
| `KRUN_TTL_AFTER_FINISHED` | `86400` | scheduler |
| `KRUN_RETENTION` | `720h` | scheduler |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | scheduler, PUT presign; a duration. The gateway's GET presign is fixed at 300 s |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty, webhooks disabled | both |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | both; comma-separated CIDRs that pass the address check |
| `KRUN_WEBHOOK_SECRET` | | scheduler; comma-separated secrets, one signature each |
| `KRUN_LOG_LEVEL` | `info` | both |

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

crds:
  install: true         # CRD templated into the release
  keep: true            # helm.sh/resource-policy: keep on the CRD
apiKeys:
  existingSecret: ""    # key: keys.yaml; required

jobsNamespace:
  name: krun-jobs
  create: true
  keep: true            # helm.sh/resource-policy: keep on the Namespace
  podSecurityVersion: v1.29
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
(docs/OPERATIONS.md). Every krun container has a readiness probe on
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
`KRUN_DB_*` variables.

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
enabled) then `krun migrate`. With Litestream enabled, a sidecar from
`db.embedded.litestream.image` streams the WAL to object storage. SQLite in
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
`krun-function-author` and `krun-job-viewer`; a PodMonitor (one endpoint
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
- Kubernetes 1.29 or newer: CEL validation rules in the CRD, Pod Security
  Admission labels, `DisruptionTarget` pod condition. A CNI that enforces
  NetworkPolicy; the isolation in section 9 is void without one.
- One trust domain per installation for function authors.

## 15. Decisions

| Id | Decision | Why |
|---|---|---|
| D1 | Implementation language: see D15 | superseded on 2026-10-22 before any code existed; the original choice and its reasoning are in git history |
| D2 | No CRD, no operator pattern | a custom database was chosen for history and queries; Kubernetes is the execution engine only. Amended by D17: a CRD for function definitions only; runs stay in the database |
| D3 | Postgres as system of record, SQLite as `db.mode: embedded` | every krun need maps to a built-in feature, shared SQL across both, Litestream for embedded backups |
| D4 | No Kafka, Redis, RocksDB, LevelDB or other KV engines | Kafka has no lookup or update by id; Redis is not a system of record; KV engines mean hand-built indexes with no gain at this write rate |
| D5 | Gateway and scheduler are separate containers and Deployments; the only contract is the database | independent scaling, no RPC coupling, gateway keeps accepting when the scheduler is down |
| D6 | Job pods never hold database or krun credentials; input via per-run Secret, output via termination message or presigned URL | one compromised function image must not read other tenants' data; no SDK inside function images. Amended by D16. |
| D7 | API keys in a mounted Secret file, not in the database | no key management API needed in v1; the Secret is the protection boundary |
| D8 | No automatic retries, `backoffLimit: 0` | retries with side effects must be visible and chosen by the client |
| D9 | Run ids are UUIDv7 | time-ordered ids give stable cursor pagination and match `created_at` order |
| D10 | No table partitioning in v1 | Postgres requires the partition key inside unique constraints, which breaks the idempotency index; batched delete suffices |
| D11 | Per-run Secret has no owner reference; scheduler deletes it on terminal transition plus orphan sweep | avoids a create-patch dance against the Job UID |
| D12 | Registry and keys reload by 30 second polling, not file watchers | ConfigMap mounts update via symlink swap; polling is enough and needs no dependency. Amended by D17: functions come from an informer; keys still poll |
| D13 | Failure error holds a log tail, success stores no logs | enough to debug a failed run without a log pipeline; archiving is v2 |
| D14 | Target workload stated as tens of seconds to hours | Job-per-run cold start and API server load make sub-second or high-rate functions a poor fit |
| D15 | Supersedes D1: Node.js 24 LTS, TypeScript, ES modules, pnpm workspace (`packages/shared`, `apps/gateway`, `apps/scheduler`), Fastify with TypeBox route schemas, `pg` plus Kysely, `better-sqlite3`, `@kubernetes/client-node` 2.x, pino, prom-client, single image | owner preference, 2026-10-22. Fastify validates request bodies with ajv, the same library compiles function input schemas; Kysely gives typed SQL and migrations for both dialects; `better-sqlite3` is the driver Kysely's SQLite dialect targets and ships prebuilt binaries; `@kubernetes/client-node` covers Jobs, Secrets, informers and the Lease API. Amended by D17: functions come from a CRD informer. Cost: Lease leader election is written in house, about 40 lines. |
| D16 | Amends D6: job pods fetch input, report status and write results through the gateway's internal API with a per-run token delivered by a per-run Secret; no input volume, no termination message | owner decision 2026-10-22. Input and result sizes are no longer bound by the Secret or the 4 KB termination message; runtime status becomes visible to consumers; pods still hold no database or API-key credentials, the token is scoped to one run and dies at the terminal transition. Cost: job pods get egress to one gateway port; function images need an HTTP client. |
| D17 | Supersedes D2 for function definitions and D12 for the registry: functions are a CRD (`functions.krun.io`, `v1alpha1`) read by an informer in the gateway and the scheduler; no registry ConfigMap; runs stay in the database | owner decision 2026-10-22. One ConfigMap caps all functions at 1 MiB; a CRD gives one etcd object per function, per-team RBAC, apply-time validation through OpenAPI and CEL, status on the resource, and propagation within a second. Costs: the CRD install is mandatory, the gateway gains read-only RBAC on one resource type, and gateway readiness needs the API server at startup. |
| D18 | Run `state` and `jobStatus` derive from Job and Pod informers only; `running` means the pod phase is `Running`; `runtimeStatus` from the function is optional and never drives state | owner decision 2026-10-22. A function that ignores the contract is still tracked accurately; a pod stuck in `ImagePullBackOff` or `Unschedulable` is visible on the run instead of showing as running; cold start is measured to the container actually running. |
| D19 | Failure truth comes from Kubernetes: `failureReason` enum on every failed run, log tail captured on the first terminating pod event, and an opt-in per-function `heartbeatTimeout` that kills and fails a run whose status reports stop | owner decision 2026-10-22. A function that crashes without reporting is classified within seconds; a hung function is bounded by its own promise instead of by `activeDeadlineSeconds`; the opt-in keeps long silent computations safe. Rejected: flagging stale runs without killing, which burns capacity and leaves the client without an outcome. |
| D20 | Node.js and Python SDKs plus `krun init` templates implement the HTTP contract; SDKs have no runtime dependencies and a local mode; the contract itself stays plain HTTP; functions report application errors through `PUT error` | owner decision 2026-10-22, after reviewing Knative Functions (`func create -l <lang>`, per-language templates, local `func run`) and Argo Workflows (self-reported progress through a side channel, 256 KB inline result cap, SDKs per language). Template plus SDK is the golden path, curl the escape hatch. Two languages first; Go and Java are v2. |
| D21 | The custom resource is `Function` (`functions.krun.io`, short name `kfn`), and the whole vocabulary follows: `/v1/functions`, `functions:read`, `KRUN_FUNCTION`, `krun.io/function`, `function_name`, metric label `function`, `error.source` `function` | owner decision 2026-10-22: the thing registered is an HTTP-triggered function, not a task; one word everywhere keeps the agent and the docs consistent. Name clash with OpenFaaS and Fission `functions` is accepted; the short name and the fully qualified name resolve it. |
| D22 | The platform chart templates the CRD (`crds.install`, `crds.keep`) and renders no Function resources; functions deploy by `kubectl apply -f function.yaml`, through `krun deploy` or GitOps; a Role `krun-function-author` is rendered without a binding | owner decision 2026-10-22. Two lifecycles, two owners: the platform team owns the type, function teams own instances. Templating the CRD gives upgrades through `helm upgrade`, which `crds/` never does; a CRD-only chart adds an install step and an ordering rule for no gain while there is one API version. A chart per function is ceremony around 25 lines of YAML. |
| D23 | Secret and Job create errors are classified by status: 403 quota, 429, 5xx and network errors back off; any other 4xx fails the run with `job_create_failed` | a persistent admission or RBAC rejection must surface on the run within seconds; a control-plane blip must not fail runs |
| D24 | The internal API is versioned at `/internal/v1`, independent of `/v1`; SDK major N speaks `/internal/vN`; OpenAPI documents for both APIs are generated from the TypeBox routes | SDKs and gateway evolve separately; curl stays allowed, so no User-Agent gating |
| D25 | `priority` is 0 to 9 and needs scope `runs:priority` above 0; keys carry an optional per-key `maxQueued`; Jobs carry `krun.io/created-by` | fairness between keys sharing a function and cost attribution; the scheduler never reads keys.yaml |
| D26 | One trust domain per installation for function authors; `KRUN_ALLOWED_SERVICE_ACCOUNTS` and the `krun-*` `secretRefs` rule bound what a Function may reference; `LimitRange.max` caps one function | D6 isolates pods from krun, not authors from each other; per-tenant namespaces are a non-goal |
| D27 | The per-run token is persisted before the Job exists and accepted while the run is `queued` with a token; Secrets are immutable; `markScheduled` returning false deletes Job and Secret | no 401 window at pod start, no stranded tokens on reclaim, no orphan Jobs |
| D28 | The scheduler deletes Jobs after recording the terminal state; `ttlSecondsAfterFinished` defaults to 86400 as a safety net; `job_lost` keeps a written result | a scheduler outage longer than five minutes must not turn successes into failures |
| D29 | Deliveries are inserted in the terminal transaction; webhook signatures carry a timestamp and one signature per secret; receivers reject skew over 300 seconds | no lost deliveries on a crash, no replay, secret rotation without downtime |
| D30 | Probes and metrics live on a third admin listener (`:9090`), never on the public port; the krun namespace gets per-pod ingress NetworkPolicies; every chart pod satisfies PSA `restricted`; the gateway drains for `KRUN_SHUTDOWN_DELAY` before closing | unauthenticated endpoints stay inside the cluster; rollouts without 502s |
| D31 | Webhook targets pass the address check when inside `KRUN_WEBHOOK_ALLOWED_CIDRS` or when their range is `unicast`; private ranges are rejected unless listed | in-cluster receivers (pod and Service CIDRs) are a real use and the e2e receiver is one; an explicit allowlist keeps the SSRF guard as the default |
| D32 | The jobs namespace is kept on `helm uninstall` (`jobsNamespace.keep`), like the CRD; `egressCIDRs` are `ipBlock` objects with `except`; LimitRange and ResourceQuota bound ephemeral-storage | the platform team's Secrets and in-flight Jobs must survive a release removal; a bare `0.0.0.0/0` would expose cloud metadata; one function must not fill a node disk |
| D33 | `@kubernetes/client-node` informers have no resync, so a leader reconcile timer re-runs the handlers over the caches every 5 minutes; the heartbeat loop and the `job_lost` check start only after the informers' initial sync and defer to the informer path for runs whose cached Job is terminal | without this a completed run could be killed as `heartbeat_timeout` during startup or an object-store outage, and `job_lost` and object-store retries would never fire |
