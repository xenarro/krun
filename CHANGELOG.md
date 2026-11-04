# Changelog

All notable changes to krun. One SemVer version per tag covers the image,
the chart, the SDKs and the CLI.

## Unreleased

Release preparation is not publication. Version 0.1.0 remains blocked on
owner-confirmed registry control and exact trusted-publisher bindings;
post-publication verification and the remaining Phase 9 gate are not claimed.

## [0.1.0] - Prepared, not published

### Added

- HTTP-triggered, digest-pinned Kubernetes Functions with authenticated Run
  creation, idempotency, bounded waiting, SSE state/status updates and cancellation.
- Postgres and embedded SQLite stores, explicit migrations, leader-scoped
  scheduling, admission/backpressure, heartbeat/deadline/loss handling and signed
  webhook delivery.
- Optional S3-compatible result storage, scoped upload/download capabilities,
  structured diagnostics, health, Prometheus metrics and conditional OTLP traces.
- Hardened Helm deployments for both modes, namespaced author/viewer roles,
  NetworkPolicy isolation, optional Gateway API and monitoring resources.
- Dependency-free Node.js and Python SDKs and CLI author templates, validation,
  image digest deployment and current-generation readiness.
- Real dual-mode README quickstarts, native security/backpressure scenarios and
  measured 500-run Kubernetes benchmarks with their documented limitations.
- Credential-free release artifact rehearsal and an owner-gated release workflow.

### Boundaries

- Package identities and OIDC bindings are not inferred from public registry
  existence or GitHub push access. No fallback package name is selected.
- No tag, registry upload, package publication or successful release is recorded
  by this preparation entry. Operational drill verification remains P9.6.

### Initial documentation

- SPEC.md, PLAN.md, docs/PROBLEM.md, docs/OPERATIONS.md and docs/AGENT-KICKOFF.md.
