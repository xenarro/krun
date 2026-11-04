---
title: Introduction
description: What krun is, who it is for, how a run flows through it, and when you should choose something else.
sidebar:
  order: 1
---

krun runs **HTTP-triggered functions executed as one-off Kubernetes Jobs**. Submit
JSON over HTTP; receive durable status, an inline or object-storage result, and
classified failures without giving callers Kubernetes credentials.

A gateway authenticates and admits Runs. One elected scheduler creates Jobs,
observes their actual exits, persists transitions and sends optional signed
webhooks. Function definitions are Kubernetes `Function` resources, not HTTP
create or update endpoints. Node.js and Python SDKs implement the small internal
HTTP contract; any container with an HTTP client can implement it instead.

:::caution[Project status]
The platform, Helm chart, SDKs and CLI are implemented and tested, but **nothing has
been published yet**: there is no tagged release, container image, OCI chart, npm
package or PyPI package. Every installation path on this site works from a source
checkout. See [Releases](/krun/project/releases/) and [Roadmap](/krun/project/roadmap/).
:::

## The problem it solves

Service teams often need to run a piece of code that takes seconds to hours,
triggered on demand by another service, with validated input, durable status, a
result and isolation, on the Kubernetes cluster they already have. Without a shared
service, each team re-implements Job orchestration, queues and status tracking, and
every caller becomes a Kubernetes principal.

krun is a single, small platform component for that job: two processes (gateway and
scheduler), one database (managed Postgres or embedded SQLite), one CRD and one Helm
chart. There is no new queue and no new cluster.

## Who it is for

- **Callers** are backend services that need "run this and tell me when it is done":
  reports, exports, batch inference, data migrations, media processing or
  third-party integrations. They use an HTTP API with scoped API keys and never hold
  Kubernetes credentials.
- **Function authors** own the code that runs. They write a handler, build an image
  and register it as a `Function`. krun takes care of the Job manifest, RBAC,
  NetworkPolicies, queueing and status plumbing.
- **Platform operators** install one chart, hand out API keys and namespace roles,
  and watch metrics and alerts.

## How a run flows

1. A caller sends `POST /v1/functions/{function}/runs` with a JSON `input` and a
   bearer API key. The gateway checks the key's scope and function globs, the rate
   limit, the input size, the function's JSON Schema and its queue limits, then
   stores the run as `QUEUED`. The gateway and scheduler share only the database, so
   runs keep queueing while the scheduler is down.
2. The elected scheduler claims queued runs within each function's
   `maxConcurrency` and the global `KRUN_MAX_RUNNING`. For each one it creates a
   per-run Secret holding a fresh token and a Job named `krun-<run id>` in the
   hardened jobs namespace. The run becomes `SCHEDULED`, then `RUNNING` when the pod
   runs.
3. The function container fetches its input from the gateway's internal API with
   the per-run token, may report progress, and writes its result (or uploads a large
   result to object storage) before it exits.
4. The scheduler watches the Job and Pod. The exit code decides the outcome:
   `SUCCEEDED`, or `FAILED` with a `failureReason` such as `EXIT_CODE`,
   `OOM_KILLED` or `DEADLINE_EXCEEDED`, plus the last log lines.
5. The caller reads the run with `GetRun`, waits with `WaitRun` or `?wait=`, streams
   it with server-sent events, and fetches the result with `GetRunResult`. When the
   run has a callback URL, krun also POSTs a signed webhook at the terminal state.

The truth about a run comes from Kubernetes, never from the function's own reports.
The [architecture reference](/krun/reference/architecture/) describes every component
and loop in detail.

## What you get

- A resource-oriented public API: create runs with an optional idempotency key and a
  bounded wait, read, list with filters, wait, watch over SSE, cancel and fetch
  results.
- Scoped API keys from a mounted Secret, reloaded every 30 seconds, with per-key
  function globs, per-key queue limits and an optional priority scope.
- Backpressure by default: a per-key token bucket, per-function `maxQueued` and
  `maxConcurrency`, a global running limit, queue timeouts, deadlines and optional
  heartbeats.
- Failure classification on every failed run, a captured log tail, and detection of
  Jobs that disappear (`JOB_LOST`).
- Signed, at-least-once webhooks with SSRF address checks.
- Optional S3-compatible storage for results larger than the inline limit, through
  presigned URLs; function pods never receive storage credentials.
- A hardened Helm chart: Pod Security Admission `restricted`, default-deny
  NetworkPolicies, quotas, a digest-only admission policy, namespaced author and
  log-viewer roles, optional HTTPRoute, PodMonitor and PrometheusRule.
- Dependency-free Node.js (22+) and Python (3.11+) SDKs with a local mode, and a
  `krun` CLI with `init`, `deploy` and `validate`.

## When to use krun

Use krun for bounded, isolated batch work, internal report generation and
HTTP-triggered compute that already belongs on Kubernetes. The target workload is
runs from about 10 seconds to several hours, submitted at up to a few runs per
second sustained, with bursts absorbed by the queue. Cold start takes seconds and is
dominated by scheduling and image pull.

Choose **Postgres** for replicated gateway and scheduler processes and a separately
operated database. Choose **embedded SQLite** for a single shared Pod and PVC,
accepting downtime on restart and upgrade; optional Litestream replication is an
operations concern.

## When not to use krun

- **Not an always-warm, sub-second request handler.** Every run creates a Job.
- **Not a workflow or DAG engine**, cron scheduler (use a CronJob), automatic retry
  engine, message broker, autoscaler, multi-region control plane or dashboard. There
  is no web UI.
- **Not hostile-code multitenancy.** Function authors and the platform team share a
  trust boundary. Pod Security Admission, quotas and default-deny networking reduce
  blast radius, but function-image signature verification belongs to platform
  admission policy.
- **Not a Kubernetes replacement or a local gateway emulator.** SDK local mode runs a
  handler once without network access.
- **Not multi-cluster, and not per-tenant namespaces.** One installation is one trust
  domain for function authors.

## Next steps

- Rehearse the whole platform on a disposable kind cluster with the
  [quickstart](/krun/start/quickstart/).
- Install the chart on your own cluster with [installation](/krun/start/installation/).
- Write and deploy your first function with
  [writing a function](/krun/guides/writing-a-function/) and the
  [CLI guide](/krun/guides/cli/).
- Call the API with [invoking runs over HTTP](/krun/guides/invoking-runs/).
