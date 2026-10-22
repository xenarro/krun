# krun specification

Status: v1 draft, 2026-10-22. This file is the source of truth for behavior.
PLAN.md holds the build order. Change this file only together with a new
entry in section 16 (Decisions).

## 1. Purpose

krun runs HTTP-triggered functions as one-off Kubernetes Jobs. A client
sends an HTTP request that names a registered function and carries a JSON
input. krun validates the input,
persists the request, creates a Kubernetes Job, tracks the Job to completion,
stores the result, and exposes status and result over HTTP.

Target workload: functions that run from about 10 seconds to several hours,
submitted at up to a few runs per second sustained. Bursts are absorbed by
the queue.

Non-goals for v1: workflows or DAGs, sub-second functions, cron scheduling (use
CronJob), web UI, multi-cluster, per-tenant namespaces, Kueue integration,
pool executor, automatic retries, log archiving, SDKs beyond Node.js and
Python.

## 2. Architecture

```
 actor ──HTTP /v1──> krun-gateway ──SQL──> database <──SQL── krun-scheduler ──kube API──> Jobs
                        ^    ^                                     │                      (jobs namespace)
                        │    └──────────── pg_notify ──────────────┘                          │
                        │                                                                     │
                        └──── HTTP /internal, per-run token: input, status, result ───────────┘
 Function custom resources (functions.krun.io): informer in gateway and scheduler
 object storage (optional): results larger than KRUN_MAX_RESULT_BYTES via presigned PUT
```

Components:

| Component | Role | Replicas | Kubernetes RBAC | DB role |
|---|---|---|---|---|
| krun-gateway | public API `/v1`: auth, validation, idempotency, insert run, read status, wait, SSE, result, cancel request. Internal API `/internal` on a second port: job pods fetch input, report status, write result | N, stateless | `functions.krun.io` read in the krun namespace | insert, select and update runs; insert run_events |
| krun-scheduler | claim queued runs, create Jobs, watch Jobs and pods, state transitions, failure detection, heartbeat timeouts, cancel, webhook deliveries, retention sweep | 1 active, standby allowed, leader election via Kubernetes Lease | Roles in the jobs namespace and the krun namespace | update runs; insert run_events; deliveries |
| database | system of record for runs | managed Postgres, or SQLite in embedded mode | | |
| functions | `Function` custom resources in the krun namespace | informer in both | | |
| object storage | S3-compatible, optional | | | |
| jobs namespace | dedicated, hardened, holds Job pods and per-run Secrets | | | |

Contract between gateway and scheduler: the database only. No RPC between
them. When the scheduler is down, the gateway still accepts runs and they
queue. Cancel is a run state that the scheduler acts on.

One container image, four entrypoints: `krun gateway`, `krun scheduler`,
`krun migrate`, `krun validate`.

Job pods never hold database or krun API-key credentials. Each pod gets a
per-run token from a per-run Secret and talks only to the gateway's
internal API: it fetches its input, reports runtime status and writes its
result there. Results larger than `KRUN_MAX_RESULT_BYTES` go to object
storage through a presigned URL.

Function images are built from the `krun init` template with the Node.js or
Python SDK (section 7.1, 7.2). The contract stays plain HTTP, so any
language works without them.

## 3. Functions

A function definition is a custom resource `Function`, API group `krun.io`, version
`v1alpha1`, namespaced, in the krun namespace. Short name `kfn`. Printer
columns READY, IMAGE, AGE. There is no registry ConfigMap. `kubectl get
functions` is ambiguous on clusters that also run OpenFaaS or Fission; use
`functions.krun.io` or `kfn` there.

