---
title: Roadmap
description: What is implemented in krun today, what is planned, which measured targets are met, and what is deliberately out of scope.
sidebar:
  order: 3
---

The platform, Helm chart, SDKs and CLI are implemented and tested from a source
checkout. What remains is the first release: verifying registry ownership and
publishing version 0.1.0. Both wait on owner decisions.

## Implemented

| Area | Scope |
|---|---|
| Foundation | pnpm workspace, Makefile, Dockerfile, CI, configuration schema, admin listener, Function schema. |
| Store | One store interface for Postgres and SQLite with migrations, idempotent run creation, claims with leases, compare-and-set transitions, listing, notifications and retention. |
| Webhooks, functions and auth | Webhook host and address checks, two-layer Function validation, Function informer, API keys with globs and scopes, `krun validate`. |
| Gateway | The public `/v1` API (functions, create, get, list, cancel, results) and the internal `/internal/v1` API. |
| Scheduler core | Job and Secret builders, Lease leader election, the main loop, Job and Pod informers, `JOB_LOST` detection, metrics, Function status, failure classification with log tails, heartbeats, the retention sweep and the kind e2e foundation. |
| Wait, SSE, webhooks | Wait on create and WaitRun, WatchRun over SSE, and signed webhook deliveries. |
| Object storage | Presigned uploads for large results and 307 downloads. |
| Helm chart | Both database modes, the hardened jobs namespace, RBAC, NetworkPolicies, optional HTTPRoute, chart reference, upgrade and rollback e2e, PodMonitor and PrometheusRule. |
| SDKs and CLI | Node.js and Python SDKs, a shared conformance suite, `krun init` for both languages and `krun deploy`. |
| Hardening | Backpressure e2e, security e2e, the native benchmark, the README quickstart in both modes, and verified operations alerts with an embedded restore drill. |

## Planned

| Item | What remains | Status |
|---|---|---|
| Release preconditions | The owner confirms the npm scope `@krun`, the PyPI project `krun` and GHCR `xenarro`, and sets up OIDC trusted publishing. | Planned, blocked on the owner |
| Release v0.1.0 | After an owner tag, `release.yml` publishes the signed image and OCI chart with an SBOM to GHCR, `@krun/sdk` and `@krun/cli` to npm, and `krun` to PyPI. Post-publication acceptance then verifies the signatures, a Helm install from the OCI chart, the published CLI and fresh SDK installs. | Planned, blocked on the owner |

The release tooling itself exists: the credential-free rehearsal passes in CI as the
`release.yml` dry-run job, and the owner-gated publication job exists but has never run
(see [Releases](/krun/project/releases/)).
What is missing is the owner's registry evidence, the tag and the post-publication
acceptance described in the [release preparation guide](/krun/reference/generated/release/).
The public `/v1` API becomes stable once v0.1.0 ships.

## Targets and measurements

The project sets performance targets; the benchmark measures them. Measured on
2026-11-03 on a local kind cluster (one Kubernetes 1.37.0 control-plane node, an AMD
Ryzen 7 5700X with 16 logical CPUs and 60.7 GiB RAM), with 500 successful `sleep 10`
runs and 20 `exit 1` runs per mode, closed-loop with 10 clients and
`maxConcurrency: 10`:

| Store mode | Submit to first RUNNING, p50 (s) | p95 (s) | Exit to observed FAILED, p95 (s) | Completed runs/s |
|---|---:|---:|---:|---:|
| embedded | 2.414 | 6.103 | 11.345 | 0.494 |
| postgres | 1.433 | 13.979 | 8.943 | 0.459 |

- **Submit to running under 15 seconds (p95)**: met by both loaded samples. The
  idle-cluster form of the target is not independently certified by this load test.
- **Crash to failed under 10 seconds**: **not demonstrated.** The embedded-mode p95
  was 11.345 seconds, above the target; the Postgres-mode p95 was 8.943 seconds.
- **Every failed run carries a `failureReason`**, input and tokens never appear in pod
  manifests or logs, and Job pods never reach the database or the public API: these
  are asserted by the failure-detection and security test suites.

These are local measurements, not a hosted CI result, a maximum-capacity figure or a
production guarantee. Reproduce them with `make bench`, then `make kind-down`.

## Out of scope

krun deliberately does not provide these, and they are not on the roadmap:

- workflows or DAGs, and cron scheduling (use a CronJob);
- sub-second functions and a pool executor;
- a web UI;
- multi-cluster operation and per-tenant namespaces;
- Kueue integration;
- automatic retries;
- log archiving;
- OIDC tokens and API key management endpoints;
- table partitioning;
- failing fast on pods stuck before start;
- a local gateway emulator;
- SDKs beyond Node.js and Python.

The public API also has no HTTP endpoints to create or update Functions (Kubernetes
is their write API), no DeleteRun and no UpdateRun.
