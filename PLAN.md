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
   No `Co-Authored-By` trailer, ever.
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

- Node.js 24 LTS, TypeScript strict, ES modules, pnpm workspace. `tsc`
  emits `dist/` per package. Tests run with `node --test` on the TypeScript
  sources through type stripping, so only erasable syntax: no enums, no
  parameter properties.
- `pnpm`, `biome` (lint and format), `docker`, `kind`, `kubectl`, `helm`.
- Python 3.12, `uv`, `ruff`, `pytest` for `sdk/python`.
- Direct dependencies allowed up front:

| Package | Use |
|---|---|
| `fastify` | HTTP, pino logging |
| `@sinclair/typebox`, `@fastify/type-provider-typebox` | route schemas with static types, compiled serialization |
| `@fastify/under-pressure` | `/healthz`, `/readyz` with a custom health check |
| `close-with-grace` | SIGTERM drain |
| `pg`, `kysely` | Postgres driver, `LISTEN`, typed SQL for both dialects, migrations |
| `better-sqlite3` | SQLite for Kysely's `SqliteDialect`, synchronous, WAL pragmas |
| `@kubernetes/client-node` 2.x | Jobs, Secrets, informer, Lease API; promise API on undici fetch |
| `ajv`, `ajv-formats` | JSON Schema 2020-12 for function input schemas |
| `uuid` | UUIDv7 |
| `prom-client` | metrics |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | S3 presigned URLs, object exists |
| `yaml` | keys file, Function documents for `krun validate` |
| `ipaddr.js` | loopback, link-local and private range checks |
| `testcontainers`, `@testcontainers/postgresql` | test only, Postgres and MinIO |

Node built-ins for everything else: `node:crypto` for HMAC and
`timingSafeEqual`, `node:dns/promises`, `node:fs`, `node:test`. Written in
house, no package: token bucket, glob to regex, SSE on `reply.raw`, Lease
leader election (about 40 lines on `CoordinationV1Api`). The SDKs
(`packages/sdk-node`, `sdk/python`) have no runtime dependencies.

## 3. Repository layout

```
bin/krun.js                          dispatch: gateway, scheduler, migrate, validate
packages/shared/src/config/          env parsing, one object per process
packages/shared/src/store/           Store interface, model and table types, errors, Kysely setup, Migrator
packages/shared/src/store/postgres/
packages/shared/src/store/sqlite/
packages/shared/src/store/migrations/postgres/
packages/shared/src/store/migrations/sqlite/
packages/shared/src/store/contract/  contract suite run against both dialects
packages/shared/src/functions/           Function schema (TypeBox), validation, informer cache
packages/shared/src/auth/            keys.yaml loader, scopes, function globs
packages/shared/src/health/          Fastify plugin: /healthz, /readyz, /metrics
packages/shared/src/objstore/        presigned PUT and GET, object exists
packages/shared/src/webhook/         host allowlist, private IP check, signing
packages/sdk-node/src/               @krun/sdk: run(), context, local mode
packages/cli/src/                    @krun/cli: init, deploy, validate
packages/cli/templates/node/         function project template
packages/cli/templates/python/       function project template
sdk/python/krun/                     krun Python SDK, pyproject.toml, tests
test/sdk-conformance/                request sequences both SDKs must produce
apps/gateway/src/                    Fastify apps: public /v1 and internal /internal, plugins, routes, wait, SSE, main.ts
apps/scheduler/src/                  leader, main loop, informer, deliveries, sweep, main.ts
apps/scheduler/src/k8s/              KubeConfig, Job and Secret builders
deploy/helm/krun/                    chart
deploy/helm/krun/templates/crd-functions.yaml  generated CRD template, committed
scripts/gen-crd.ts                   TypeBox schema to CRD YAML and editor JSON Schema
test/e2e/                            kind-based tests
Makefile  Dockerfile  package.json  pnpm-workspace.yaml  tsconfig.base.json
biome.json  .github/workflows/ci.yml  CLAUDE.md
```

Tests sit next to the code as `*.test.ts`.