```yaml
apiVersion: krun.io/v1alpha1
kind: Function
metadata:
  name: report-generator                   # DNS-1123 label, unique per namespace
spec:
  image: ghcr.io/acme/report@sha256:...    # digest required, tags rejected
  inputSchema:                             # JSON Schema draft 2020-12
    type: object
    required: [from, to]
    properties:
      from: { type: string, format: date }
      to:   { type: string, format: date }
  serviceAccountName: krun-job-default     # optional, default shown
  resources:                               # optional, LimitRange applies defaults
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: "1",  memory: 512Mi }
  env:                                     # optional, plain values only
    - { name: REPORT_FORMAT, value: pdf }
  secretRefs: [report-secrets]             # optional, envFrom existing Secrets
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

Schema: `packages/shared/src/functions/schema.ts` defines `spec` with TypeBox.
It is the single source for the CRD `openAPIV3Schema` (generated by
`scripts/gen-crd.ts` into `deploy/helm/krun/crds/krun.io_functions.yaml`), the
TypeScript type, and `docs/schemas/function-v1alpha1.json` for editors.
`make generate` regenerates them; CI fails on a diff.

Validation, two layers:

- At apply, by the API server from the CRD: required fields, types, enums,
  minimums, and a CEL rule that rejects an `image` without `@sha256:`.
- In the processes, on every informer event, by one shared pure function:
  `inputSchema` compiles (2020-12), `activeDeadlineSeconds` within
  `KRUN_MAX_ACTIVE_DEADLINE`, `maxQueued` within `KRUN_MAX_QUEUED`,
  `maxConcurrency` at least 1, `maxQueueTime` parses, `heartbeatTimeout`
  when set parses and is at least 30 seconds, image prefix within
  `KRUN_ALLOWED_REGISTRIES`, `callback.url` host within
  `KRUN_WEBHOOK_ALLOWED_HOSTS`.

Reading: the gateway and the scheduler each run an informer on Functions in
`KRUN_NAMESPACE` and keep an in-memory map. A Function that fails the second
layer is not served: `POST /v1/functions/{function}/runs` returns 404 with the
reason in the message, and the scheduler claims nothing for it. Only the
scheduler leader writes status: condition `Ready` with reason `Valid`,
`SchemaInvalid`, `DeadlineAboveCeiling`, `QueuedAboveCeiling`,
`RegistryNotAllowed`, `CallbackNotAllowed` or `InvalidDuration`, patched only when
`observedGeneration` or the condition changes. Readiness of both processes
waits for the informer's initial list. The informer's error handler
restarts the watch with backoff. A change reaches both processes within
about one second of apply.

Gateway uses `name`, `inputSchema`, `maxQueued` and `callback` (the default
is copied into the run at create when the request carries none). Scheduler
uses everything else.

`krun validate <path>...` runs the CRD schema and the second layer over Function
documents in files or directories, prints one line per function, exits 1 on
any error. For CI in function repositories.

## 4. HTTP API

Base path `/v1`. JSON bodies. Errors:

```json
{ "error": { "code": "schema_invalid", "message": "...", "details": [] } }
```

Authentication: `Authorization: Bearer <key>`. Keys come from a mounted file
(section 9). Every endpoint under `/v1` requires a key.

| Method and path | Scope | Notes |
|---|---|---|
| `GET /healthz` | none | process alive |
| `GET /readyz` | none | database reachable and Function informer synced |
| `GET /metrics` | none | Prometheus |
| `GET /v1/functions` | functions:read | Ready functions the key may use: names and input schemas |
| `GET /v1/functions/{function}` | functions:read | 404 unless Ready |
| `POST /v1/functions/{function}/runs` | runs:write | create run, optional `?wait=30s` |
| `GET /v1/runs/{id}` | runs:read | optional `?wait=30s` |
| `GET /v1/runs` | runs:read | filters `function`, `state`, `since`, `until`, `limit` (max 200), `cursor` |
| `GET /v1/runs/{id}/events` | runs:read | SSE of state changes, status reports and job status updates, closes after terminal state |
| `GET /v1/runs/{id}/result` | runs:read | 200 inline JSON when `result` is set, else 307 to presigned GET when `resultRef` is set, else 404; 409 when not terminal |
| `DELETE /v1/runs/{id}` | runs:write | cancel: 202 if queued, scheduled or running, 409 if terminal |

A key sees only runs it created unless it has scope `admin`.

Internal API, served only on `KRUN_INTERNAL_LISTEN_ADDR`, never on the
public listener, authenticated with the per-run token
(`Authorization: Bearer <token>`). API keys are rejected here. The token is
valid only for the run in the path and only while the run is `scheduled`
or `running`; anything else is 401.

| Method and path | Notes |
|---|---|
| `GET /internal/runs/{id}/input` | 200 with the input JSON |
| `POST /internal/runs/{id}/status` | body `{ "message": "...", "progress": 0.4, "data": {} }`; `message` up to 1 KB, `data` up to 4 KB, `progress` 0 to 1 optional; at most 1 per second per run per gateway replica, 429 beyond; stored as `runtimeStatus` with an `at` timestamp and published as a notify, never written to `run_events`; 204 |
| `PUT /internal/runs/{id}/result` | JSON body up to `KRUN_MAX_RESULT_BYTES`, 413 beyond; replaces `result`; 204 |
| `PUT /internal/runs/{id}/error` | body `{ "message": "...", "type": "...", "details": {} }`; `message` up to 4 KB, `type` up to 128 bytes, `details` up to 8 KB; stored as `error` with `source: function`; never changes the state, the exit code does; 204 |

Create run request:

```json
{ "input": { "from": "2026-10-01", "to": "2026-10-21" },
  "priority": 0,
  "callback": { "url": "https://hooks.acme.com/krun" } }
