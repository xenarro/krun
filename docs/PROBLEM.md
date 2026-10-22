# The problem krun solves

Status: 2026-10-22. Companion to SPEC.md (what krun does) and PLAN.md (how it
is built). This file says why.

## In one sentence

Service teams need to run a piece of code that takes seconds to hours,
triggered on demand by an HTTP call from another service, with validated
input, durable status, a result and isolation, on the Kubernetes cluster
they already have, without each team re-implementing Job orchestration,
queues and status tracking.

## Who has the problem

- **Callers**: backend services and their developers. They need "run this
  and tell me when it is done": reports, exports, batch inference, data
  migrations, media processing, third-party integrations. They want an HTTP
  API: 202, status, result, idempotency, a webhook. They must not hold
  Kubernetes credentials.
- **Function authors**: engineers who own the code that runs. They want to
  write a handler, build an image, register it, and see failures with a
  reason and logs. They do not want to write Job manifests, RBAC,
  NetworkPolicies, queues, retry logic or status plumbing.
- **Platform operators**: they want one small thing to run: two processes,
  one database, one CRD, minimal RBAC, a hardened namespace, quotas,
  metrics, backups and an upgrade path. No new queue, no new cluster.

## What happens today

- **Each service calls the Kubernetes API itself.** Needs RBAC, a client
  library, Job watching, cleanup, input delivery, status storage. Repeated
  per team, inconsistent, and every caller becomes a Kubernetes principal.
- **CronJobs.** Scheduled, not on demand. No input per invocation, no
  result path.
- **Queue plus always-on workers** (Celery, BullMQ, SQS consumers). Workers
  idle or scale by hand, one language per worker pool, no isolation per
  run, resource limits per pool instead of per run.
- **Argo Workflows.** Right for DAGs. One CRD object per run in etcd,
  workflow semantics, a UI; no first-class HTTP API with input validation;
  heavy for single-step runs; history in etcd or an archive database.
- **Knative Functions and Serving.** Request and response over HTTP with
  timeouts in seconds to minutes and scale to zero. Wrong shape for runs
  that take hours and need durable status.
- **Serverless** (Lambda, Cloud Run jobs). Time limits, vendor lock-in,
  outside the cluster, data egress.
- **Temporal, Conductor.** Durable workflows, excellent, heavy: a cluster of
  services, SDK-coupled workers, significant operational weight.

## The gap

An HTTP-triggered, queue-backed, Job-per-run executor with:

- input validation by JSON Schema, idempotency keys, rate limits;
- durable run history in a database with status, result, error and
  webhook delivery;
- per-function limits: concurrency, queue depth, queue time, deadline;
- pod isolation: Pod Security Admission `restricted`, default-deny
  NetworkPolicy, a per-run token, no credentials in the pod;
- runtime truth from Kubernetes (Job and Pod state, exit codes, log tail)
  plus optional progress reports from the function;
- a golden path for authors: `krun init`, an SDK in Node.js or Python,
  local mode, `krun deploy`, `kubectl get kfn`;
- a small operator footprint: gateway, scheduler, managed Postgres or
  embedded SQLite, one CRD, one Helm chart.

## Target workload and its boundaries

Runs of 10 seconds to several hours, submitted at up to a few per second
sustained, bursts absorbed by the queue. Not for sub-second work, not for
tens of runs per second, not for DAGs, not for cron (use CronJob). Cold
start is seconds, dominated by scheduling and image pull.

## Success criteria

| Criterion | Target | Proven by |
|---|---|---|
| Author time to first `succeeded` run on a fresh cluster, README only | under 30 minutes | PLAN P9.4 |
| Submit to `running`, idle cluster, cached image | p95 under 15 seconds | PLAN P9.3 |
| Failed runs carrying `failureReason` | 100 percent | PLAN P4.8 tests |
| Crash to `failed` | under 10 seconds | `krun_terminal_detect_seconds`, P4.8 |
| Input and tokens visible in pod manifests or logs | never | PLAN P9.2 |
| Job pod reaching the database or the public API | never | PLAN P9.2 |
| Kubernetes RBAC held by callers | none | SPEC section 9 |
| Install | one `helm install` | PLAN P7.6 |
| Embedded mode restore from object storage | works | PLAN P9.6 |

## Assumptions and risks

- Assumption: seconds of cold start are acceptable for the target workload.
  If a user needs sub-second starts, the pool executor (a non-goal in SPEC section 1)
  is the answer, not tuning.
- Assumption: a few runs per second is enough for v1. The bound is Job
  creation and pod scheduling, not the database (SPEC section 14).
- Risk: etcd churn from one Secret and one Job per run. Mitigated by small
  Secrets, `ttlSecondsAfterFinished` and the orphan sweep.
- Risk: gateway readiness depends on the API server at startup (SPEC D17).
  Accepted; after sync the informer cache serves through an outage.
- Risk: single scheduler leader. Throughput measured in PLAN P9.3; the
  claim query batches by function.
- Risk: a function that reports nothing and hangs is bounded only by
  `activeDeadlineSeconds` unless it sets `heartbeatTimeout` (SPEC D19).

## How the design answers it

| Need | Design | Decision |
|---|---|---|
| Callers without Kubernetes access | gateway with API keys, database as the only contract | D5, D7 |
| No credentials in pods | per-run token, private internal API | D6, D16 |
| Per-team registration with validation | `Function` CRD, informers, status | D17, D21 |
| Truth from Kubernetes | Job and Pod informers, `failureReason`, log tail | D18, D19 |
| Author golden path | SDKs, `krun init`, `krun deploy` | D20, D22 |
| Small footprint | Node.js single image, Postgres or SQLite, one chart | D3, D15 |
