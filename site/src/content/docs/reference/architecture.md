---
title: Architecture
description: The components of krun, how a run moves between them, the two storage modes, leader election, informers, scheduler loops and the per-run Job.
sidebar:
  order: 1
---

krun has two processes and one system of record. The **gateway** serves HTTP. The
**scheduler** turns queued runs into Kubernetes Jobs and records what happens to them.
The **database** is the only contract between the two: there is no RPC between
gateway and scheduler.

```text title="Topology" wrap=false
caller ──HTTP /v1 :8080──▶ krun-gateway ──SQL──▶ database ◀──SQL── krun-scheduler
                            ▲      ▲                                 │        │
                            │      └────── pg_notify (Postgres) ─────┘        │ kube API
                            │                                                 ▼
                            └── /internal/v1 :8081 ──── Job pods ◀──── Secret + Job
                                (per-run token)                       (jobs namespace)

admin listener :9090 on both processes: /healthz /readyz /metrics
Function resources (functions.krun.io): watched by an informer in both processes
object storage (optional): results above KRUN_MAX_RESULT_BYTES via presigned PUT
```

## Components

| Component | Role | Replicas | Kubernetes access |
|---|---|---|---|
| `krun-gateway` | Public `/v1` API: authentication, validation, idempotency, run creation, status, wait, SSE, results and cancel requests. Internal `/internal/v1` API on a second port for Job pods. | N, stateless (2 by default) | Read `functions.krun.io` in the krun namespace. |
| `krun-scheduler` | Claims queued runs, creates Jobs, watches Jobs and pods, writes state transitions, detects failures and heartbeat timeouts, handles cancels, delivers webhooks and sweeps old runs. | 1 active leader; extra replicas stand by | Jobs, pods, pod logs and Secrets in the jobs namespace; the Lease and Function status in the krun namespace. |
| Database | System of record for runs, their events and webhook deliveries. | Managed Postgres, or SQLite in embedded mode | none |
| `Function` resources | Function definitions in the krun namespace, read by an informer in both processes. | | |
| Object storage | Optional S3-compatible storage for large results. | | |
| Jobs namespace | Dedicated and hardened; holds Job pods and per-run Secrets. | | |

When the scheduler is down, the gateway still accepts runs and they queue. Cancel is a
run state that the scheduler acts on, not a call between processes.

All processes ship in **one container image** with the entrypoints `krun gateway`,
`krun scheduler`, `krun migrate` and `krun validate` (the image also carries `init`
and `deploy`). Its runtime is distroless Node.js 26, running as user `65532:65532`.

## Listeners and ports

| Port | Listener | Served by | Reachable from |
|---|---|---|---|
| 8080 | Public `/v1` API | gateway | anywhere you route it; the only port to expose |
| 8081 | Internal `/internal/v1` API | gateway | only the jobs namespace (NetworkPolicy) |
| 9090 | Admin: `/healthz`, `/readyz`, `/metrics` | gateway and scheduler | `networkPolicy.metricsFrom` |
| 9091 | Admin for the embedded scheduler | scheduler (embedded mode) | `networkPolicy.metricsFrom` |

Each listener answers 404 for the other listeners' paths. The public Service is named
after the Helm release; the internal Service is `krun-gateway-internal`. No Service
exposes the admin ports.

## The life of a run

1. **Admission (gateway).** The gateway authenticates the key, checks scope and rate
   limit, resolves the Function, enforces the body size, looks up an idempotent
   replay, validates the input against the compiled JSON Schema, checks the callback
   and the queue limits, then inserts the run as `queued`. It subscribes to the run
   before inserting, so a `wait` never misses an event.
2. **Claim (scheduler).** Every second, and on each state notification, the leader
   computes free slots per function (`maxConcurrency` minus scheduled and running)
   and globally (`KRUN_MAX_RUNNING`), and claims queued runs ordered by priority, then
   age, with a 30-second lease.