```

Create run responses:

| Code | When |
|---|---|
| 202 | run created, not finished within `wait` (or no `wait`), `Location: /v1/runs/{id}` |
| 200 | finished within `wait`, or idempotent replay (header `Idempotent-Replay: true`) |
| 400 | input fails schema, details list each violation |
| 401 / 403 | missing key, or key not allowed for this function |
| 404 | function missing or not `Ready`, message holds the reason |
| 413 | input larger than `KRUN_MAX_INPUT_BYTES` |
| 422 | `Idempotency-Key` reused with different input |
| 429 | rate limit or `maxQueued` reached, with `Retry-After` |

Run representation:

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

`jobStatus` is the scheduler's view of the Kubernetes Job and its pod,
derived from Kubernetes alone (section 8). It is set from `scheduled` on and
kept after the terminal state. `runtimeStatus` is optional and informational:
a function that never calls the internal API is tracked exactly the same way.

`failureReason` is set with `failed` and is one of `exit_code`, `oom_killed`,
`deadline_exceeded`, `evicted`, `heartbeat_timeout`, `job_lost`,
`queue_timeout`. `error` is an object `{ source, message, type, details }`;
`source` is `function` (reported through the internal API), `kubernetes` (pod
or Job reason and message) or `krun` (`heartbeat_timeout`, `job_lost`,
`queue_timeout`). `logTail` holds the last 100 log lines, 16 KB cap, on
failure when the container ran. Clients branch on `failureReason`, never
on `error`.

SSE: each message has `event` set to `state`, `status` or `job_status`,
`id` set to the event time in RFC 3339, and `data` holding the full run
representation. The handler re-reads the run on each notify and at least
every second, and emits one message per changed field among `state`,
`runtimeStatus` and `jobStatus`.

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

## 5. Run lifecycle

States: `queued`, `scheduled`, `running`, `succeeded`, `failed`,
`cancelling`, `cancelled`. Terminal: `succeeded`, `failed`, `cancelled`.

| From | To | Who | Trigger |
|---|---|---|---|
| (none) | queued | gateway | POST accepted |
| queued | scheduled | scheduler | Job created |
| scheduled | running | scheduler | pod phase `Running` |
| running | succeeded | scheduler | Job condition `Complete` |
| scheduled, running | failed | scheduler | Job condition `Failed`, or Job missing after grace (`job_lost`) |
| running | failed | scheduler | no runtime status for `heartbeatTimeout` (`heartbeat_timeout`), Job deleted first |
| queued | failed | scheduler | queued longer than `maxQueueTime` (`queue_timeout`) |
| queued, scheduled, running | cancelling | gateway | DELETE |
| cancelling | cancelled | scheduler | Job deleted or absent |

Rules:

- Every transition is a compare-and-set: `update runs set state = $to ...
  where id = $id and state = $from`. Zero rows affected means a stale event.
  Ignore it and log at debug.
- Every successful transition appends a `run_events` row and publishes
  `pg_notify('krun_runs', '<id>:<state>')` in Postgres mode.
  `SetRuntimeStatus` publishes `<id>:status`, `SetJobStatus` publishes
  `<id>:job_status`.
- `run_events` holds state transitions and `jobStatus` changes; a
  `jobStatus` row carries `from_state` equal to `to_state`. Runtime status
  updates are not stored there, only the latest value on the run.
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
  and as the `run_events` reason.

## 6. Data model

One schema, two dialects. Table and column names are identical. Migrations
live in `packages/shared/src/store/migrations/postgres` and
`packages/shared/src/store/migrations/sqlite`, run by the Kysely `Migrator`.

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
create index runs_queue_idx    on runs (priority desc, created_at) where state = 'queued';
create index runs_active_idx   on runs (function_name) where state in ('scheduled','running');
create index runs_function_idx on runs (function_name, created_at desc);
create index runs_owner_idx    on runs (created_by, created_at desc);
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

Store interface (module `packages/shared/src/store`), implemented for both dialects
and verified by one shared contract test suite:

```
CreateRun(run) (run, created bool)             // dedupe on idempotency key
GetRun(id) run
ListRuns(filter, cursor, limit) ([]run, next)
CountActive() map[function]int                      // scheduled + running per function
CountQueued(function) int                           // queued per function, for maxQueued
ClaimQueued(function, owner, leaseUntil, limit) []run
ReleaseLease(id)
MarkScheduled(id, jobName, tokenHash)           // queued -> scheduled, clears lease
Transition(id, from, to, reason, patch) bool    // compare-and-set, appends run_events
SetRuntimeStatus(id, status) bool               // scheduled or running only; sets runtime_status, publishes notify, no run_events row
SetResult(id, result) bool                      // scheduled or running only
SetError(id, error) bool                        // scheduled or running only; stores source function
SetJobStatus(id, status) bool                   // scheduled, running or cancelling; writes and appends run_events reason job_status only on change
ExpireQueued(function, olderThan) int               // queued -> failed queue_timeout
ListStale(function, before) []run                   // running runs with coalesce(runtime_status.at, started_at) < before
Subscribe(ctx) <-chan (id, kind)                // kind: state, status or job_status
EnqueueDelivery(delivery)
ClaimDeliveries(now, limit) []delivery
UpdateDelivery(id, state, attempt, nextAt, lastError)
Sweep(finishedBefore, batch) int
Migrate()
```

Postgres `Subscribe` uses `LISTEN krun_runs`. SQLite `Subscribe` polls
`run_events` every 1 second, so runtime status reaches SSE clients there
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

One synchronous connection per process (`better-sqlite3`), no pool. Sweep
runs `pragma incremental_vacuum` after each batch.

## 7. Job contract

Per claimed run the scheduler creates, in the jobs namespace:

1. Secret `krun-<run id>`, key `token` (32 random bytes, base64url; only
   its SHA-256 is stored in `runs.job_token_hash`), labels `krun.io/run-id`,
   `krun.io/function`, `app.kubernetes.io/managed-by: krun`. No owner reference. The scheduler deletes it on the
   terminal transition. A sweep deletes orphans older than 1 hour by label.
2. Job `krun-<run id>` (41 characters, within the 63 limit):

```yaml
metadata:
  labels: { krun.io/run-id: <id>, krun.io/function: <function>, app.kubernetes.io/managed-by: krun }
