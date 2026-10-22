# krun build plan

Companion to SPEC.md. SPEC.md says what krun does. This file says in what
order to build it and how an agent proves each step. Written so a coding
agent can resume from any state with no chat history.

## 1. Agent protocol

1. Read SPEC.md fully, then this file. Pick the first unchecked task in the
   lowest unfinished phase. Tasks inside a phase run in order unless marked
   "parallel".
2. Work on a branch named after the task id, for example `p1-3-claim`. One
   task is one or a few small commits. Commit messages follow Conventional
   Commits with the package as scope: `feat(store): claim query with lease`.
3. Before marking a task done: run its acceptance command and `make check`.
   Both must pass. At the end of a phase, run the phase gate.
4. Mark the task `[x]`, append one line to section 7 (Progress log):
   `2026-10-22 P1.3 <short sha> note`. Commit the plan change with the code.
5. A change that contradicts SPEC.md needs a new row in SPEC.md section 16
   first. Then the code.
6. Blocked: append `BLOCKED P1.3: <what is needed>` to the progress log, then
   take the next task that does not depend on it.
7. Dependencies: only those listed in section 2. Adding one needs a Decisions
   row with a one-line reason.
8. Build nothing from SPEC.md section 15 (v2). Add no options, flags or
   abstractions that no task asks for.
9. Never commit secrets. Tests generate their own keys.
10. Keep README.md current at phase ends: what works, how to run it.

## 2. Toolchain and dependencies

- Go 1.25 or newer, modules, `CGO_ENABLED=0`.
- `golangci-lint`, `docker`, `kind`, `kubectl`, `helm`.
- Direct dependencies allowed up front:

| Module | Use |
|---|---|
| `github.com/jackc/pgx/v5` | Postgres driver and `LISTEN` |
| `modernc.org/sqlite` | pure Go SQLite |
| `github.com/pressly/goose/v3` | migrations, embedded SQL files |
| `k8s.io/client-go`, `k8s.io/api`, `k8s.io/apimachinery` | Jobs, informer, Lease election |
| `github.com/santhosh-tekuri/jsonschema/v6` | JSON Schema 2020-12 |
| `github.com/google/uuid` | UUIDv7 |
| `github.com/prometheus/client_golang` | metrics |
| `github.com/minio/minio-go/v7` | S3 presigned URLs |
| `golang.org/x/time/rate` | token bucket |
| `gopkg.in/yaml.v3` | registry and keys files |
| `github.com/testcontainers/testcontainers-go` | test only, Postgres |

Standard library for everything else: `net/http` with method patterns,
`log/slog`, `database/sql`, `crypto/hmac`, `crypto/subtle`, `path.Match`.

## 3. Repository layout

```
cmd/krun/main.go                 subcommands: gateway, scheduler, migrate
internal/config/                 env parsing, one struct per process
internal/store/                  Store interface, model types, errors
internal/store/postgres/
internal/store/sqlite/
internal/store/migrations/postgres/*.sql
internal/store/migrations/sqlite/*.sql
internal/store/storetest/        contract suite run against both dialects
internal/registry/               tasks.yaml loader, validation, polling reload
internal/auth/                   keys.yaml loader, scopes, task globs
internal/gateway/                HTTP handlers, middleware, wait, SSE
internal/scheduler/              leader, main loop, informer, deliveries, sweep
internal/k8s/                    Job and Secret builders, client setup
internal/objstore/               presigned PUT and GET, object exists
internal/webhook/                host allowlist, private IP check, signing
deploy/helm/krun/                chart
test/e2e/                        kind-based tests
Makefile  Dockerfile  .golangci.yml  .github/workflows/ci.yml  CLAUDE.md
```

Make targets: `build`, `test`, `lint`, `check` (lint and test), `docker`,
`kind-up`, `kind-down`, `e2e`, `helm-lint`.

## 4. Phases

### Phase 0: scaffold

Gate: `make check` green in CI on an empty but wired repository.

