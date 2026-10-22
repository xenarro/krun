# krun specification

Status: v1 draft, 2026-10-22. This file is the source of truth for behavior.
PLAN.md holds the build order. Change this file only together with a new
entry in section 16 (Decisions).

## 1. Purpose

krun runs one-off tasks on Kubernetes. A client sends an HTTP request that
names a registered task and carries a JSON input. krun validates the input,
persists the request, creates a Kubernetes Job, tracks the Job to completion,
stores the result, and exposes status and result over HTTP.

Target workload: tasks that run from about 10 seconds to several hours,
submitted at up to a few runs per second sustained. Bursts are absorbed by
the queue.

Non-goals for v1: workflows or DAGs, sub-second tasks, cron scheduling (use
CronJob), web UI, multi-cluster, per-tenant namespaces, Kueue integration,
pool executor, automatic retries, log archiving.

## 2. Architecture

```
 actor ──HTTP──> krun-gateway ──SQL──> database <──SQL── krun-scheduler ──kube API──> Jobs
                      ^                                       │                      (jobs namespace)
                      └────────── pg_notify ──────────────────┘                          │
                                                                                         ▼
 registry ConfigMap: mounted in gateway and scheduler             result: termination message
 object storage (optional): results larger than 4 KB              or presigned PUT to object storage
```

Components:

| Component | Role | Replicas | Kubernetes RBAC | DB role |
|---|---|---|---|---|
| krun-gateway | HTTP API: auth, validation, idempotency, insert run, read status, wait, SSE, result, cancel request | N, stateless | none | select tasks; insert and select runs; insert run_events |
| krun-scheduler | claim queued runs, create Jobs, watch Jobs, state transitions, cancel, webhook deliveries, retention sweep | 1 active, standby allowed, leader election via Kubernetes Lease | Role in jobs namespace only | update runs; insert run_events; deliveries |
| database | system of record for runs | managed Postgres, or SQLite in embedded mode | | |
| registry | ConfigMap with task definitions | mounted in both | | |
| object storage | S3-compatible, optional | | | |
| jobs namespace | dedicated, hardened, holds Job pods and per-run Secrets | | | |

Contract between gateway and scheduler: the database only. No RPC between
them. When the scheduler is down, the gateway still accepts runs and they
queue. Cancel is a run state that the scheduler acts on.

One container image, three entrypoints: `krun gateway`, `krun scheduler`,
`krun migrate`.

Job pods never hold database or krun API credentials. Input reaches the pod
as a mounted Secret. Output leaves through the container termination
message or a presigned object storage URL.

## 3. Registry

ConfigMap key `tasks.yaml`, mounted at `KRUN_REGISTRY_PATH`.

```yaml
tasks:
  - name: report-generator                   # DNS-1123 label, unique
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
    maxQueueTime: 1h                         # default 1h
    nodeSelector: {}                         # optional
    imagePullSecrets: []                     # optional
    callback:                                # optional default webhook
      url: https://hooks.acme.com/krun
```

Load rules:

- Validate on load: unique label-safe names, image with digest, schema
  compiles, `activeDeadlineSeconds` within the ceiling.
- Invalid file: keep the last good registry, log the error, set
  `krun_registry_valid` to 0. At startup with no good registry, readiness
  fails.
- Reload: poll the file every 30 seconds, reload when the content hash
  changes. No file watcher.
- Gateway uses `name` and `inputSchema`. Scheduler uses everything else.

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
| `GET /readyz` | none | database reachable and registry valid |
| `GET /metrics` | none | Prometheus |
| `GET /v1/tasks` | tasks:read | names and input schemas the key may use |
| `GET /v1/tasks/{task}` | tasks:read | |
| `POST /v1/tasks/{task}/runs` | runs:write | create run, optional `?wait=30s` |
| `GET /v1/runs/{id}` | runs:read | optional `?wait=30s` |
| `GET /v1/runs` | runs:read | filters `task`, `state`, `since`, `until`, `limit` (max 200), `cursor` |
| `GET /v1/runs/{id}/events` | runs:read | SSE of state changes, closes after terminal state |
| `GET /v1/runs/{id}/result` | runs:read | 200 inline JSON, 307 to presigned GET, 404 none, 409 not terminal |
| `DELETE /v1/runs/{id}` | runs:write | cancel: 202 if queued, scheduled or running, 409 if terminal |