spec:
  backoffLimit: 0
  activeDeadlineSeconds: <function value>
  ttlSecondsAfterFinished: <KRUN_TTL_AFTER_FINISHED>
  template:
    metadata:
      labels: { krun.io/run-id: <id>, krun.io/function: <function>, app.kubernetes.io/managed-by: krun }
    spec:
      restartPolicy: Never
      serviceAccountName: <function value>
      automountServiceAccountToken: false
      imagePullSecrets: <function value>
      nodeSelector: <function value>
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: function
          image: <digest-pinned image>
          imagePullPolicy: IfNotPresent
          resources: <function value>
          env:
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

Function container contract, every call with `Authorization: Bearer $KRUN_TOKEN`:

- `GET $KRUN_GATEWAY_URL/internal/runs/$KRUN_RUN_ID/input` to read the
  input.
- Optionally `POST .../status` with a progress message while running.
- On an application error: `PUT .../error` with `message`, `type` and
  `details`, then exit non-zero.
- `PUT .../result` with the JSON result, up to `KRUN_MAX_RESULT_BYTES`,
  before exit. Larger result: HTTP PUT the body to `KRUN_RESULT_UPLOAD_URL`
  instead. The URL expires with `activeDeadlineSeconds`.
- Exit code 0 means success. Any other code means failure.
- No krun library is needed inside the image, only an HTTP client.

On `Complete` the scheduler keeps whatever `result` the pod wrote. If
object storage is configured and the run's object exists, `result_ref` is
set. Both may be set. Neither set means `result` is null. The token stops
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