Make targets: `build`, `test`, `lint`, `check` (lint and test), `generate`,
`docker`, `kind-up`, `kind-down`, `e2e`, `helm-lint`. `build`, `test` and `lint` call
`pnpm -r` scripts; `test` also runs `uv run --directory sdk/python pytest`.

## 4. Phases

### Phase 0: scaffold

Gate: `make check` green in CI on an empty but wired repository.

- [ ] P0.1 pnpm workspace: root `package.json`, `pnpm-workspace.yaml`,
      `tsconfig.base.json`, packages `packages/shared`, `apps/gateway`,
      `apps/scheduler`, each with a strict `tsconfig.json` and a `build`
      script; `.gitignore`; `bin/krun.js` dispatches `gateway`, `scheduler`,
      `migrate`, `validate` to the built entrypoints, which print their name
      and exit 0. Acceptance:
      `pnpm -r build && node bin/krun.js gateway` prints `gateway`.
- [ ] P0.2 Makefile with all targets in section 3, `biome.json` with the
      recommended rules; `lint` runs `biome check` and `tsc --noEmit` in
      every package.
      Acceptance: `make check` passes.
- [ ] P0.3 Dockerfile: multi-stage, `pnpm -r build`, then
      `pnpm install --prod --frozen-lockfile` and the `dist/` directories
      copied onto a distroless Node.js base (glibc, so the `better-sqlite3`
      prebuilt binary loads), non-root, entrypoint runs `bin/krun.js`.
      Acceptance: `make docker` builds and `docker run <image> gateway`
      prints `gateway`.
- [ ] P0.4 GitHub Actions `ci.yml`: lint, unit tests, docker build on push
      and pull request. Acceptance: workflow file validates with `act -n` or
      a dry push.
- [ ] P0.5 `packages/shared/src/config`: parse every variable from SPEC section 12 with
      defaults, fail fast on invalid durations or sizes. Acceptance: unit
      test covers defaults and one invalid value.
- [ ] P0.6 `CLAUDE.md`: read SPEC.md and PLAN.md, follow the agent
      protocol, run `make check` before every commit, never build v2 items,
      never add a Claude co-author trailer. Acceptance: file exists.
- [ ] P0.7 Health endpoints `/healthz`, `/readyz`, `/metrics` served by both
      processes on `KRUN_LISTEN_ADDR` through a shared Fastify plugin
      (`@fastify/under-pressure` with a custom `healthCheck`, `prom-client`
      registry); readiness returns 503 until marked ready. Acceptance: unit
      test with Fastify `inject`.
- [ ] P0.8 `packages/shared/src/functions/schema.ts`: Function spec with TypeBox;
      `scripts/gen-crd.ts` writes `deploy/helm/krun/templates/crd-functions.yaml`
      wrapped in the `crds.install` condition with the keep annotation
      (namespaced, short name `kfn`, status subresource, printer columns
      READY, IMAGE, AGE, `x-kubernetes-preserve-unknown-fields` on
      `inputSchema`, CEL digest rule) and `docs/schemas/function-v1alpha1.json`;
      `make generate`; CI fails on a diff. Acceptance: `make generate` twice
      leaves no diff; a test parses the CRD and asserts scope, subresource,
      preserve-unknown-fields and the digest pattern.

### Phase 1: store

Gate: `node --test 'packages/shared/src/store/**/*.test.ts'` runs the contract
suite against SQLite in memory and against Postgres via testcontainers, both green.

- [ ] P1.1 Model types, Kysely table types and `Store` interface exactly as
      SPEC section 6, with error classes `NotFoundError`, `ConflictError`. Acceptance:
      `tsc --noEmit` passes, no implementation yet.
- [ ] P1.2 Migrations for both dialects with the Kysely `Migrator` and
      `FileMigrationProvider`, one directory per dialect, each migration
      runs raw SQL through `sql` templates; `krun migrate` runs it.
      Acceptance: migrate up twice is idempotent on both.
- [ ] P1.3 `CreateRun` with idempotency: composite unique index, returns
      existing run on same key and hash, `ConflictError` on same key and
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
- [ ] P1.9 SQLite pragmas on open (`better-sqlite3`), one connection per
      process.
      Acceptance: test asserts `journal_mode` is `wal`.