A key sees only runs it created unless it has scope `admin`.

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
| 401 / 403 | missing key, or key not allowed for this task |
| 404 | task not in registry |
| 413 | input larger than `KRUN_MAX_INPUT_BYTES` |
| 422 | `Idempotency-Key` reused with different input |
| 429 | rate limit or `maxQueued` reached, with `Retry-After` |

Run representation:

```json
{ "id": "019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "task": "report-generator",
  "state": "running",
  "attempt": 1,
  "priority": 0,
  "input": { },
  "result": null,
  "resultRef": null,
  "error": null,
  "jobName": "krun-019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  "createdBy": "reports-service",
  "createdAt": "2026-10-22T10:00:00.000Z",
  "scheduledAt": null, "startedAt": null, "finishedAt": null }
```

Wait semantics: `wait` is capped at `KRUN_MAX_WAIT` (default 60s, keep below
the ingress timeout). On create, the gateway subscribes to the run id before
inserting the row so no event is missed. Client disconnect never cancels a
run.

Idempotency:

- Header `Idempotency-Key`, optional, at most 128 characters. Unique per
  (key name, task). Stored with a SHA-256 of the canonical JSON input.
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
| scheduled | running | scheduler | Job reports an active pod |
| running | succeeded | scheduler | Job condition `Complete` |
| scheduled, running | failed | scheduler | Job condition `Failed`, or Job missing after grace (`job_lost`) |
| queued | failed | scheduler | queued longer than `maxQueueTime` (`queue_timeout`) |
| queued, scheduled, running | cancelling | gateway | DELETE |
| cancelling | cancelled | scheduler | Job deleted or absent |

Rules:

- Every transition is a compare-and-set: `update runs set state = $to ...
  where id = $id and state = $from`. Zero rows affected means a stale event.
  Ignore it and log at debug.
- Every successful transition appends a `run_events` row and publishes
  `pg_notify('krun_runs', '<id>:<state>')` in Postgres mode.
- `attempt` counts scheduler claims. There are no automatic retries in v1:
  Jobs run with `backoffLimit: 0`. A client retries by submitting a new run.
- `error` on failure holds the termination message if present, otherwise
  the last 100 log lines of the pod, capped at 16 KB.

## 6. Data model

One schema, two dialects. Table and column names are identical. Migrations
live in `internal/store/migrations/postgres` and
`internal/store/migrations/sqlite`.

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
  task_name        text not null,
  input            jsonb not null,
  state            text not null
                   check (state in ('queued','scheduled','running',
                                    'succeeded','failed','cancelling','cancelled')),
  priority         int  not null default 0,
  attempt          int  not null default 0,
  lease_owner      text,
  lease_until      timestamptz,
  job_name         text,
  result           jsonb,
  result_ref       text,
  error            text,
  callback_url     text,
  created_by       text not null,
  created_at       timestamptz not null,
  scheduled_at     timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz
);

create unique index runs_idem_idx on runs (created_by, task_name, idempotency_key)
  where idempotency_key is not null;
create index runs_queue_idx    on runs (priority desc, created_at) where state = 'queued';
create index runs_active_idx   on runs (task_name) where state in ('scheduled','running');
create index runs_task_idx     on runs (task_name, created_at desc);
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
  where  state = 'queued' and task_name = $3
    and (lease_until is null or lease_until < $4)
  order  by priority desc, created_at
  for update skip locked
  limit  $5)
returning *;
```

SQLite: same statement without `for update skip locked`, inside
`begin immediate`. The claim takes a lease only. State changes after the Job
exists. An expired lease makes the row claimable again.

Store interface (package `internal/store`), implemented for both dialects
and verified by one shared contract test suite:

```
CreateRun(run) (run, created bool)             // dedupe on idempotency key
GetRun(id) run
ListRuns(filter, cursor, limit) ([]run, next)
CountActive() map[task]int                      // scheduled + running per task
ClaimQueued(task, owner, leaseUntil, limit) []run
ReleaseLease(id)
MarkScheduled(id, jobName)                      // queued -> scheduled, clears lease
Transition(id, from, to, reason, patch) bool    // compare-and-set, appends run_events
ExpireQueued(task, olderThan) int               // queued -> failed queue_timeout
Subscribe(ctx) <-chan (id, state)
EnqueueDelivery(delivery)
ClaimDeliveries(now, limit) []delivery
UpdateDelivery(id, state, attempt, nextAt, lastError)
Sweep(finishedBefore, batch) int
Migrate()
```

Postgres `Subscribe` uses `LISTEN krun_runs`. SQLite `Subscribe` polls
`run_events` every 1 second. Both modes keep a 1 second poll fallback in the
wait handler.

SQLite pragmas, set on every connection:

```
journal_mode = WAL
synchronous  = NORMAL
busy_timeout = 5000
foreign_keys = ON
auto_vacuum  = INCREMENTAL
```

One writer connection, a small reader pool. Sweep runs
`pragma incremental_vacuum` after each batch.

## 7. Job contract

Per claimed run the scheduler creates, in the jobs namespace:

1. Secret `krun-<run id>`, key `input.json`, labels `krun.io/run-id`,
   `krun.io/task`. No owner reference. The scheduler deletes it on the
   terminal transition. A sweep deletes orphans older than 1 hour by label.
2. Job `krun-<run id>` (41 characters, within the 63 limit):

```yaml
metadata:
  labels: { krun.io/run-id: <id>, krun.io/task: <task> }