`run` does, in order: read `KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`,
`KRUN_TOKEN`, `KRUN_MAX_RESULT_BYTES`, `KRUN_HEARTBEAT_TIMEOUT` and
`KRUN_RESULT_UPLOAD_URL`; `GET input`; `POST status` `started`; while the
handler runs and `KRUN_HEARTBEAT_TIMEOUT` is set, `POST status` every third
of it; on return, serialize the value as JSON and `PUT result` when it fits
`KRUN_MAX_RESULT_BYTES`, otherwise upload it to `KRUN_RESULT_UPLOAD_URL`,
or report an error when that is unset; exit 0. On a thrown error or
exception: `PUT error` with the error type, the message and the first 20
stack lines as `details.stack`, then exit 1. Every call retries 3 times
with backoff on connection errors and 5xx. `ctx` exposes `runId`, `function`,
`status(message, progress?, data?)` and `log`, which writes one JSON line
to stdout so `logTail` stays readable.

Local mode: when `KRUN_GATEWAY_URL` is unset, `run` reads the input from
the file named by the first argument, or stdin, prints the result to
stdout and exits with the same codes. No cluster, no gateway.

SDK major versions track the internal API. Each SDK sends
`User-Agent: krun-sdk-<lang>/<version>`.

### 7.2 `krun init`

`krun init --lang node|python [--name <function>] <dir>` scaffolds a function
project from `packages/cli/templates/<lang>`:

- handler file with the function above and one test that runs it through
  local mode;
- `package.json` or `pyproject.toml` depending on the SDK;
- `Dockerfile`: multi-stage, non-root, works with a read-only root
  filesystem, distroless or slim base;
- `function.yaml`: a `Function` resource with `image: REPLACE_WITH_DIGEST`, a
  starter `inputSchema` and `heartbeatTimeout: 5m`;
- `README.md` with the loop: test locally, build, push, read the digest,
  set it in `function.yaml`, `krun validate function.yaml`, `kubectl apply`, POST a
  run with curl.

`krun init` and `krun validate` ship as `@krun/cli` on npm
(`npx @krun/cli init`) and as subcommands of the server binary.

## 8. Scheduler

Only the leader runs the loops. Leader election uses a Kubernetes Lease
named `krun-scheduler` in the krun namespace with a 15 second lease, 10
second renew deadline, 2 second retry.

Main loop, every 1 second and on each notify:

1. Expire queued runs past their function's `maxQueueTime`.
2. Read active counts per function. Free slots per function are
   `maxConcurrency - active`, and globally `KRUN_MAX_RUNNING - sum(active)`.
3. For each Ready function with free slots, claim up to the smaller of the two, lease
   30 seconds.
4. For each claimed run: mint the token, create Secret, create Job
   (AlreadyExists counts as success), `MarkScheduled` with the token hash.
   On `Forbidden` from quota, release the lease
   and back off that function for `2^n` seconds, capped at 60, with metric
   `krun_quota_rejections_total`. On any other API error, release the lease
   and log.
5. For each run in `cancelling`: delete the Job with foreground propagation,
   delete the Secret, transition to `cancelled`.

Job and Pod informers: label selector `krun.io/run-id`, jobs namespace
only, resync every 5 minutes. Their error handlers restart the watch with
backoff; without one an informer stops silently. On each event the
scheduler derives `jobStatus` from the Job conditions and the pod:
`podName`; `phase`; `reason` and `message` from the pod conditions
(`Unschedulable`) or the `function` container state (`ImagePullBackOff`,
`ErrImagePull`, `CreateContainerConfigError`, `OOMKilled`, `Error`,
`DeadlineExceeded`); `exitCode` once terminated; `observedAt`. It calls
`SetJobStatus` only when the value changed. State mapping: pod phase
`Running` to `running`, condition `Complete` to `succeeded`, condition
`Failed` to `failed`. On the terminal transition: check the object store
for `result_ref`, capture the failure error, store the final `jobStatus`,
delete the Secret.

Lost Jobs: a run in `scheduled` or `running` whose Job is absent for more
than 2 minutes fails with reason `job_lost`.

Failure detection. The truth about a run comes from Kubernetes, never from
the function's own reports:

- Crash or non-zero exit: the Pod informer sees the `function` container
  terminated; the Job controller marks the Job `Failed` within seconds.
  `failureReason` is `oom_killed` when the container reason is `OOMKilled`,
  `evicted` when the pod reason is `Evicted`, `deadline_exceeded` when the
  Job condition reason is `DeadlineExceeded`, otherwise `exit_code`.
  Target: the run is `failed` within 10 seconds of the container exit,
  measured by `krun_terminal_detect_seconds`.