- [ ] P0.1 `go mod init github.com/xenarro/krun`, `cmd/krun/main.go` with
      subcommands `gateway`, `scheduler`, `migrate` that print their name and
      exit 0. Acceptance: `go run ./cmd/krun gateway` prints `gateway`.
- [ ] P0.2 Makefile with all targets in section 3, `.golangci.yml` with
      default linters plus `errcheck`, `govet`, `staticcheck`, `gosec`.
      Acceptance: `make check` passes.
- [ ] P0.3 Dockerfile: multi-stage, distroless static base, non-root,
      `ENTRYPOINT ["/krun"]`. Acceptance: `make docker` builds and
      `docker run <image> gateway` prints `gateway`.
- [ ] P0.4 GitHub Actions `ci.yml`: lint, unit tests, docker build on push
      and pull request. Acceptance: workflow file validates with `act -n` or
      a dry push.
- [ ] P0.5 `internal/config`: parse every variable from SPEC section 12 with
      defaults, fail fast on invalid durations or sizes. Acceptance: unit
      test covers defaults and one invalid value.
- [ ] P0.6 `CLAUDE.md` with five lines: read SPEC.md and PLAN.md, follow the
      agent protocol, run `make check` before every commit, never build v2
      items. Acceptance: file exists.
- [ ] P0.7 Health endpoints `/healthz`, `/readyz`, `/metrics` served by both
      processes on `KRUN_LISTEN_ADDR`; readiness returns 503 until marked
      ready. Acceptance: unit test with `httptest`.

### Phase 1: store

Gate: `go test ./internal/store/...` runs the contract suite against SQLite
in memory and against Postgres via testcontainers, both green.

- [ ] P1.1 Model types and `Store` interface exactly as SPEC section 6, with
      typed errors `ErrNotFound`, `ErrConflict`. Acceptance: compiles, no
      implementation yet.
- [ ] P1.2 Migrations for both dialects, embedded via `goose`, `krun migrate`
      applies them. Acceptance: migrate up twice is idempotent on both.
- [ ] P1.3 `CreateRun` with idempotency: composite unique index, returns
      existing run on same key and hash, `ErrConflict` on same key and
      different hash. Acceptance: contract test with concurrent duplicate
      creates yields exactly one row.
- [ ] P1.4 `ClaimQueued`, `ReleaseLease`, `MarkScheduled`, `CountActive`
      with lease expiry semantics. Acceptance: contract test, two claimers
      never receive the same run while the lease is valid; expired lease is
      reclaimable.
- [ ] P1.5 `Transition` compare-and-set that appends `run_events` and
      publishes notify in Postgres. Acceptance: stale transition returns
      false and writes nothing.
- [ ] P1.6 `GetRun`, `ListRuns` with filters and cursor on `(created_at, id)`,
      owner scoping. Acceptance: pagination test over 250 rows with limit 100.
- [ ] P1.7 `ExpireQueued`, `Sweep`, `EnqueueDelivery`, `ClaimDeliveries`,
      `UpdateDelivery`. Acceptance: contract tests for each.
- [ ] P1.8 `Subscribe`: Postgres `LISTEN` with reconnect, SQLite 1 second
      poll of `run_events`. Acceptance: a transition is observed within 2
      seconds in both modes.
- [ ] P1.9 SQLite pragmas on every connection, one writer, reader pool.
      Acceptance: test asserts `journal_mode` is `wal`.

### Phase 2: registry and auth (parallel with Phase 1)

Gate: `go test ./internal/registry/... ./internal/auth/...` green.

- [ ] P2.1 `tasks.yaml` parsing into task structs, validation rules from
      SPEC section 3, schema compilation. Acceptance: table test with one
      invalid case per rule, including a tag instead of a digest.
- [ ] P2.2 Polling reload with content hash, last-good retention, metric
      `krun_registry_valid`. Acceptance: test swaps the file to an invalid
      one and the old registry stays active.
- [ ] P2.3 `keys.yaml` loader, constant-time lookup, scopes, task globs,
      same polling reload. Acceptance: test for allowed, denied and
      `admin` cases.