- [ ] P1.10 `SetRuntimeStatus`, `SetResult` and `SetError`, allowed only in
      `scheduled` or `running`; `SetJobStatus`, allowed in `scheduled`, `running` and
      `cancelling`, writes and appends `run_events` only when the value
      changed; `MarkScheduled` stores the token hash. Acceptance: contract
      test, all return false on a terminal run; runtime status publishes a
      notify and writes no `run_events` row; a changed job status appends
      one; an unchanged job status writes nothing.
- [ ] P1.11 `ListStale(function, before)` and `failure_reason` in the `Transition`
      patch. Acceptance: contract test: a running run with an old status is
      returned, one with a fresh status is not, one with no status but an
      old `started_at` is returned; `failed` rows carry `failure_reason`.

### Phase 2: functions and auth (parallel with Phase 1)

Gate: `node --test 'packages/shared/src/functions/**/*.test.ts'
'packages/shared/src/auth/**/*.test.ts'` green, no cluster needed.

- [ ] P2.1 Function validation: the second layer from SPEC section 3 as one pure
      function, schema compilation with Ajv2020. Acceptance: table test with
      one invalid case per rule, including a schema that does not compile
      and a `heartbeatTimeout` of 5s.
- [ ] P2.2 Function informer cache: informer on `functions.krun.io` in
      `KRUN_NAMESPACE`, add, update and delete handlers, validation on each
      event, `error` handler restarting with backoff, a `synced` promise for
      readiness, metrics `krun_functions_synced` and `krun_functions{ready}`.
      Acceptance: test feeds events through a stubbed informer; an invalid
      Function is absent from the map; the map reflects a delete.
- [ ] P2.3 `keys.yaml` loader, constant-time lookup, scopes, function globs,
      30 second polling reload on the content hash. Acceptance: test for
      allowed, denied and `admin` cases.
- [ ] P2.4 `krun validate <path>...` in `packages/cli`: CRD schema plus the
      second layer over Function documents, one line per function, exit 1 on any error. Acceptance:
      fixture with one valid and one tag-image function gives two lines and
      exit 1.

### Phase 3: gateway

Gate: `node --test 'apps/gateway/src/**/*.test.ts'` green against SQLite in
memory; a manual run against Postgres creates and reads a run.

- [ ] P3.1 Router with TypeBox route schemas
      (`@fastify/type-provider-typebox`), auth hook, JSON error envelope,
      request logging, `krun_http_*` metrics; store, Function cache and keys
      registered as Fastify plugins and decorators. Acceptance: 401 without key, 403 for a function
      outside the globs.
- [ ] P3.2 `GET /v1/functions`, `GET /v1/functions/{function}` filtered by key globs.
      Acceptance: handler test.
- [ ] P3.3 `POST /v1/functions/{function}/runs`: size limit, schema validation with
      details, idempotency header, priority, callback host check, rate
      limit, `maxQueued` check, 202 with `Location`. Acceptance: one test
      per response code in SPEC section 4.
- [ ] P3.4 `GET /v1/runs/{id}`, `GET /v1/runs` with filters, cursor and
      owner scoping. Acceptance: handler tests.
- [ ] P3.5 `DELETE /v1/runs/{id}` transitions to `cancelling` from the three
      allowed states, 409 otherwise. Acceptance: handler test.
- [ ] P3.6 `GET /v1/runs/{id}/result` with inline and 307 branches, 409 when
      not terminal. Acceptance: handler test with a fake object store.
- [ ] P3.7 `krun gateway` wires config, store, Function cache, keys, readiness,
      SIGTERM drain with `close-with-grace`. Acceptance: process starts in
      embedded mode with a temp directory and a stubbed Function list, answers
      `/readyz` 200 and exits 0 within 5 seconds of SIGTERM.
- [ ] P3.8 Internal API: second Fastify instance on
      `KRUN_INTERNAL_LISTEN_ADDR`, per-run token auth against
      `job_token_hash`, `GET input`, `POST status` with the 1 per second
      per run limit, `PUT result` with `KRUN_MAX_RESULT_BYTES`, `PUT error`
      with its size limits. Acceptance:
      one test per response code in SPEC section 4; `/internal/*` is 404 on
      the public listener and `/v1/*` is 404 on the internal one; a token
      from another run gets 401.