- Log tail: on the first Pod event that shows the `function` container
  terminated or the pod carrying a `deletionTimestamp`, the scheduler
  fetches the last 100 lines (16 KB cap) at once and keeps them in memory
  for the terminal transition as `logTail`. If the terminal event arrives
  first, it fetches then; if the pod is already gone, `logTail` stays
  null. `error` is the function's report when present, otherwise the
  Kubernetes reason and message. Fetch before delete, always.
- Hang: a Function with `heartbeatTimeout` promises to POST status at least
  that often once `running`. The heartbeat loop, every 10 seconds, calls
  `ListStale` for each such Function with `now - heartbeatTimeout`; staleness
  is measured from `startedAt` or the last status, whichever is later. For
  each stale run, in this order: fetch the log tail, delete the Job with
  foreground propagation, transition `running` to `failed` with
  `heartbeat_timeout`, `error` `{ source: krun, message: "no status for
  <timeout>, last at <time>" }` and the tail as `logTail`, delete the
  Secret, enqueue the delivery. Functions without
  `heartbeatTimeout` are never judged by their reports; a hang there ends
  at `activeDeadlineSeconds` as `deadline_exceeded`.
- Scheduler restart: the informers' initial list replays the current Job
  and pod state, so a failure that happened while the scheduler was down
  is processed on start. A Job already removed by `ttlSecondsAfterFinished`
  becomes `job_lost` after the grace period.

Deliveries loop, every 5 seconds: claim pending deliveries due now, POST the
payload, mark `delivered` on 2xx. Otherwise increment `attempt`, set
`next_at` by the schedule 1m, 5m, 30m, 2h, 12h, and mark `dead` after the
fifth failure.

Sweep loop, every 10 minutes: delete runs finished before
`now - KRUN_RETENTION` in batches of 1000, and delete orphan Secrets in the
jobs namespace with label `krun.io/run-id` older than 1 hour.

## 9. Security

Authentication: API keys in a YAML file mounted from a Secret at
`KRUN_API_KEYS_PATH` as a directory, never `subPath`, reloaded by a 30
second poll on the content hash.
Comparison is constant-time. No key management API in v1.

```yaml
keys:
  - name: reports-service
    key: <random, at least 32 bytes>
    scopes: [runs:write, runs:read, functions:read]
    functions: ["report-*"]            # glob list, required unless scope admin
```

Authorization: a key may act only on functions matching its globs. Runs are
visible to their creator and to `admin`. `created_by` stores the key name.

Internal API: per-run token only, hashed with SHA-256 and compared with
`timingSafeEqual` against `runs.job_token_hash`, valid only while the run is
`scheduled` or `running`. The internal listener is a separate port and
Service, never exposed through the ingress; a NetworkPolicy on the gateway
pods admits the internal port only from the jobs namespace and leaves the
public port open. The token is never logged.

Jobs namespace, created by the chart when `jobsNamespace.create` is true:

- Pod Security Admission labels `enforce=restricted`.
- NetworkPolicy: default deny ingress and egress, allow egress to DNS, to
  the gateway internal port and to the object storage endpoint. Per-function
  extra egress is added by the platform team, not by krun.
- LimitRange with default requests and limits. ResourceQuota on pod count,
  CPU and memory requests.
- ServiceAccount `krun-job-default` with no RoleBindings.
- Role for the scheduler: `jobs` create, get, list, watch, delete;
  `pods` get, list, watch; `pods/log` get; `secrets` create, get, list,
  delete; `events` create. RoleBinding to the scheduler ServiceAccount. In
  the krun namespace: `coordination.k8s.io/leases` get, create, update;
  `functions.krun.io` get, list, watch; `functions.krun.io/status` patch.
- Role for the gateway in the krun namespace: `functions.krun.io` get, list,
  watch. Nothing else. Nothing cluster-wide except the CRD object itself.

Webhooks: callback hosts must match `KRUN_WEBHOOK_ALLOWED_HOSTS` globs. The
gateway resolves the host and rejects loopback, link-local and RFC 1918
addresses before accepting the run. The scheduler resolves the host again
at delivery time, applies the same checks and connects to the checked
address. Payloads are signed with HMAC-SHA256
over the body using `KRUN_WEBHOOK_SECRET`, header `X-Krun-Signature`,
plus `X-Krun-Delivery` and `X-Krun-Run-Id`. The payload is the run
representation at the terminal transition.

