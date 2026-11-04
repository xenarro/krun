---
title: Roadmap
description: What is implemented in krun today, what is planned, which measured targets are met, and what is deliberately out of scope.
sidebar:
  order: 3
---

The build plan in [PLAN.md](https://github.com/xenarro/krun/blob/main/PLAN.md) is
organized in ten phases. Every task in Phases 1 to 8 is done, and so are five of the
six Phase 9 tasks. The two open tasks are both about release and publication, and both
wait on owner decisions.

## Implemented

| Phase | Scope |
|---|---|
| 0. Scaffold | pnpm workspace, Makefile, Dockerfile, CI, configuration schema, admin listener, Function schema (P0.1 to P0.8). |
| 1. Store | One store interface for Postgres and SQLite with migrations, idempotent run creation, claims with leases, compare-and-set transitions, listing, notifications and retention. |
| 2. Webhooks, functions and auth | Webhook host and address checks, two-layer Function validation, Function informer, API keys with globs and scopes, `krun validate`. |
| 3. Gateway | The public `/v1` API (functions, create, get, list, cancel, results) and the internal `/internal/v1` API. |
| 4. Scheduler core | Job and Secret builders, Lease leader election, the main loop, Job and Pod informers, `JOB_LOST` detection, metrics, Function status, failure classification with log tails, heartbeats, the retention sweep and the kind e2e foundation. |
| 5. Wait, SSE, webhooks | Wait on create and WaitRun, WatchRun over SSE, and signed webhook deliveries. |
| 6. Object storage | Presigned uploads for large results and 307 downloads. |
| 7. Helm chart | Both database modes, the hardened jobs namespace, RBAC, NetworkPolicies, optional HTTPRoute, chart reference, upgrade and rollback e2e, PodMonitor and PrometheusRule. |
| 8. SDKs and CLI | Node.js and Python SDKs, a shared conformance suite, `krun init` for both languages and `krun deploy`. |
| 9. Hardening (partial) | Backpressure e2e (P9.1), security e2e (P9.2), the native benchmark (P9.3), the README quickstart in both modes (P9.4), and verified operations alerts with an embedded restore drill (P9.6). |

## Planned

| Task | What remains | Status |
|---|---|---|
| P0.9 Release preconditions | The owner confirms the npm scope `@krun`, the PyPI project `krun` and GHCR `xenarro`, and sets up OIDC trusted publishing. | Planned, blocked on the owner |
| P9.5 Release v0.1.0 | After an owner tag, `release.yml` publishes the signed image and OCI chart with an SBOM to GHCR, `@krun/sdk` and `@krun/cli` to npm, and `krun` to PyPI. Acceptance requires `helm install` from the OCI chart, `npx @krun/cli init`, `pip install krun` and `cosign verify` to work. | Planned, blocked on the owner |

The release tooling itself exists: the credential-free rehearsal passes in CI as the
`release.yml` dry-run job, and the owner-gated publication job exists but has never run
(see [Releases](/krun/project/releases/)).
What is missing is the owner's registry evidence, the tag and the post-publication
acceptance. The v1 definition of done also requires every Phase 0 to 9 task to be
checked, so v1 is not complete while P0.9 and P9.5 are open. The public `/v1` API
becomes stable once v0.1.0 ships.

## Targets and measurements

The problem statement sets targets; the benchmark measures them. Measured on
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

These are explicit non-goals in SPEC.md section 1. They are not on the roadmap:

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

Anything not in SPEC.md is out of scope until a Decisions row adds it. The public API
also has no HTTP endpoints to create or update Functions (Kubernetes is their write
API), no DeleteRun and no UpdateRun.