### Phase 4: scheduler core

Gate: `make e2e` on kind in embedded mode: submit a run for a
`curlimages/curl` function that fetches its input, posts one status and PUTs
the input back as its result, observe `succeeded` with the result and
`runtimeStatus`; a function that exits 1 ends `failed` with the log tail in
`error`; a function with an unpullable image and a 60 second deadline shows
`jobStatus.reason` `ImagePullBackOff` while `scheduled`, then ends `failed`
with reason `DeadlineExceeded` in `jobStatus`; a function that posts two
statuses then exits 3 ends `failed` with `failureReason` `exit_code`,
`jobStatus.exitCode` 3 and its log tail in `error` within 15 seconds of the
exit; a function with `heartbeatTimeout: 30s` that posts one status then sleeps
ends `failed` with `heartbeat_timeout` within 60 seconds, log tail in
`error`, Job gone.

- [ ] P4.1 `apps/scheduler/src/k8s`: Job and Secret builders producing exactly the
      manifest in SPEC section 7. Acceptance: golden-file test of the
      rendered Job for one function.
- [ ] P4.2 Leader election with the Lease, written in house on
      `CoordinationV1Api` (get, create, update with `holderIdentity` and
      `renewTime`), `krun_scheduler_leader` metric, loops start only on the
      leader. Acceptance: unit test with a stubbed `CoordinationV1Api` for
      acquire, renew, lose and release on SIGTERM, plus e2e check that two
      schedulers yield one leader.
- [ ] P4.3 Main loop: expire, free slots, claim per function, mint the token,
      create Secret and Job, `MarkScheduled` with the token hash, quota
      backoff, cancelling handling.
      Acceptance: unit test with stubbed `BatchV1Api` and `CoreV1Api`
      covering AlreadyExists, Forbidden quota and cancel paths.
- [ ] P4.4 Job and Pod informers (`makeInformer`) with the `krun.io/run-id`
      label selector, `error` handlers that restart the watch with backoff,
      `jobStatus` derivation from Job conditions and pod container state,
      `running` on pod phase `Running`, terminal handling: `result_ref`
      check, log tail or Kubernetes reason to `error`, final `jobStatus`,
      Secret deletion. Acceptance: unit test feeding Job and Pod events,
      including one error event and an `ImagePullBackOff` pod, to the
      handlers without a cluster; that run stays `scheduled` with the
      reason in `jobStatus`.
- [ ] P4.5 Resync and `job_lost` detection with 2 minute grace. Acceptance:
      unit test with a run in `running` and no Job.
- [ ] P4.6 Metrics from SPEC section 11 for queue wait, cold start and run
      duration. Acceptance: metric names appear on `/metrics` after one run.
- [ ] P4.7 `test/e2e`: kind cluster script, apply the CRD, the jobs namespace
      manifests and a `function.yaml` with `kubectl`, deploy both processes
      from the local image in embedded mode, run the scenarios in the gate. Acceptance:
      `make e2e` green.
- [ ] P4.8 Function status writer on the leader: `Ready` condition with the
      reason from P2.1, patched through `CustomObjectsApi` only when
      `observedGeneration` or the condition changes. Acceptance: stubbed
      API; an invalid Function gets `Ready=False` with the reason; a repeated
      event causes no second patch.
- [ ] P4.9 Failure detection per SPEC section 8: log tail capture on the
      first terminating or terminated pod event with fallback at the
      terminal transition, `failureReason` mapping (`exit_code`,
      `oom_killed`, `deadline_exceeded`, `evicted`), `error` precedence
      (function report, then Kubernetes, then krun) with `logTail` separate,
      metrics
      `krun_runs_failed_total` and `krun_terminal_detect_seconds`.
      Acceptance: unit test with stubbed `pods/log`: exit 3 yields `failed`,
      `exit_code`, `logTail` holds the tail fetched before the Job `Failed`
      event; a reported error survives as `error.source` `function`; `OOMKilled` yields `oom_killed`; a pod gone before any fetch
      yields the Kubernetes reason in `error`.