Secrets handling: function secrets are referenced by name, never stored by krun.
Input never goes into env vars or the Job manifest. Logs never include
input, results or keys.

Images: digest only. `KRUN_ALLOWED_REGISTRIES` optionally restricts image
prefixes.

## 10. Backpressure defaults

| Setting | Default | Note |
|---|---|---|
| rate limit per key | 10 req/s, burst 50 | per gateway replica |
| `maxQueued` per function | 1000 | 429 beyond |
| `KRUN_MAX_INPUT_BYTES` | 262144 | hard ceiling 1 MiB |
| `maxConcurrency` per function | 10 | |
| `KRUN_MAX_RUNNING` | 100 | global |
| `maxQueueTime` | 1h | fails with `queue_timeout` |
| `heartbeatTimeout` per function | unset | minimum 30s; stale runs fail with `heartbeat_timeout` |
| `activeDeadlineSeconds` | 3600 | ceiling `KRUN_MAX_ACTIVE_DEADLINE`, default 86400 |
| `backoffLimit` | 0 | no automatic retries |
| `ttlSecondsAfterFinished` | 300 | |
| `KRUN_MAX_RESULT_BYTES` | 262144 | hard ceiling 1 MiB; larger results use object storage |
| status reports | 1 per second per run | per gateway replica, 429 beyond |
| `KRUN_MAX_WAIT` | 60s | below ingress timeout |
| webhook attempts | 5 over about 15h | at-least-once |
| `KRUN_RETENTION` | 720h | sweep batch 1000 |
| lease | 30s | scheduler claim |
| job lost grace | 2m | |

## 11. Observability

Prometheus metrics on `/metrics` of each process:

```
krun_http_requests_total{route,code}
krun_http_request_seconds{route}
krun_admission_rejections_total{reason}         rate_limit, max_queued, input_size, schema
krun_runs_transitions_total{function,to}
krun_runs_current{function,state}
krun_queue_wait_seconds{function}                   created -> scheduled
krun_cold_start_seconds{function}                   scheduled -> running
krun_run_duration_seconds{function,state}           running -> terminal
krun_runs_failed_total{function,reason}             failureReason values
krun_terminal_detect_seconds{function}              container exit -> terminal state
krun_quota_rejections_total{function}
krun_scheduler_leader                           1 on the leader
krun_functions_synced                               1 after the Function informer's initial list
krun_functions{ready}                               Function count by readiness
krun_deliveries_total{state}
krun_sweep_deleted_total
```

Logs: JSON via pino, one line per event, fields `run_id`, `function`,
`state`, `reason` where relevant. Level from `KRUN_LOG_LEVEL`.

Health: `/healthz` always 200 when the process runs. `/readyz` checks the
database and the Function informer sync; the scheduler also reports leader status there
without failing readiness for standby replicas.

Shutdown on SIGTERM: the gateway stops listening, ends open SSE streams,
answers in-flight `wait` requests at once with the current state, closes
the pool and exits 0. The scheduler finishes the current loop iteration,
stops the informers, clears `holderIdentity` on the Lease so a standby takes
over at once, closes the pool and exits 0. Both fit the default 30 second
grace period.

## 12. Configuration

Environment variables. Flags are not supported except `--help`.

| Variable | Default | Used by |
|---|---|---|
| `KRUN_DB_MODE` | `postgres` | both. `postgres` or `embedded` |
| `KRUN_DB_DSN` | | both, postgres mode |
| `KRUN_DB_PATH` | `/data/krun.db` | both, embedded mode |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway |
| `KRUN_LISTEN_ADDR` | `:8080` | both |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | gateway, internal API |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | scheduler, injected into Jobs |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler |
| `KRUN_NAMESPACE` | pod namespace, read from the ServiceAccount `namespace` file | both: Functions and Lease |
| `KRUN_MAX_RUNNING` | `100` | scheduler |
| `KRUN_MAX_QUEUED` | `1000` | gateway, ceiling for `maxQueued` |
| `KRUN_MAX_INPUT_BYTES` | `262144` | gateway |
| `KRUN_MAX_RESULT_BYTES` | `262144` | gateway |
| `KRUN_MAX_WAIT` | `60s` | gateway |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | both, Function validation |
| `KRUN_TTL_AFTER_FINISHED` | `300` | scheduler |
| `KRUN_RETENTION` | `720h` | scheduler |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both |
| `KRUN_S3_PRESIGN_TTL` | function deadline | scheduler |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty, webhooks disabled | both |
| `KRUN_WEBHOOK_SECRET` | | scheduler |
| `KRUN_LOG_LEVEL` | `info` | both |