### Phase 3: gateway

Gate: `go test ./internal/gateway/...` green against SQLite in memory; a
manual run against Postgres creates and reads a run.

- [ ] P3.1 Router, auth middleware, JSON error envelope, request logging,
      `krun_http_*` metrics. Acceptance: 401 without key, 403 for a task
      outside the globs.
- [ ] P3.2 `GET /v1/tasks`, `GET /v1/tasks/{task}` filtered by key globs.
      Acceptance: handler test.
- [ ] P3.3 `POST /v1/tasks/{task}/runs`: size limit, schema validation with
      details, idempotency header, priority, callback host check, rate
      limit, `maxQueued` check, 202 with `Location`. Acceptance: one test
      per response code in SPEC section 4.
- [ ] P3.4 `GET /v1/runs/{id}`, `GET /v1/runs` with filters, cursor and
      owner scoping. Acceptance: handler tests.
- [ ] P3.5 `DELETE /v1/runs/{id}` transitions to `cancelling` from the three
      allowed states, 409 otherwise. Acceptance: handler test.
- [ ] P3.6 `GET /v1/runs/{id}/result` with inline and 307 branches, 409 when
      not terminal. Acceptance: handler test with a fake object store.
- [ ] P3.7 `krun gateway` wires config, store, registry, keys, readiness.
      Acceptance: process starts in embedded mode with a temp directory and
      answers `/readyz` 200.

### Phase 4: scheduler core

Gate: `make e2e` on kind in embedded mode: submit a run for a `busybox`
task that echoes a JSON result, observe `succeeded` with the result; a task
that exits 1 ends `failed` with the log tail in `error`.

- [ ] P4.1 `internal/k8s`: Job and Secret builders producing exactly the
      manifest in SPEC section 7. Acceptance: golden-file test of the
      rendered Job for one task.
- [ ] P4.2 Leader election with the Lease, `krun_scheduler_leader` metric,
      loops start only on the leader. Acceptance: envtest-free unit test
      with the fake clientset for the election callbacks, plus e2e check
      that two schedulers yield one leader.
- [ ] P4.3 Main loop: expire, free slots, claim per task, create Secret and
      Job, `MarkScheduled`, quota backoff, cancelling handling.
      Acceptance: unit test with fake clientset covering AlreadyExists,
      Forbidden quota and cancel paths.
- [ ] P4.4 Job informer with label selector, state mapping, terminal
      handling: termination message to result, log tail to error, Secret
      deletion. Acceptance: unit test with fake clientset events.
- [ ] P4.5 Resync and `job_lost` detection with 2 minute grace. Acceptance:
      unit test with a run in `running` and no Job.
- [ ] P4.6 Metrics from SPEC section 11 for queue wait, cold start and run
      duration. Acceptance: metric names appear on `/metrics` after one run.
- [ ] P4.7 `test/e2e`: kind cluster script, apply jobs namespace manifests,
      deploy both processes from the local image in embedded mode, run the
      two scenarios above. Acceptance: `make e2e` green.

### Phase 5: wait, SSE, webhooks

Gate: e2e adds a `?wait=30s` scenario returning 200 with the result and a
webhook receiver pod that records one signed delivery.

- [ ] P5.1 Notify fan-out in the gateway: subscribe before insert, 1 second
      poll fallback, `?wait` on create and on get, `KRUN_MAX_WAIT` cap.
      Acceptance: handler test with a fake store emitting a transition.
- [ ] P5.2 `GET /v1/runs/{id}/events` SSE, closes after terminal state.
      Acceptance: handler test reads two events then EOF.
- [ ] P5.3 `internal/webhook`: host glob allowlist, private IP rejection
      after DNS resolution, HMAC signing. Acceptance: unit tests for
      `127.0.0.1`, `10.0.0.1`, `169.254.169.254` and an allowed host.
- [ ] P5.4 Scheduler enqueues a delivery on each terminal transition when a
      callback exists; deliveries loop with the retry schedule and `dead`
      state. Acceptance: unit test with an `httptest` receiver returning
      500 then 200.