spec:
  backoffLimit: 0
  activeDeadlineSeconds: <task value>
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: <task value>
      automountServiceAccountToken: false
      imagePullSecrets: <task value>
      nodeSelector: <task value>
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: task
          image: <digest-pinned image>
          imagePullPolicy: IfNotPresent
          resources: <task value>
          env:
            - { name: KRUN_RUN_ID, value: <id> }
            - { name: KRUN_TASK, value: <task> }
            - { name: KRUN_INPUT_PATH, value: /krun/input.json }
            - { name: KRUN_RESULT_UPLOAD_URL, value: <presigned PUT, only when object storage configured> }
            - <task env>
          envFrom: [{ secretRef: { name: <each secretRef> } }]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          terminationMessagePolicy: File
          volumeMounts:
            - { name: input, mountPath: /krun, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: input
          secret: { secretName: krun-<id> }
        - name: tmp
          emptyDir: {}
```

Task container contract:

- Read input from the file at `KRUN_INPUT_PATH`.
- Exit code 0 means success. Any other code means failure.
- Result up to 4096 bytes: write JSON to `/dev/termination-log`.
- Larger result: HTTP PUT the body to `KRUN_RESULT_UPLOAD_URL` before exit.
  The URL expires with `activeDeadlineSeconds`.
- No krun library is needed inside the image.

Result extraction on `Complete`: the scheduler reads the termination message
of the `task` container. Valid JSON becomes `result`. If object storage is
configured and the run's object exists, `result_ref` is set. Both may be
set. Neither set means `result` is null.

## 8. Scheduler

Only the leader runs the loops. Leader election uses a Kubernetes Lease
named `krun-scheduler` in the krun namespace with a 15 second lease, 10
second renew deadline, 2 second retry.

Main loop, every 1 second and on each notify:

1. Expire queued runs past their task's `maxQueueTime`.
2. Read active counts per task. Free slots per task are
   `maxConcurrency - active`, and globally `KRUN_MAX_RUNNING - sum(active)`.
3. For each task with free slots, claim up to the smaller of the two, lease
   30 seconds.
4. For each claimed run: create Secret, create Job (AlreadyExists counts as
   success), `MarkScheduled`. On `Forbidden` from quota, release the lease
   and back off that task for `2^n` seconds, capped at 60, with metric
   `krun_quota_rejections_total`. On any other API error, release the lease
   and log.
5. For each run in `cancelling`: delete the Job with foreground propagation,
   delete the Secret, transition to `cancelled`.

Job informer: label selector `krun.io/run-id`, jobs namespace only, resync
every 5 minutes. On each Job event, map `status.active > 0` to `running`,
condition `Complete` to `succeeded`, condition `Failed` to `failed`. On the
terminal transition: extract the result, capture the failure error, delete
the Secret.

Lost Jobs: a run in `scheduled` or `running` whose Job is absent for more
than 2 minutes fails with reason `job_lost`.

Deliveries loop, every 5 seconds: claim pending deliveries due now, POST the
payload, mark `delivered` on 2xx. Otherwise increment `attempt`, set
`next_at` by the schedule 1m, 5m, 30m, 2h, 12h, and mark `dead` after the
fifth failure.

Sweep loop, every 10 minutes: delete runs finished before
`now - KRUN_RETENTION` in batches of 1000, and delete orphan Secrets in the
jobs namespace with label `krun.io/run-id` older than 1 hour.

## 9. Security

Authentication: API keys in a YAML file mounted from a Secret at
`KRUN_API_KEYS_PATH`, reloaded on the same 30 second poll as the registry.
Comparison is constant-time. No key management API in v1.

```yaml
keys:
  - name: reports-service
    key: <random, at least 32 bytes>
    scopes: [runs:write, runs:read, tasks:read]
    tasks: ["report-*"]            # glob list, required unless scope admin
```

Authorization: a key may act only on tasks matching its globs. Runs are
visible to their creator and to `admin`. `created_by` stores the key name.

Jobs namespace, created by the chart when `jobsNamespace.create` is true:

- Pod Security Admission labels `enforce=restricted`.
- NetworkPolicy: default deny ingress and egress, allow egress to DNS and to
  the object storage endpoint. Per-task extra egress is added by the
  platform team, not by krun.
- LimitRange with default requests and limits. ResourceQuota on pod count,
  CPU and memory requests.
- ServiceAccount `krun-job-default` with no RoleBindings.
- Role for the scheduler: `jobs` create, get, list, watch, delete;
  `pods` get, list, watch; `pods/log` get; `secrets` create, get, list,
  delete; `events` create. RoleBinding to the scheduler ServiceAccount. In
  the krun namespace: `coordination.k8s.io/leases` get, create, update.
  Nothing cluster-wide. The gateway ServiceAccount has no RBAC.

Webhooks: callback hosts must match `KRUN_WEBHOOK_ALLOWED_HOSTS` globs. The
gateway resolves the host and rejects loopback, link-local and RFC 1918
addresses before accepting the run. Payloads are signed with HMAC-SHA256
over the body using `KRUN_WEBHOOK_SECRET`, header `X-Krun-Signature`,
plus `X-Krun-Delivery` and `X-Krun-Run-Id`.

Secrets handling: task secrets are referenced by name, never stored by krun.
Input never goes into env vars or the Job manifest. Logs never include
input, results or keys.

Images: digest only. `KRUN_ALLOWED_REGISTRIES` optionally restricts image
prefixes.

## 10. Backpressure defaults

| Setting | Default | Note |
|---|---|---|
| rate limit per key | 10 req/s, burst 50 | per gateway replica |
| `maxQueued` per task | 1000 | 429 beyond |
| `KRUN_MAX_INPUT_BYTES` | 262144 | hard ceiling 1 MiB, Secret size limit |
| `maxConcurrency` per task | 10 | |
| `KRUN_MAX_RUNNING` | 100 | global |
| `maxQueueTime` | 1h | fails with `queue_timeout` |
| `activeDeadlineSeconds` | 3600 | ceiling `KRUN_MAX_ACTIVE_DEADLINE`, default 86400 |
| `backoffLimit` | 0 | no automatic retries |
| `ttlSecondsAfterFinished` | 300 | |
| termination message | 4096 bytes | kubelet limit |
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
krun_runs_transitions_total{task,to}
krun_runs_current{task,state}
krun_queue_wait_seconds{task}                   created -> scheduled
krun_cold_start_seconds{task}                   scheduled -> running
krun_run_duration_seconds{task,state}           running -> terminal
krun_quota_rejections_total{task}
krun_scheduler_leader                           1 on the leader
krun_registry_valid                             1 or 0
krun_deliveries_total{state}
krun_sweep_deleted_total
```

Logs: JSON via `log/slog`, one line per event, fields `run_id`, `task`,
`state`, `reason` where relevant. Level from `KRUN_LOG_LEVEL`.

Health: `/healthz` always 200 when the process runs. `/readyz` checks the
database and the registry; the scheduler also reports leader status there
without failing readiness for standby replicas.

## 12. Configuration

Environment variables. Flags are not supported except `--help`.

| Variable | Default | Used by |
|---|---|---|
| `KRUN_DB_MODE` | `postgres` | both. `postgres` or `embedded` |
| `KRUN_DB_DSN` | | both, postgres mode |
| `KRUN_DB_PATH` | `/data/krun.db` | both, embedded mode |
| `KRUN_REGISTRY_PATH` | `/etc/krun/tasks.yaml` | both |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway |
| `KRUN_LISTEN_ADDR` | `:8080` | both |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler |
| `KRUN_NAMESPACE` | pod namespace | scheduler, Lease |
| `KRUN_MAX_RUNNING` | `100` | scheduler |
| `KRUN_MAX_QUEUED` | `1000` | gateway |
| `KRUN_MAX_INPUT_BYTES` | `262144` | gateway |
| `KRUN_MAX_WAIT` | `60s` | gateway |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | both, registry validation |
| `KRUN_TTL_AFTER_FINISHED` | `300` | scheduler |
| `KRUN_RETENTION` | `720h` | scheduler |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both |
| `KRUN_S3_PRESIGN_TTL` | task deadline | scheduler |
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

registry:
  tasks: []             # rendered into the ConfigMap
apiKeys:
  existingSecret: ""    # key: keys.yaml

jobsNamespace:
  name: krun-jobs
  create: true
  quota: { pods: "200", requests.cpu: "50", requests.memory: 100Gi }
  limitRange:
    defaultRequest: { cpu: 100m, memory: 128Mi }
    default:        { cpu: "1",  memory: 1Gi }
  egressCIDRs: []       # extra egress for all tasks

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

Both modes render: ConfigMap for the registry, Services, ServiceAccounts,
Role and RoleBinding for the scheduler, Lease RBAC, and the jobs namespace
resources from section 9 when `jobsNamespace.create` is true.

## 14. Limits and boundaries

- Submission rate: a few runs per second sustained. The bound is Job
  creation and pod scheduling, not the database. Measured numbers go in the
  README after Phase 8.
- Cold start: seconds, dominated by scheduling and image pull. Tasks shorter
  than their cold start belong in a worker pool, not in krun.
- Input: 256 KB default, 1 MiB hard.
- Inline result: 4096 bytes. Larger results need object storage.
- Error text: 16 KB.
- Run history: retention window, default 30 days. Export for longer history
  is out of scope.

## 15. Deferred to v2

- OIDC bearer token validation.
- Kueue integration: suspended Jobs with a queue label, krun keeps only
  per-task limits.
- Pool executor: long-running Deployment per task pulling runs from krun,
  scaled by KEDA on queue depth. The `Executor` seam is reserved in
  `internal/scheduler`.
- Init-container input fetch with a per-run token, replacing the per-run
  Secret when etcd pressure or input size requires it.
- Internal endpoints `/internal/runs/{id}/input` and
  `/internal/runs/{id}/result`.
- Per-tenant jobs namespaces.
- Table partitioning when `runs` exceeds tens of millions of rows.
- Log archiving to object storage with `logs_ref`.
- Automatic retries with a per-task policy.
- API key management endpoints.

## 16. Decisions

| Id | Decision | Why |
|---|---|---|
| D1 | Implementation language Go, single static image | client-go informers and Lease leader election are first-class, pure Go SQLite driver, small image, fast tests on kind. Alternative considered: Scala 3 with ZIO, fabric8 and Mill. Change before Phase 0 if preferred. |
| D2 | No CRD, no operator pattern | a custom database was chosen for history and queries; Kubernetes is the execution engine only |
| D3 | Postgres as system of record, SQLite as `db.mode: embedded` | every krun need maps to a built-in feature, shared SQL across both, Litestream for embedded backups |
| D4 | No Kafka, Redis, RocksDB, LevelDB or other KV engines | Kafka has no lookup or update by id; Redis is not a system of record; KV engines mean hand-built indexes with no gain at this write rate |
| D5 | Gateway and scheduler are separate containers and Deployments; the only contract is the database | independent scaling, no RPC coupling, gateway keeps accepting when the scheduler is down |
| D6 | Job pods never hold database or krun credentials; input via per-run Secret, output via termination message or presigned URL | one compromised task image must not read other tenants' data; no SDK inside task images |
| D7 | API keys in a mounted Secret file, not in the database | no key management API needed in v1; the Secret is the protection boundary |
| D8 | No automatic retries, `backoffLimit: 0` | retries with side effects must be visible and chosen by the client |
| D9 | Run ids are UUIDv7 | time-ordered ids give stable cursor pagination and match `created_at` order |
| D10 | No table partitioning in v1 | Postgres requires the partition key inside unique constraints, which breaks the idempotency index; batched delete suffices |
| D11 | Per-run Secret has no owner reference; scheduler deletes it on terminal transition plus orphan sweep | avoids a create-patch dance against the Job UID |
| D12 | Registry and keys reload by 30 second polling, not file watchers | ConfigMap mounts update via symlink swap; polling is enough and needs no dependency |
| D13 | Failure error holds a log tail, success stores no logs | enough to debug a failed run without a log pipeline; archiving is v2 |
| D14 | Target workload stated as tens of seconds to hours | Job-per-run cold start and API server load make sub-second or high-rate tasks a poor fit |