## 13. Deployment

Helm chart at `deploy/helm/krun`. Values shape:

```yaml
image: { repository: ghcr.io/xenarro/krun, tag: "" }   # tag defaults to appVersion

gateway:
  replicas: 2
  resources: {}
scheduler:
  replicas: 1          # extra replicas are standby
  resources: {}

db:
  mode: postgres        # postgres | embedded
  postgres:
    existingSecret: ""  # key: dsn
    dsn: ""
  embedded:
    storage: 1Gi
    storageClass: ""
    litestream:
      enabled: false
      url: s3://bucket/krun
      existingSecret: ""

functions: []               # Function resources, items { name, spec }
apiKeys:
  existingSecret: ""    # key: keys.yaml

jobsNamespace:
  name: krun-jobs
  create: true
  quota: { pods: "200", requests.cpu: "50", requests.memory: 100Gi }
  limitRange:
    defaultRequest: { cpu: 100m, memory: 128Mi }
    default:        { cpu: "1",  memory: 1Gi }
  egressCIDRs: []       # extra egress for all functions

objectStorage: { enabled: false, endpoint: "", bucket: "", region: "", existingSecret: "" }
webhooks: { allowedHosts: [], existingSecret: "" }
```

Postgres mode renders two Deployments. Migrations run in a Helm hook Job
(`pre-install`, `pre-upgrade`) executing `krun migrate`.

Embedded mode renders one StatefulSet with one replica and two containers,
gateway and scheduler, sharing one PVC. An init container runs
`krun migrate`. Chart rendering fails when `gateway.replicas` or
`scheduler.replicas` is above 1. With Litestream enabled, an init container
restores the database when the volume is empty and a sidecar streams the WAL
to object storage. SQLite in WAL mode supports two processes on one local
volume. Network filesystems are not supported.

Both modes render: the CRD from `crds/` (Helm installs it once and never
upgrades it; run `kubectl apply -f deploy/helm/krun/crds/` on upgrade),
Function resources from `functions`, Services (public, and `krun-gateway-internal`
for the internal port), the gateway NetworkPolicy from section 9,
ServiceAccounts, Roles and RoleBindings for the gateway and the scheduler, and the jobs namespace resources from section 9
when `jobsNamespace.create` is true.

## 14. Limits and boundaries

- Submission rate: a few runs per second sustained. The bound is Job
  creation and pod scheduling, not the database. Measured numbers go in the
  README after Phase 9.
- Cold start: seconds, dominated by scheduling and image pull. Functions shorter
  than their cold start belong in a worker pool, not in krun.
- Input: 256 KB default, 1 MiB hard.
- Inline result: 256 KB default, 1 MiB hard. Larger results need object
  storage.
- Error report: 4 KB message, 8 KB details. Log tail: 16 KB.
- Run history: retention window, default 30 days. Export for longer history
  is out of scope.
- Kubernetes 1.29 or newer: CEL validation rules in the CRD, Pod Security
  Admission labels.

## 15. Deferred to v2

- OIDC bearer token validation.
- Kueue integration: suspended Jobs with a queue label, krun keeps only
  per-function limits.
- Pool executor: long-running Deployment per function pulling runs from krun,
  scaled by KEDA on queue depth. The `Executor` seam is reserved in
  `apps/scheduler`.
- Fail fast on pods stuck in `ImagePullBackOff` or `Unschedulable` before
  `activeDeadlineSeconds`.
- SDKs for Go and Java; `krun dev`, a local gateway emulator for end-to-end
  runs without a cluster; a Backstage template wrapping `krun init`.
- Per-tenant jobs namespaces.
- Table partitioning when `runs` exceeds tens of millions of rows.
- Log archiving to object storage with `logs_ref`.
- Automatic retries with a per-function policy.
- API key management endpoints.

## 16. Decisions

| Id | Decision | Why |
|---|---|---|
| D1 | Implementation language Go, single static image | client-go informers and Lease leader election are first-class, pure Go SQLite driver, small image, fast tests on kind. Alternative considered: Scala 3 with ZIO, fabric8 and Mill. Change before Phase 0 if preferred. Superseded by D15. |
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