- [ ] P4.10 Heartbeat loop every 10 seconds: `ListStale` per Function with
      `heartbeatTimeout`; log fetch, Job delete with foreground propagation,
      transition to `failed` with `heartbeat_timeout`, Secret delete,
      delivery enqueue, in that order. Acceptance: unit test with a stale
      run asserts the call order and the final state; a run of a Function
      without `heartbeatTimeout` is untouched; a run with a fresh status is
      untouched.

### Phase 5: wait, SSE, webhooks

Gate: e2e adds a `?wait=30s` scenario returning 200 with the result and a
webhook receiver pod that records one signed delivery.

- [ ] P5.1 Notify fan-out in the gateway: subscribe before insert, 1 second
      poll fallback, `?wait` on create and on get, `KRUN_MAX_WAIT` cap,
      SIGTERM answers in-flight waits at once. Acceptance: handler test with
      a fake store emitting a transition, and one where SIGTERM ends the
      wait early.
- [ ] P5.2 `GET /v1/runs/{id}/events` SSE of state, status and job status
      events, closes after terminal state and on SIGTERM. Acceptance:
      handler test reads a state event, a status event, then EOF.
- [ ] P5.3 `packages/shared/src/webhook`: host glob allowlist, private IP rejection
      after DNS resolution, HMAC signing. Acceptance: unit tests for
      `127.0.0.1`, `10.0.0.1`, `169.254.169.254` and an allowed host.
- [ ] P5.4 Scheduler enqueues a delivery on each terminal transition when a
      callback exists; deliveries loop re-resolves and re-checks the host,
      then follows the retry schedule and `dead` state. Acceptance: unit test with a local `http.createServer`
      receiver returning 500 then 200.
- [ ] P5.5 e2e scenarios for wait and webhook. Acceptance: `make e2e` green.

### Phase 6: object storage

Gate: e2e with MinIO in kind: a function uploads a 1 MB result, the run shows
`resultRef`, `GET /v1/runs/{id}/result` returns 307 to a URL that serves
the object.

- [ ] P6.1 `packages/shared/src/objstore`: presigned PUT with TTL, presigned GET, object
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

- [ ] P7.1 Chart skeleton, values from SPEC section 13, the CRD templated
      under `crds.install` with the keep annotation under `crds.keep`, no
      Function resources, Services including `krun-gateway-internal`,
      ServiceAccounts; keys mounted as a directory, no `subPath`.
      Acceptance: `helm lint` passes; the rendered manifests contain no
      `subPath`, no ConfigMap and no Function; `crds.install=false` drops
      the CRD; `crds.keep=false` drops the annotation.
- [ ] P7.2 Postgres mode: two Deployments, migrate hook Job, DSN from
      existing Secret. Acceptance: `helm template` renders without the
      StatefulSet.
- [ ] P7.3 Embedded mode: StatefulSet with two containers, shared PVC,
      migrate init container, `fail` when replicas exceed 1, optional
      Litestream restore init container and sidecar. Acceptance:
      `helm template` with replicas 2 fails with a clear message.
- [ ] P7.4 Jobs namespace resources: Namespace with PSA labels, LimitRange,
      ResourceQuota, NetworkPolicy, `krun-job-default` ServiceAccount,
      scheduler Role and RoleBinding, gateway Role and RoleBinding for
      Functions, `krun-function-author` Role without a binding, gateway
      NetworkPolicy for the internal port, Lease RBAC. Acceptance: `helm template` output contains
      each kind; e2e verifies a job pod reaches the gateway internal port and
      not the public port.
- [ ] P7.5 Chart README with every value documented. Acceptance: file
      exists and matches `values.yaml` keys.
- [ ] P7.6 e2e installs through the chart in both modes. Acceptance:
      `make e2e` green.

### Phase 8: SDKs and CLI

Gate: `krun init` for both languages yields a project whose tests pass and
whose image builds; e2e runs one SDK-built function per language on kind.