- [ ] P5.5 e2e scenarios for wait and webhook. Acceptance: `make e2e` green.

### Phase 6: object storage

Gate: e2e with MinIO in kind: a task uploads a 1 MB result, the run shows
`resultRef`, `GET /v1/runs/{id}/result` returns 307 to a URL that serves
the object.

- [ ] P6.1 `internal/objstore`: presigned PUT with TTL, presigned GET, object
      exists. Acceptance: unit test against a MinIO testcontainer.
- [ ] P6.2 Scheduler sets `KRUN_RESULT_UPLOAD_URL` when configured and
      checks object existence on `Complete`. Acceptance: unit test with a
      fake object store.
- [ ] P6.3 e2e scenario with MinIO. Acceptance: `make e2e` green.

### Phase 7: Helm chart

Gate: `make helm-lint` green; `helm template` renders both modes; e2e
switches to installing the chart instead of raw manifests, in embedded
mode and in postgres mode with a plain Postgres Deployment from
`test/e2e/postgres.yaml`.

- [ ] P7.1 Chart skeleton, values from SPEC section 13, ConfigMap for the
      registry, Services, ServiceAccounts. Acceptance: `helm lint` passes.
- [ ] P7.2 Postgres mode: two Deployments, migrate hook Job, DSN from
      existing Secret. Acceptance: `helm template` renders without the
      StatefulSet.
- [ ] P7.3 Embedded mode: StatefulSet with two containers, shared PVC,
      migrate init container, `fail` when replicas exceed 1, optional
      Litestream restore init container and sidecar. Acceptance:
      `helm template` with replicas 2 fails with a clear message.
- [ ] P7.4 Jobs namespace resources: Namespace with PSA labels, LimitRange,
      ResourceQuota, NetworkPolicy, `krun-job-default` ServiceAccount, Role,
      RoleBinding, Lease RBAC. Acceptance: `helm template` output contains
      each kind; e2e verifies a job pod cannot reach the gateway Service.
- [ ] P7.5 Chart README with every value documented. Acceptance: file
      exists and matches `values.yaml` keys.
- [ ] P7.6 e2e installs through the chart in both modes. Acceptance:
      `make e2e` green.

### Phase 8: hardening, benchmarks, README

Gate: all e2e scenarios green; README states measured numbers and the
"when not to use krun" section.

- [ ] P8.1 Backpressure e2e: submit 3000 runs for a task with `maxQueued`
      1000 and `maxConcurrency` 5; assert 429 after the cap, never more than
      5 Jobs active, quota rejections leave runs `queued`. Acceptance: test
      green.
- [ ] P8.2 Security e2e: input absent from `kubectl get pod -o yaml`; job
      pod blocked from the gateway and the database; tag-only image
      rejected by registry validation. Acceptance: test green.
- [ ] P8.3 Benchmark script: 500 runs of a 10 second task; record submit to
      `running` latency p50 and p95 and sustained runs per second on kind.
      Acceptance: numbers written into README.
- [ ] P8.4 README: purpose, boundaries, quick start for both modes, task
      container contract, API summary, link to SPEC.md. Acceptance:
      a reader can run the quick start on kind in under 10 minutes.
- [ ] P8.5 Tag `v0.1.0`, release workflow publishes the image and the chart
      to GHCR. Acceptance: `helm install` from the OCI chart works.

## 5. v2 backlog (not scheduled)

Mirror of SPEC.md section 15. Do not start without a Decisions row.

- OIDC tokens
- Kueue integration
- Pool executor behind an `Executor` seam
- Init-container input fetch and internal endpoints
- Per-tenant namespaces
- Table partitioning
- Log archiving
- Automatic retries
- API key management endpoints

## 6. Definition of done for v1

- Every task in Phases 0 to 8 is checked.
- `make check` and `make e2e` are green on CI.
- README quick start works on a fresh kind cluster in both database modes.
- No row in SPEC.md section 16 is contradicted by the code.

## 7. Progress log

(append one line per completed task: date, task id, short sha, note)