3. **Job creation (scheduler).** For each claimed run it creates the per-run Secret,
   stores the token's hash, creates the Job, and marks the run `scheduled`.
4. **Execution (pod).** The container fetches input, reports status and writes its
   result or error through the internal API, authenticated by the per-run token.
5. **Observation (scheduler).** Job and Pod informers report the pod's phase and the
   container's termination. `Running` moves the run to `running`; the Job's
   `Complete` condition to `succeeded`; `Failed` to `failed` with a classified
   `failureReason` and the captured log tail.
6. **Cleanup (scheduler).** Once the terminal state is recorded, the scheduler deletes
   the Secret and the Job. A webhook delivery row is written in the same transaction
   when the run has a callback.

Every transition is a compare-and-set on the current state, appends a `run_events`
row, and publishes a notification. A transition that finds the state already changed
is a stale event and is ignored.

## Run states

```text title="State machine" wrap=false
QUEUED ──> SCHEDULED ──> RUNNING ──> SUCCEEDED
   │           │            └──────> FAILED
   │           ├──> SUCCEEDED   (completed before RUNNING was observed)
   │           └──> FAILED
   ├──> FAILED                  (QUEUE_TIMEOUT or JOB_CREATE_FAILED)
   └──> CANCELLING ──> CANCELLED   (CancelRun from QUEUED, SCHEDULED or RUNNING)
```

Terminal states are `SUCCEEDED`, `FAILED` and `CANCELLED`. Once a run is `CANCELLING`
its only terminal state is `CANCELLED`, even if the pod finished meanwhile. There are
no automatic retries: Jobs run with `backoffLimit: 0`, and `attempt` counts scheduler
claims.

## Storage modes

### Postgres

Two Deployments: the gateway and the scheduler. Migrations run in a Helm
`pre-install,pre-upgrade` hook Job. Each process keeps a pool of 5 connections plus one
dedicated `LISTEN` client; `pg_notify('krun_runs', ...)` wakes waiting requests in
every gateway replica. Postgres 16 or newer is required.

### Embedded SQLite

One StatefulSet replica runs the gateway and scheduler containers side by side,
sharing one PVC with the database at `/data/krun.db`, opened through Node's built-in
`node:sqlite` in WAL mode. There is no notification channel: subscribers poll
`run_events` every second. Init containers run an optional Litestream restore and then
`krun migrate`; an optional Litestream native sidecar streams the WAL to object
storage. Network filesystems are not supported, and upgrades mean a brief downtime.

### Shared schema

Both modes share one schema with three tables: `runs`, `run_events` and
`deliveries`. Run ids are UUIDv7, so creation order and id order agree. Retention is a
batched delete; there is no table partitioning.

## Leader election

The scheduler elects a leader with a Kubernetes Lease named `krun-scheduler` in the
krun namespace: a 15-second lease, a 10-second renew deadline and a 2-second retry.
The holder identity is the pod name from `KRUN_POD_NAME`.

- The Function informer runs on every replica, because readiness depends on it.
- The Job and Pod informers, the loops and the Function status writer start only
  after the Lease is acquired, and stop on loss or SIGTERM.
- A leader that cannot renew for 10 seconds stops its work and exits non-zero;
  Kubernetes restarts it as a standby. On SIGTERM it clears the holder so a standby
  takes over at once.
- In Postgres mode the scheduler Deployment rolls with `maxSurge: 1` and
  `maxUnavailable: 0`, so a Ready standby exists before the leader stops.

## Informers

- **Functions**: both processes watch `Function` resources in `KRUN_NAMESPACE` and
  keep an in-memory map with the compiled input validator, cached per uid and
  generation. Changes reach both processes within about one second.
- **Jobs and pods**: the leader watches the jobs namespace with the label selector
  `krun.io/run-id`. It derives `jobStatus` (pod name, phase, reason, message, exit
  code) from Kubernetes alone and writes it only when something changed.
- Informers have no resync period, so a reconcile timer re-runs the handlers over the
  caches every 5 minutes. Error handlers restart a failed watch with backoff.