- [ ] P8.1 `packages/sdk-node`: `run(handler)` per SPEC section 7.1, no
      runtime dependencies, local mode, `User-Agent`. Acceptance: unit
      tests against a local `http.createServer` fake of the internal API
      for success, result above `KRUN_MAX_RESULT_BYTES` uploaded to the
      presigned URL, thrown error reported then exit 1, heartbeat pings at a
      third of `KRUN_HEARTBEAT_TIMEOUT`, retry on 503, local mode;
      `package.json` lists no `dependencies`.
- [ ] P8.2 `sdk/python`: the same with `urllib.request` and a daemon thread
      for heartbeats; `pyproject.toml`, `uv`, `ruff`, `pytest`; `make test`
      runs it. Acceptance: the same test matrix as P8.1 against the same
      fake.
- [ ] P8.3 `test/sdk-conformance`: one scenario table (requests expected in
      order, with bodies) read by both SDK test suites. Acceptance: both
      suites pass on it; reordering one SDK's calls fails its suite.
- [ ] P8.4 `krun init` in `packages/cli` with the two templates from SPEC
      section 7.2. Acceptance: `krun init --lang node t && cd t && npm test
      && docker build .` green; the same for python with `uv run pytest`;
      `krun validate function.yaml` fails on `REPLACE_WITH_DIGEST` with a clear
      message.
- [ ] P8.5 e2e: build both template projects, load them into kind, apply
      their Functions; run success with a result, a thrown error
      (`failureReason` `exit_code`, `error.source` `function`, `logTail`
      present), and a slow handler that outlives `heartbeatTimeout` while
      the SDK pings (stays `running`, then succeeds). Acceptance: `make e2e`
      green.
- [ ] P8.6 `krun deploy` per SPEC section 7.2 with `--no-apply` and
      `--registry`. Acceptance: on kind with a local registry, `krun deploy`
      in a template project ends with `Ready=True` and prints the curl;
      `--no-apply` leaves the cluster untouched and `function.yaml` carries
      the digest.

### Phase 9: hardening, benchmarks, README

Gate: all e2e scenarios green; README states measured numbers and the
"when not to use krun" section.

- [ ] P9.1 Backpressure e2e: submit 3000 runs for a function with `maxQueued`
      1000 and `maxConcurrency` 5; assert 429 after the cap, never more than
      5 Jobs active, quota rejections leave runs `queued`. Acceptance: test
      green.
- [ ] P9.2 Security e2e: input and token absent from
      `kubectl get pod -o yaml`; job pod blocked from the gateway public port
      and the database; a run's token rejected for another run id; tag-only
      image rejected at apply by the CRD; a Function with a non-compiling
      `inputSchema` shows `Ready=False` and gets 404 on POST. Acceptance:
      test green.
- [ ] P9.3 Benchmark script: 500 runs of a 10 second function; record submit to
      `running` latency p50 and p95, failure detection latency p95 and
      sustained runs per second on kind.
      Acceptance: numbers written into README.
- [ ] P9.4 README: purpose, boundaries, quick start for both modes, the
      golden path (`krun init`, `krun deploy`, run), function container contract,
      API summary, link to SPEC.md. Acceptance:
      a reader can run the quick start on kind in under 10 minutes.
- [ ] P9.5 Tag `v0.1.0`, release workflow publishes the image and the chart
      to GHCR, `@krun/sdk` and `@krun/cli` to npm, `krun` to PyPI.
      Acceptance: `helm install` from the OCI chart works; `npx @krun/cli
      init` and `pip install krun` work.

## 5. v2 backlog (not scheduled)

Mirror of SPEC.md section 15. Do not start without a Decisions row.

- OIDC tokens
- Kueue integration
- Pool executor behind an `Executor` seam
- Fail fast on pods stuck in `ImagePullBackOff` or `Unschedulable`
- Go and Java SDKs, `krun dev` local emulator, Backstage template
- Per-tenant namespaces
- Table partitioning
- Log archiving
- Automatic retries
- API key management endpoints

## 6. Definition of done for v1

- Every task in Phases 0 to 9 is checked.
- `make check` and `make e2e` are green on CI.
- README quick start works on a fresh kind cluster in both database modes.
- No row in SPEC.md section 16 is contradicted by the code.

## 7. Progress log

(append one line per completed task: date, task id, short sha, note)