## Scheduler loops

| Loop | Cadence | Work |
|---|---|---|
| Main | Every 1 s and on state notifications; 10 s iteration deadline | Expire queued runs past `queueTimeout`, compute free slots, claim, create Secrets and Jobs, handle `cancelling` runs, detect lost Jobs. |
| Heartbeat | Every 10 s | Fail running runs with no status for their `heartbeatTimeout`. |
| Deliveries | Every 5 s | Claim up to 40 due webhooks, POST with concurrency 8 and a 10 s timeout. |
| Reconcile | Every 5 min, and once after sync | Re-run the Job and Pod handlers over the caches and the lost-Job check. |
| Sweep | Every 10 min | Delete runs finished before `KRUN_RETENTION` in batches of 1000, and orphan Secrets older than 1 hour. |

Kubernetes API calls share a limiter of `KRUN_K8S_CONCURRENCY` (default 8), each with a
10-second timeout. Transient errors (403 quota, 429, 5xx, network) release the lease
and back off that function for 2^n seconds, capped at 60; other 4xx responses fail the
run with `JOB_CREATE_FAILED`. A Job missing from the cache for more than 2 minutes
fails the run with `JOB_LOST`.

## The per-run Job

For each run the scheduler creates, in the jobs namespace:

- An immutable Secret `krun-<run id>` with key `token`: 32 random bytes, base64url.
  Only its SHA-256 is stored in the database, before the Job exists.
- A Job `krun-<run id>` with:
  - `backoffLimit: 0`, the Function's `activeDeadlineSeconds`, and
    `ttlSecondsAfterFinished` from `KRUN_TTL_AFTER_FINISHED` as a safety net;
  - `restartPolicy: Never` and `terminationGracePeriodSeconds: 30`;
  - `automountServiceAccountToken: false` and the Function's service account;
  - `runAsNonRoot`, the Function's UID and GID (65532 by default) and seccomp
    `RuntimeDefault`;
  - a container named `function` with a read-only root filesystem, all capabilities
    dropped, no privilege escalation and an `emptyDir` at `/tmp`;
  - tolerations of 60 seconds for `not-ready` and `unreachable` nodes;
  - `hostUsers: false` when `KRUN_JOB_HOST_USERS=false`.

The input never enters the environment or the manifest; the pod fetches it.

## Trust boundaries

- **Callers** hold an API key. It reaches the functions matching its globs and the runs
  it created; `admin` reaches everything. Callers never hold Kubernetes credentials.
- **Function pods** hold a per-run token that reaches one run, from the moment the
  token is set until the terminal transition, and at most `activeDeadlineSeconds`.
  Pods never hold database or API-key credentials, never reach the public API, the
  admin ports or the database, and never receive object-storage account credentials.
- **Function authors** in one installation form one trust domain: a Function may use
  any Secret the platform team placed in the jobs namespace and any allowed service
  account. Per-tenant namespaces are out of scope.
- **The platform team** holds the krun namespace, the jobs namespace and the API keys
  Secret.

The jobs namespace enforces Pod Security Admission `restricted`, default-deny ingress
and egress (with DNS, the gateway's port 8081 and configured storage egress allowed), a
LimitRange, a ResourceQuota and a ValidatingAdmissionPolicy that rejects any Job or Pod
image without `@sha256:`. krun does not verify image signatures; enforce them with your
admission policy.

## Technology

TypeScript on Node.js 26 with Effect 4, Fastify 5 for HTTP, Zod 4 for every schema,
Kysely over `pg` and the built-in `node:sqlite`, `@kubernetes/client-node`, the AWS SDK
v3 S3 client and OpenTelemetry. There are no native addons. The SDKs are TypeScript and
Python without runtime dependencies. Dependency versions are declared in each
package's `package.json` and locked in `pnpm-lock.yaml`; the HTTP contracts are the
[public API](/krun/reference/generated/public-api/) and the
[internal API](/krun/reference/generated/internal-api/).
