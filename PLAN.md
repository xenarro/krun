# krun build plan

Companion to SPEC.md. SPEC.md says what krun does. This file says in what
order to build it and how an agent proves each step. Written so a coding
agent can resume from any state with no chat history.

## 1. Agent protocol

1. Read SPEC.md fully, then docs/API.md and docs/INTERNAL-API.md, then
   this file, then docs/OPERATIONS.md. Pick the
   first unchecked task in the lowest unfinished phase. Tasks inside a phase
   run in order unless marked "parallel".
2. Work on a branch named after the task id, for example `p1-3-claim`. One
   task is one or a few small commits. Commit messages follow Conventional
   Commits with the package as scope: `feat(store): claim query with lease`.
   No `Co-Authored-By` trailer, ever.
3. Before marking a task done: run its acceptance command and `make check`.
   Both must pass. At the end of a phase, run the phase gate.
4. Mark the task `[x]`, append one line to section 6 (Progress log):
   `2026-10-22 P1.3 <short sha> note`. Commit the plan change with the code.
   Push the branch, open a pull request to main, merge it when CI is green.
   Never push main directly. Only the owner creates `v*` tags.
5. A change that contradicts SPEC.md needs its row in SPEC.md section 15
   added or rewritten first, then the code. The table holds only decisions
   in force; history lives in git. Owner decisions never get a Decisions row from the
   agent: published package names beyond the P0.9 fallbacks, the public API
   shape, SPEC.md section 9 policy, non-goals. For those write BLOCKED.
6. Blocked: append `BLOCKED P1.3: <what is needed>` to the progress log, then
   take the next task that does not depend on it.
7. Dependencies: only those listed in section 2. Adding one needs a Decisions
   row with a one-line reason.
8. Build nothing SPEC.md section 1 lists as a non-goal. Add no options, flags or
   abstractions that no task asks for.
9. Never commit secrets. Tests generate their own keys.
10. Keep README.md current at phase ends: what works, how to run it.

## 2. Toolchain and dependencies

docs/STACK.md is the normative stack: every library, its version range,
its use, its rules and the alternatives rejected. This section is the
allowlist an agent checks before adding an import.

- Node.js 26 (LTS from late October 2026), TypeScript 7 strict (`tsc` emits `dist/` per package),
  ES modules, pnpm workspace. Erasable syntax only: no enums, no parameter
  properties.
- Effect 4 is the foundation of every process (docs/STACK.md section 4);
  Zod 4 is the only schema language for krun's own schemas; Ajv only
  compiles user-supplied `inputSchema`; time comes from Effect `Clock`,
  `DateTime` and `Duration`, never `Date.now()`.
- Tests: Vitest 5 with `@effect/vitest` (`it.effect`, `TestClock`),
  fast-check for property tests, testcontainers for Postgres and MinIO.
  `make test` runs `pnpm -r exec vitest run` and the Python suite.
- `pnpm`, `biome` (lint and format), `docker`, `kind` 0.31 or newer (its
  kindnetd enforces NetworkPolicy), `kubectl`, `helm` 4, `helm-docs`,
  `promtool`, `actionlint`, `gh`. kind node image 1.33 or newer.
- Python 3.11 or newer, `uv`, `ruff`, `pytest`, `mypy` for `sdk/python`.
- CI tools, not dependencies: Trivy, cosign, syft, `pnpm audit`, Renovate,
  helm/kind-action pinned to the same kind version.
- Direct runtime dependencies allowed up front (ranges in docs/STACK.md):

| Package | Use |
|---|---|
| `effect`, `@effect/platform-node` | foundation: services, layers, typed errors, scopes, schedules, streams, clock; process entry with `NodeRuntime.runMain` |
| `zod` | every boundary schema; CRD and editor schema through `z.toJSONSchema` |
| `fastify`, `fastify-type-provider-zod`, `@fastify/swagger` | HTTP listeners, Zod route schemas, generated OpenAPI |
| `kysely`, `pg` | typed SQL for both dialects, migrations, `LISTEN`; SQLite is the built-in `node:sqlite` behind an in-house Kysely adapter |
| `@kubernetes/client-node` 2.x | Jobs, Pods, Secrets, Leases, Functions, informers |
| `undici` | webhook delivery with a pinned-address `Agent` |
| `ajv`, `ajv-formats` | user-supplied `inputSchema` only |
| `uuid` | UUIDv7 with the time from `Clock` |
| `canonicalize` | RFC 8785 serialisation for `request_hash` |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | presigned URLs, object exists |
| `yaml` | keys file, Function documents for `krun validate` |
| `ipaddr.js` | address classification and CIDR matching for webhook targets |
| `@effect/opentelemetry` and the `@opentelemetry/*` packages in docs/STACK.md section 2.6 | metrics (Prometheus exporter) and traces (OTLP) |
| `picomatch` | key and webhook host globs |
| `@clack/prompts`, `picocolors`, `tinyexec` | CLI only: prompts, colour, running `docker` and `kubectl` |

Dev dependencies: `typescript`, `vitest`, `vite` (Vitest's required peer, SPEC D37), `@effect/vitest`, `fast-check`,
`testcontainers`, `@testcontainers/postgresql`, `@testcontainers/minio`,
`@biomejs/biome`, `@types/node`, `@types/pg`, `knip`, `publint`,
`@arethetypeswrong/cli`; `hypothesis` for the Python SDK.

Node built-ins for everything else: `node:crypto` for SHA-256, HMAC,
`timingSafeEqual` and token bytes, `node:dns/promises`, `node:fs`,
`node:util` `parseArgs` for the CLI. Written in house, no package: token
bucket, SSE on `reply.raw`, Lease leader election (a scoped
Effect layer on `CoordinationV1Api`), the duration grammar (a Zod
refinement into `Duration`). The SDKs (`sdk/node`, `sdk/python`)
have no runtime dependencies and do not use Effect.

Before writing code for a task, load the Claude Code skills docs/STACK.md
section 5 lists for its area. Effect's `MIGRATION.md` overrides any skill
text written for Effect 3.

## 3. Repository layout

```
bin/krun.js                          dispatch: gateway, scheduler, migrate, validate
packages/shared/src/config/          env parsing and startup validation, one object per process
packages/shared/src/store/           Store interface, model and table types, RunSummary, errors, Kysely setup, Migrator
packages/shared/src/store/postgres/
packages/shared/src/store/sqlite/
packages/shared/src/store/migrations/postgres/
packages/shared/src/store/migrations/sqlite/
packages/shared/src/store/contract/  contract suite run against both dialects
packages/shared/src/functions/       Function schema (Zod), validation, informer cache
packages/shared/src/k8s/             KubeConfig loading shared by gateway and scheduler
packages/shared/src/auth/            keys.yaml loader, scopes, function globs, per-key limits
packages/shared/src/health/          Fastify admin plugin: /healthz, /readyz, /metrics
packages/shared/src/runtime/         Effect layers: Config, Logger (pino sink), Database, Kube, ObjectStore, Metrics; error-to-envelope mapping
packages/shared/src/objstore/        presigned PUT and GET, object exists
packages/shared/src/webhook/         host allowlist, address check with CIDR allowlist, pinned dispatcher, signing
sdk/node/src/                        @krun/sdk: run(), context, local mode
packages/cli/src/                    @krun/cli: init, deploy, validate
packages/cli/templates/node/         function project template
packages/cli/templates/python/       function project template
sdk/python/krun/                     krun Python SDK, pyproject.toml, tests
apps/gateway/src/                    Fastify apps: public /v1, internal /internal/v1, admin; plugins, routes, wait, SSE, main.ts
apps/scheduler/src/                  leader, main loop, informers, failure detection, heartbeat, deliveries, sweep, main.ts
apps/scheduler/src/k8s/              API limiter, Job and Secret builders
deploy/crds/functions.krun.io.yaml   generated plain CRD manifest, committed
deploy/helm/krun/                    chart
deploy/helm/krun/templates/crd-functions.yaml  generated CRD template, committed
scripts/gen-crd.ts                   Zod schema to both CRD files and the editor JSON Schema (`z.toJSONSchema`)
scripts/quickstart.sh                the README quick start, run by e2e
docs/api/                            generated OpenAPI documents, committed
docs/OPERATIONS.md  docs/PROBLEM.md  docs/AGENT-KICKOFF.md
test/e2e/                            kind-based tests
test/fake-kube/                      http.createServer Kubernetes API over in-memory objects for process tests
test/sdk-conformance/                request sequences both SDKs must produce
Makefile  Dockerfile  package.json  pnpm-workspace.yaml  tsconfig.base.json
biome.json  renovate.json  CHANGELOG.md  CLAUDE.md
.github/workflows/ci.yml  .github/workflows/release.yml
```

Tests sit next to the code as `*.test.ts`.

Make targets: `build`, `test`, `lint`, `check` (lint and test), `generate`,
`docker`, `kind-up`, `kind-down`, `e2e`, `helm-lint`. `build`, `test` and
`lint` call `pnpm -r` scripts; `test` also runs
`uv run --directory sdk/python pytest`; `generate` runs only the steps whose
scripts exist, and grows: CRD files and editor schema (P0.8), OpenAPI
documents (P3.1c, P3.8), chart README (P7.5).

## 4. Phases

### Phase 0: scaffold

Gate: `make check` green in CI on an empty but wired repository.

- [x] P0.1 pnpm workspace: root `package.json`, `pnpm-workspace.yaml`,
      `tsconfig.base.json`, `.gitignore`, packages `packages/shared`,
      `packages/sdk-node`, `packages/cli`, `apps/gateway`, `apps/scheduler`,
      each with a strict `tsconfig.json` and a `build` script; `sdk/python`
      with `pyproject.toml` and a placeholder pytest; `bin/krun.js`
      dispatches `gateway`, `scheduler`, `migrate`, `validate` to the built
      entrypoints, each an Effect program under `NodeRuntime.runMain` that
      logs its name and exits 0; `vitest.config.ts` per package and one
      `@effect/vitest` smoke test. Acceptance:
      `pnpm -r build && node bin/krun.js gateway` prints `gateway`;
      `make test` passes.
- [x] P0.2 Makefile with all targets in section 3 (`generate` runs only the
      steps whose scripts exist), `biome.json` with the recommended rules;
      `lint` runs `biome check` and `tsc --noEmit` in every package; a
      minimal `deploy/helm/krun/Chart.yaml` (apiVersion v2, name krun,
      version and appVersion 0.0.0) and `values.yaml` with
      `crds: {install: true, keep: true}` so `make helm-lint` passes.
      Acceptance: `make check` and `make helm-lint` pass.
- [x] P0.3 Dockerfile: multi-stage, `pnpm -r build`, then
      `pnpm install --prod --frozen-lockfile` and every workspace package's
      `dist/` (`packages/cli/dist` included) copied onto a distroless Node.js 26 base pinned by digest (no native
      addons, so no build toolchain in any stage), non-root 65532, entrypoint
      runs `bin/krun.js`. Acceptance: `make docker` builds and
      `docker run <image> gateway` prints `gateway`.
- [x] P0.4 GitHub Actions `ci.yml` on push and pull request: `make check`
      (including `knip`), `make generate` then `git diff --exit-code`, `make docker`,
      `make helm-lint`, `pnpm audit --prod --audit-level=critical`, Trivy on
      the image (`--severity CRITICAL --ignore-unfixed --exit-code 1`);
      `renovate.json` for npm, Docker digests and Actions. Acceptance:
      `actionlint` passes on `.github/workflows/`; the first push shows a
      green run (`gh run watch`).
- [x] P0.5 `packages/shared/src/config`: a Zod schema over `process.env`,
      exposed as an Effect `Config` service layer, for every variable from
      SPEC section 12 with defaults, the duration grammar, CIDR parsing for
      `KRUN_WEBHOOK_ALLOWED_CIDRS`, and the startup validation rules (exit 1
      naming the first bad variable). Acceptance: unit test covers
      defaults, one invalid duration, one invalid CIDR, DSN empty in
      postgres mode, webhook hosts without secret, a size above 1 MiB, and
      `KRUN_S3_PRESIGN_TTL=""` yielding the default.
- [x] P0.6 Verify `CLAUDE.md` matches PLAN section 1 and SPEC D15: read
      order, `make check` before every commit, no non-goals, no
      Co-Authored-By trailer, TypeScript on Node.js 26; edit only on drift.
      Acceptance: the rules match.
- [x] P0.7 Admin listener plugin in `packages/shared/src/health`:
      `/healthz`, `/readyz`, `/metrics` on `KRUN_ADMIN_LISTEN_ADDR` for both
      processes (a readiness route over an Effect `Ref`; the OpenTelemetry
      Prometheus exporter serving `/metrics`; the `Telemetry` layer with OTLP
      traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set); readiness returns 503 until marked ready,
      when the database check exceeds 2 seconds, and from the start of
      shutdown. Acceptance: `@effect/vitest` test with Fastify `inject` and `TestClock`,
      including a stalled database check.
- [x] P0.8 `packages/shared/src/functions/schema.ts`: Function spec as a Zod
      `strictObject` including `runAsUser`, `runAsGroup`, `heartbeatTimeout`, the
      duration pattern; `scripts/gen-crd.ts` (`z.toJSONSchema`, target `openapi-3.0`) writes
      the plain manifest
      `deploy/crds/functions.krun.io.yaml` and, derived from it,
      `deploy/helm/krun/templates/crd-functions.yaml` wrapped in the
      `crds.install` condition with the keep annotation (namespaced, short
      name `kfn`, status subresource, printer columns READY from
      `.status.conditions[?(@.type=="Ready")].status`, IMAGE, AGE,
      `x-kubernetes-preserve-unknown-fields` on `inputSchema`, CEL digest
      rule, defaults 65532) and `docs/schemas/function-v1alpha1.json`;
      `make generate`; CI fails on a diff. Acceptance: `make generate`
      twice leaves no diff; a test parses both CRD files and asserts scope,
      subresource, preserve-unknown-fields, the digest pattern, the
      defaults and the READY path; `make helm-lint` still passes.
- [ ] P0.9 Release preconditions and workflow. Owner precondition, BLOCKED
      if unmet: confirm npm scope `@krun`, PyPI project `krun`, GHCR
      `xenarro`; a taken name needs a Decisions row by the owner (fallbacks
      `@xenarro/krun-sdk`, `krun-sdk`); OIDC trusted publishing for npm and
      PyPI, `GITHUB_TOKEN` for GHCR. `release.yml` on `v*` tags stamps the
      tag into `package.json` files, `pyproject.toml`, `Chart.yaml`
      `version` and `appVersion`, builds, signs the image and the OCI chart
      with cosign keyless, attaches a syft SPDX SBOM with `cosign attest`,
      publishes; its dry-run job runs on pull requests. `CHANGELOG.md` kept
      per tag. Acceptance: the dry-run job passes on a pull request.

### Phase 1: store

Gate: `pnpm exec vitest run packages/shared/src/store` runs the
contract suite against SQLite on a temp-file database (`fs.mkdtemp` under
`os.tmpdir()`, removed in `after`) and against Postgres 18 via testcontainers,
both green.

- [x] P1.1 Model types, Kysely table types, `toRun`, `toRunSummary`
      (the only row-to-wire mappers: `name`, UPPER_SNAKE enums, `*Time`,
      `resultUri`, `reportTime`, `observeTime`) and the `Store` interface exactly as SPEC section 6 (`transition`
      takes the optional `event` payload), with error classes `NotFoundError`, `ConflictError`. Acceptance: `tsc --noEmit`
      passes, no implementation yet.
- [x] P1.2 Migrations for both dialects with the Kysely `Migrator` and
      `FileMigrationProvider`, one directory per dialect, each migration
      runs raw SQL through `sql` templates; `krun migrate` first reads
      `kysely_migration` and diffs it against the binary's names: unknown
      names with nothing pending warn and exit 0, unknown names plus
      pending exit 1. Acceptance: migrate up twice is idempotent on both; a
      database with one extra migration recorded yields exit 0 and the
      warning; extra plus pending yields exit 1.
      Implementation prerequisite: P1.2 owns the minimal `node:sqlite`
      adapter, immediate-transaction driver and scoped database open/close
      plumbing needed to execute its SQLite migrations. P1.9 retains its
      complete WAL/pragmas, second-connection contention and Store gate;
      the earlier plumbing does not close P1.9. The migration command uses
      DB-only configuration, not gateway/scheduler namespace acquisition.
- [x] P1.3 `createRun` with idempotency: composite unique index on
      (`created_by`, `function_name`, `idempotency_key`), `request_hash` the
      SHA-256 of the RFC 8785 serialisation of `{ input, priority,
      callback }`, returns the existing run on same key and hash,
      `ConflictError` on same key and different hash; when created, appends
      the `queued` `run_events` row with `payload.actor` and notifies.
      Acceptance: contract test with concurrent duplicate creates yields
      exactly one row and one event; a duplicate with reordered JSON keys
      returns the same row.
- [x] P1.4 `claimQueued`, `releaseLease`, `setJobToken`, `markScheduled`
      (boolean; sets `scheduled_at`, appends a row, notifies),
      `countByState`, `countQueued`, `countQueuedBy`, `listByState` with
      the shared literal predicate, lease expiry semantics. Acceptance:
      contract test: two claimers never receive the same run while the
      lease is valid; an expired lease is reclaimable; `markScheduled` on a
      cancelled run returns false; `countByState` counts only non-terminal
      states; after seeding 5000 terminal and 50 active rows and `analyze
      runs`, Postgres `explain` inside a transaction with `set local
      enable_seqscan = off` names `runs_active_idx` for `countByState`.
- [x] P1.5 `transition` compare-and-set that sets `started_at` or
      `finished_at`, appends `run_events`, publishes notify in Postgres,
      and inserts the `deliveries` row in the same transaction when the
      target state is terminal and `callback_url` is set, payload
      `toRunSummary` of the updated row. Acceptance: stale transition
      returns false and writes nothing; a terminal transition with a
      callback leaves exactly one pending delivery whose payload has no
      `input`, has `name`, `state: 'SUCCEEDED'` and `createTime`;
      `started_at` equals the event `at`; a transition with
      `event: { actor }` writes it as the row payload; a transition whose
      patch carries a `KRUN` error does not overwrite a `FUNCTION` error
      already set (`coalesce`).
- [x] P1.6 `getRun`, `listRuns` returning `RunSummary` items with the
      docs/API.md filter (`state`, `failureReason`, `createTime` bounds,
      `AND`), order `created_at desc, id desc`, cursor base64url of
      `created_at|id` plus a hash of parent and filter, default limit 50,
      the cursor as the row-value comparison
      `(created_at, id) < ($createdAt, $id)`, owner scoping. Acceptance:
      pagination test over 250 rows with limit 100; items lack `input`,
      `result`, `logTail`, `error.details`; Postgres `explain` for an
      unfiltered admin list names `runs_created_idx`.
- [x] P1.7 `expireQueued` returning the expired runs (each with
      `finished_at`, its `run_events` row, notify and delivery), `sweep`
      (SQLite runs `pragma incremental_vacuum` after each batch),
      `claimDeliveries` leasing rows for 60 s in the claim statement,
      `updateDelivery`. Acceptance: contract tests for each; a claimed
      delivery is not re-claimed within 60 s.
- [x] P1.8 `subscribe`: Postgres `LISTEN` with reconnect; SQLite polls
      `run_events where rowid > $last` every second from `max(rowid)` at
      subscribe, kind `job_status` when `from_state = to_state`.
      Acceptance: a transition is observed within 2 seconds in both modes;
      SQLite never re-emits a row.
- [x] P1.9 SQLite on Node's built-in `node:sqlite`: an in-house Kysely
      dialect adapter (`packages/shared/src/store/sqlite/dialect.ts`),
      pragmas on open, one connection per process, a `SqliteDriver` subclass whose `beginTransaction` runs
      `begin immediate`. Acceptance: on the temp-file database, test
      asserts `journal_mode` is `wal`; while a Store transaction is open, a
      second `node:sqlite` connection's `begin immediate` with
      `busy_timeout` 0 fails `SQLITE_BUSY`.
- [x] P1.10 `setRuntimeStatus`, `setResult` and `setError`, allowed in
      `queued` with a token set, `scheduled` or `running`; `setJobStatus`,
      allowed in `scheduled`, `running` and `cancelling`, writes and appends
      `run_events` only when a field other than `observedAt` changed.
      Acceptance: contract test: all return false on a terminal run and on
      a `queued` run without a token; runtime status publishes a notify and
      writes no `run_events` row; a changed job status appends one; an
      `observedAt`-only change writes nothing.
- [x] P1.11 `listStale(fn, before)` using the later of `runtime_status.at`
      and `started_at` (section 6 expressions) and `failure_reason` in the
      `transition` patch. Acceptance: contract test: a running run with an old status is
      returned, one with a fresh status is not, one with no status but an
      old `started_at` is returned; `failed` rows carry `failure_reason`.

### Phase 2: webhooks, functions and auth (parallel with Phase 1)

Gate: `pnpm exec vitest run packages/shared/src/webhook packages/shared/src/functions packages/shared/src/auth` green, no cluster needed.

- [x] P2.1 `packages/shared/src/webhook`: host glob allowlist, address
      check after DNS resolution (unwrap IPv4-mapped; accept when inside
      `KRUN_WEBHOOK_ALLOWED_CIDRS`, else only ipaddr.js `unicast`), an
      undici `Agent` whose `connect.lookup` returns only the checked
      address with `servername` set, HMAC signing with timestamp and one
      `v1=` per secret. Acceptance: unit tests reject `127.0.0.1`,
      `10.0.0.1`, `169.254.169.254`, `100.64.0.1`, `::1`,
      `::ffff:127.0.0.1`; accept an allowed public host; accept `10.0.0.1`
      when `10.0.0.0/8` is listed; a signature verifies with each of two
      secrets.
- [x] P2.2 Function validation: the second layer from SPEC section 3 as one
      pure function, Ajv2020 `strict`, no `loadSchema`, `$ref` to URLs
      rejected, 64 KiB cap, allowed service accounts, `krun-*` secretRefs,
      callback host via P2.1. Acceptance: table test with one invalid case
      per rule, including a schema that does not compile, a 65 KiB schema,
      a `heartbeatTimeout` of 5s, a remote `$ref` and a forbidden service
      account.
- [x] P2.3 `packages/shared/src/k8s` KubeConfig loading, and the Function
      informer cache: informer on `functions.krun.io` in `KRUN_NAMESPACE`,
      add, update and delete handlers, validation on each event with the
      compiled validator cached per uid and generation, `error` handler
      restarting with backoff, 404 before the CRD is Established retried
      the same way, a `synced` promise for readiness, metrics
      `krun_functions_synced` and `krun_functions{ready}`. Acceptance:
      test feeds events through a stubbed informer; an invalid Function is
      absent from the map; the map reflects a delete; a status-only update
      does not recompile.
- [x] P2.4 `keys.yaml` loader: `key` as string or list, duplicate names
      rejected, constant-time lookup, scopes including `runs:priority` and
      `admin`, function globs, per-key `maxQueued`, 30 second polling
      reload on the content hash. Acceptance: test for allowed, denied,
      `admin`, a key with two secrets during rotation, a duplicate name.
- [x] P2.5 `krun validate <path>...` in `packages/cli`: CRD schema plus the
      second layer over Function documents with the ceilings from the five
      section 3 variables (defaults otherwise, values printed on stderr),
      one line per function, exit 1 on any error; `bin/krun.js validate`
      dispatches to `packages/cli/dist/validate.js`, replacing the P0.1
      stub. Acceptance: fixture with one valid and one tag-image function
      gives two lines and exit 1; a fixture with `callback.url` fails
      `CallbackNotAllowed` by default and passes with
      `KRUN_WEBHOOK_ALLOWED_HOSTS` set; after `make docker`,
      `docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
      prints its line and exits 1.

### Phase 3: gateway

Gate: `pnpm exec vitest run apps/gateway/src` green against SQLite in
memory, plus one route test that POSTs then GETs a run against
testcontainers Postgres.

- [x] P3.1a App factory, store, Function cache and keys as Fastify plugins
      and decorators, auth hook, the AIP-193 error envelope with
      `ErrorInfo.reason` per the docs/API.md table, rejection of unknown
      fields, `null` values and query parameters, `setNotFoundHandler` and
      `setErrorHandler` rendering every framework error in the envelope.
      Acceptance: 401 `KEY_MISSING` without key, 404 `FUNCTION_NOT_FOUND`
      for a function outside the globs with a generic message, envelope
      shape on both, 400 `REQUEST_INVALID` on an unknown query parameter
      and on `null`, 404 `ROUTE_NOT_FOUND` on an unknown path, 415
      `CONTENT_TYPE_UNSUPPORTED` on `text/plain`.
- [x] P3.1b `X-Request-Id` handling, audit log fields, pino redaction,
      `krun_http_*` metrics with the `route` label rule. Acceptance: the
      401 line has `key: null` and a `reqId`; a 404 counts under
      `unmatched`; a redacted field never appears in a log line.
- [x] P3.1c `@fastify/swagger` and the `make generate` step writing
      `docs/api/openapi-public.json` (OpenAPI 3.1, the machine-readable
      form of docs/API.md). Acceptance: no diff on a second run; every
      method in the docs/API.md table appears with its path; response enums
      are typed `string` with the known values in `description`; no schema
      is nullable.
- [x] P3.2 `ListFunctions` (`{ functions, nextPageToken }`, `pageSize`,
      `pageToken`) and `GetFunction`, filtered by key globs, Ready only,
      Function fields per docs/API.md including `callback`, `queueTimeout`,
      `maxInputBytes`, `maxResultBytes`, `maxWait`. Acceptance: handler
      test; a key with no matching function gets an empty list;
      `callback` is present when `spec.callback` is set and omitted
      otherwise; no field is ever `null`.
- [x] P3.3 `CreateRun`: size limit before parsing, schema validation with
      `BadRequest.fieldViolations`, `requestId` idempotency on the request
      fingerprint, looked up before schema, callback and `maxQueued` checks
      (replay returns the current run with 201 and `Idempotent-Replay:
      true`, honouring `wait`; `ABORTED` on a different fingerprint), `priority`
      range and `runs:priority` scope, default callback from the Function,
      callback host and address check (`CALLBACK_NOT_ALLOWED`), rate limit,
      function and per-key `maxQueued` via `countQueued` and
      `countQueuedBy`, 201 with the FULL run and `Location`,
      `Retry-After: 1` on 429, `krun_admission_rejections_total`.
      Acceptance: one test per row of the docs/API.md error table that
      `CreateRun` can produce, including 403 `SCOPE_MISSING` for priority
      without scope, 400 `CALLBACK_NOT_ALLOWED` for a private callback
      address, 429 `QUEUE_FULL` with `metadata.limit` `key`, a replay with
      a changed `priority` yielding `ABORTED`.
- [x] P3.4 `GetRun` (FULL, `view=BASIC` accepted, `-` wildcard) and
      `ListRuns` (`{ runs, nextPageToken }` of BASIC runs through
      `toRunSummary`, `-` wildcard, `pageSize` coercion and negative
      rejection, `pageToken` bound to parent and filter, the filter
      grammar with `FILTER_INVALID`, malformed or mismatched token
      `REQUEST_INVALID`, no `view`) with owner scoping and `RUN_NOT_FOUND`
      for other keys' runs. Acceptance: handler tests; a list item has no
      `input`; `state = FAILED AND createTime >= "..."` filters correctly;
      a bad filter is 400 `FILTER_INVALID`; a token replayed with another
      filter is 400 `REQUEST_INVALID`; `pageSize=500` returns 200 items.
- [x] P3.5 `CancelRun` (`POST ...:cancel`): 200 with the FULL run from
      queued, scheduled, running (transition to `cancelling` with
      `payload.actor` = key name) and when already `cancelling` or
      `cancelled` (no new transition); 400 `FAILED_PRECONDITION`
      `RUN_TERMINAL` with `metadata.state` on `succeeded` or `failed`.
      Acceptance: handler test asserts the `cancelling` event carries
      `actor`, a repeat adds no event, a `cancelled` run returns 200.
- [x] P3.6 `GetRunResult` (`GET ...:getResult`) with inline, 307 (300 s
      presign, `Cache-Control: no-store`), `RESULT_MISSING` and
      `RUN_NOT_TERMINAL` branches; 200 on a failed run that kept a result.
      Acceptance: handler test with a fake object store covering all five.
- [x] P3.7 `krun gateway` wires config, store, Function cache, keys, the
      three listeners as scoped Effect layers under `NodeRuntime.runMain`,
      readiness, SIGTERM drain through scope finalizers:
      `/readyz` 503 first, `KRUN_SHUTDOWN_DELAY`, then close. Acceptance:
      process starts in embedded mode with a temp directory and `KUBECONFIG`
      pointing at `test/fake-kube` serving one Function, answers `/readyz`
      200 on the admin port, `/v1/*` is 404 on the admin port, with
      `KRUN_SHUTDOWN_DELAY=2s` a `/v1` request after `/readyz` turned 503
      still answers 200, and the process exits 0 within 5 seconds of
      SIGTERM.
- [x] P3.8 Internal API per docs/INTERNAL-API.md: second Fastify instance
      on `KRUN_INTERNAL_LISTEN_ADDR` under `/internal/v1`, per-run token auth
      against `job_token_hash` in `queued` with token, `scheduled` or
      `running`, the docs/INTERNAL-API.md check order, per-route body caps
      (status 16384, error 32768, result `KRUN_MAX_RESULT_BYTES`; Fastify's
      413 rewritten into the envelope), `GET input` re-serialised with
      `Content-Length`, `POST status` with the 1 accepted report per second
      window starting at the last 204 (body replaces `runtime_status`
      wholesale, `at` set by the gateway at receipt), `PUT result`, `PUT
      error` with field limits measured as compact JSON, store calls
      bounded to 5 s (`pg` `query_timeout`) answering 503 `NOT_READY`,
      `User-Agent` logged, unknown version 404 `UNSUPPORTED_API_VERSION`,
      the docs/INTERNAL-API.md error table (`TOKEN_INVALID`,
      `RESULT_TOO_LARGE`, `STATUS_RATE_LIMITED`, ...); `make generate`
      writes `docs/api/openapi-internal.json`. Acceptance: one test per row
      of the docs/INTERNAL-API.md error table; a run posting status at 10
      per second receives one 204 per second; a stalled fake store yields
      503 within 6 s; `make generate` leaves no diff for
      `docs/api/openapi-internal.json`, which lists the four operations,
      types `status` as `string` and has no nullable schema; `/internal/*`
      is 404 on
      the public listener and `/v1/*` on the internal one; a token from
      another run gets 401; a `queued` run with a token is accepted; the
      stored JSON has key `at` and `GetRun` renders `reportTime`.

### Phase 4: scheduler core

Gate: `make e2e` on kind in embedded mode: submit a run for a
`curlimages/curl` function shaped like docs/INTERNAL-API.md section 9
(`set -e`, `--fail-with-body`, retries) that fetches its input, posts one
status and PUTs the input back as its result, observe `succeeded` with the result and
`runtimeStatus`; a function that exits 1 ends `failed` within 10 seconds
with `failureReason` `exit_code` and `logTail` set; a function with an
unpullable image and a 60 second deadline shows `jobStatus.reason`
`ImagePullBackOff` while `scheduled`, then ends `failed` with
`deadline_exceeded`; a function that posts two statuses then exits 3 ends
`failed` with `exit_code`, `jobStatus.exitCode` 3 and `logTail` within 10
seconds; a function with `heartbeatTimeout: 30s` that posts one status then
sleeps ends `failed` with `heartbeat_timeout` within 60 seconds, `logTail`
set, Job gone.

- [x] P4.1 `apps/scheduler/src/k8s`: Job and Secret builders producing
      exactly the manifest in SPEC section 7 (immutable Secret, labels
      including `krun.io/created-by`, tolerations, `runAsUser`,
      `runAsGroup`, `HOME`, every env). Acceptance: golden-file test of the
      rendered Job and Secret for one function.
- [x] P4.2 Leader election with the Lease per the SPEC section 8 contract:
      `holderIdentity` is the pod name, `get` then `update` with the read
      `resourceVersion`, 409 retry in 2 s, expiry judged on the local clock
      from the last observed change, exit non-zero after 10 s without a
      renew; `krun_scheduler_leader`; Job and Pod informers, loops and the
      status writer start on acquisition and stop on loss; release on
      SIGTERM. Acceptance: unit test with a stubbed `CoordinationV1Api` for
      acquire, renew, 409, lose (informers stopped), renew failure exit and
      release. The two-scheduler check runs in P7.6.
- [x] P4.3a Kubernetes API plumbing: the `KRUN_K8S_CONCURRENCY` limiter with
      10 s `Effect.timeout` per call (the request's `AbortSignal` fires on interruption), error classification (transient
      back-off, permanent `job_create_failed` with `error.source` `krun`,
      `details.code` and `details.reason`), 429 with `Retry-After`,
      `krun_quota_rejections_total`, `krun_job_create_errors_total`.
      Acceptance: unit test: at most 8 calls in flight; a 503 is transient;
      a 422 is permanent with `details.code` 422; 429 honours
      `Retry-After`.
- [x] P4.3b Main loop per SPEC section 8: `countByState` first, expire
      queued runs of every function with queued runs (cached
      `queueTimeout` or 1h; an expired run with a token also gets its Job
      and Secret deleted), free slots, claim, per run Secret with token
      (`AlreadyExists` reads it), `setJobToken`, Job (`AlreadyExists` ok),
      `markScheduled` with cleanup on false and a cached-informer replay on
      true; no overlapping iterations, `state` notifies coalesced, the 10 s
      deadline releasing unprocessed claims. Acceptance: unit test with
      stubbed `BatchV1Api` and `CoreV1Api` covering `AlreadyExists` on both
      resources, 403 quota, 422 (run fails `job_create_failed`), 503 (lease
      released, back-off), `markScheduled` false (Job and Secret deleted),
      a `Complete` seen before `markScheduled` (run ends `succeeded`), a
      queued run of a deleted Function expiring after 1h with its Job
      deleted, a deadline hit releasing the remaining claims, and two
      notifies during an iteration yielding one more.
- [x] P4.3c Cancelling handling: foreground Job delete, Secret delete,
      transition to `cancelled`. Acceptance: unit test with the Job absent
      and present.
- [x] P4.4 Job and Pod informers (`makeInformer`) with the `krun.io/run-id`
      label selector, `error` handlers that restart the watch with backoff,
      the 5 minute leader reconcile timer over the caches (also once after
      sync), `jobStatus` derivation and deep comparison excluding
      `observedAt`,
      `running` on pod phase `Running`, `succeeded` from `running` or
      `scheduled`, terminal handling in order: object store check carrying
      `result_ref` (completed Job only, and only when `result` is null),
      compare-and-set with final `jobStatus`,
      `failureReason`, `error`, `logTail` and `startedAt` when missing;
      Secret delete; Job delete with background propagation; a run already
      terminal on read gets no writes but its Secret and Job deleted, 404 as
      success. Acceptance: unit test feeding Job and Pod events, including
      one error event, an `ImagePullBackOff` pod (run stays `scheduled` with
      the reason in `jobStatus`), a reconcile tick with no change (no
      write), a `Complete` on a `scheduled` run (succeeded, `startedAt` from
      the container), an object store error (run untransitioned, retried on
      the reconcile tick), a terminal run's replayed event (deletes only);
      the Job delete call is observed after the transition and the delivery
      payload carries `resultUri`.
- [x] P4.5 Main-loop step 6 and the reconcile timer: `job_lost` detection
      from `listByState` against the informer cache with a leader-local
      first-absent map, active only after the Job informer's initial list,
      2 minute grace, `krun`-sourced error unless the function reported
      one, written `result` kept, Secret deleted; startup log of
      `scheduled` or `running` runs with no Job. Acceptance: unit test with
      a run in `running` and no Job fails after 2 minutes; a run with a
      result keeps it; a run with a reported error keeps it; a Job reappearing clears the
      entry; nothing fires before the initial list.
- [x] P4.6 Metrics from SPEC section 11 owned by the leader:
      `krun_runs_transitions_total`, `krun_runs_current` from
      `countByState` each loop, queue wait, cold start, run duration.
      Acceptance: with `test/fake-kube` completing the Job, the exact metric
      names of SPEC section 11 appear on the admin `/metrics` after one run
      (no doubled `_total`, histograms in seconds), and with an in-memory span exporter the run's create request, iteration
      and Kubernetes calls appear as spans carrying the same `krun.run_id`;
      a `traceparent` sent with `CreateRun` becomes the parent of the request
      span.
- [x] P4.7 Function status writer on the leader: `Ready` condition with the
      reason from P2.2, patched through `CustomObjectsApi` only when
      `observedGeneration` or the condition changes. Acceptance: stubbed
      API; an invalid Function gets `Ready=False` with the reason; a
      repeated event causes no second patch.
- [x] P4.8 Failure detection per SPEC section 8: log tail capture on the
      first pod event with a non-zero exit, `OOMKilled` or
      `deletionTimestamp`, never for exit 0, 10 second timeout per
      `pods/log` call, fallback at the terminal transition; `failureReason`
      mapping with precedence (`oom_killed`, `deadline_exceeded`,
      `evicted`, `disrupted`, `exit_code`); `error` precedence (function
      report, then Kubernetes, then krun) with `logTail` separate; metrics
      `krun_runs_failed_total` and `krun_terminal_detect_seconds`.
      Acceptance: unit test with stubbed `pods/log`: exit 3 yields `failed`,
      `exit_code`, `logTail` fetched before the Job `Failed` event; a
      reported error survives as `error.source` `function`; `OOMKilled`
      yields `oom_killed`; `DisruptionTarget` yields `disrupted`; a hanging
      log call times out with `logTail` null; a pod gone before any fetch
      yields the Kubernetes reason in `error`.
- [x] P4.9 Heartbeat loop every 10 seconds, started only after both
      informers' initial list: `listStale` per Function with
      `heartbeatTimeout`; skip runs whose cached Job is `Complete` or
      `Failed` or whose cached pod is missing or not `Running`; otherwise
      log fetch, Job delete with foreground propagation, transition to
      `failed` with `heartbeat_timeout` (delivery inserted by the
      transition), Secret delete, in that order. Acceptance: unit test with
      a stale run asserts the call order and the final state; a run of a
      Function without `heartbeatTimeout` is untouched; a run with a fresh
      status is untouched; a stale run whose cached Job is `Complete` is
      skipped; a stale run with a reported error keeps it; nothing fires
      before the initial list.
- [x] P4.10 Sweep loop every 10 minutes: `sweep(now - KRUN_RETENTION, 1000)`
      until a batch returns fewer than 1000; delete `krun.io/run-id` Secrets
      older than 1 hour with no matching Job; `krun_sweep_deleted_total`.
      Acceptance: unit test with a fake clock and stubbed `CoreV1Api`.
- [x] P4.11 `krun scheduler` wires config, store, KubeConfig, Function
      cache, admin listener, leader election and loops; `/readyz` 503 until
      the database and the Function informer are ready, a standby stays
      ready and reports leader status; SIGTERM order per SPEC section 11
      ending with `holderIdentity` cleared. Acceptance: embedded mode with
      `KUBECONFIG` pointing at `test/fake-kube`: `/readyz` 200 as standby,
      exits 0 within 5 seconds of SIGTERM with the Lease cleared in the
      fake.
- [x] P4.12 `test/e2e` foundation: `make kind-up` pinned to kind 0.31 or
      newer following kind's local-registry recipe (`registry:2` as
      `kind-registry` on `localhost:5001` joined to the `kind` network,
      containerd `config_path` with a per-node hosts.toml mirror, the
      `local-registry-hosting` ConfigMap; `kind-down` removes it) with an
      enforcement probe (a default-deny policy in a
      scratch namespace blocks a pod-to-pod request, else e2e fails), jobs
      namespace manifests, `kubectl apply -f deploy/crds/functions.krun.io.yaml`,
      a `function.yaml` applied with `kubectl`, both processes deployed
      from the local image in embedded mode; a kind job in `ci.yml`
      (helm/kind-action on the same version) running `make e2e` on pull
      requests and main. Acceptance: `make e2e` with zero scenarios is
      green locally and in CI, enforcement probe included.
- [x] P4.13 `test/e2e` scenarios in the gate above. Acceptance: `make e2e`
      green.

### Phase 5: wait, SSE, webhooks

Gate: e2e adds a `?wait=30s` scenario on `CreateRun` returning 201 with
`state: SUCCEEDED` and the inline `result`, then a `POST ...:wait` on the
same run returning 200 with the same terminal run, and an in-cluster webhook
receiver pod, reachable through
`KRUN_WEBHOOK_ALLOWED_CIDRS` set to the kind pod and Service CIDRs, that
records one signed delivery and verifies the timestamped signature.

- [x] P5.1 Notify fan-out in the gateway: subscribe before insert, 1 second
      poll fallback, `wait` on `CreateRun` (status stays 201) and
      `WaitRun` (`POST ...:wait` with `timeout`), `KRUN_MAX_WAIT` cap,
      SIGTERM answers in-flight waits at once. Acceptance: handler test with
      a fake store emitting a transition, `WaitRun` returning the run at
      timeout without error, and one where SIGTERM ends the wait early.
- [x] P5.2 `WatchRun` (`GET ...:watch`) SSE of state, status and job
      status events with BASIC run data, `id` per docs/API.md, keepalive
      comments every 15 seconds, closes after terminal state and on
      SIGTERM; the first message is the current state, a terminal run at
      connect gets one message then EOF. Acceptance: handler test reads a
      state event, a status event, then EOF; `data` has no `input`;
      terminal-at-connect yields one message then EOF.
- [x] P5.3 Deliveries loop: `claimDeliveries(now, 40)`, POST through the
      P2.1 dispatcher with concurrency 8, a 10 second timeout,
      `redirect: 'manual'`, signature per attempt, the tick awaiting the
      batch and re-claiming at once when full, six attempts on the schedule
      then `dead`, 2xx only, `krun_deliveries_total`. Acceptance: unit test
      with a local `http.createServer` receiver returning 500 then 200, a
      302 counted as failure, a sixth failure marking `dead`, 40 pending
      rows delivered with at most 8 in flight.
- [x] P5.4 e2e scenarios for wait (201 on `CreateRun`, 200 on `WaitRun`)
      and webhook (constant `X-Krun-Delivery` across a retried attempt, two
      `v1=` entries during rotation) with the CIDR allowlist. Acceptance:
      `make e2e` green.

### Phase 6: object storage

Gate: e2e with MinIO in kind: a function uploads a 1 MB result, the run
shows `resultUri`, `GetRunResult` returns 307 to a URL that
serves the object.

- [x] P6.1 `packages/shared/src/objstore`: presigned PUT with TTL and no
      signed `Content-Type` (`requestChecksumCalculation: WHEN_REQUIRED`),
      presigned GET, object exists. Acceptance: unit test against a MinIO
      testcontainer; a PUT with `Content-Type: application/json` succeeds
      against the presigned URL.
- [x] P6.2 Scheduler sets `KRUN_RESULT_UPLOAD_URL` when configured
      (`KRUN_S3_PRESIGN_TTL` else `activeDeadlineSeconds`) and checks object
      existence before the terminal compare-and-set on `Complete` when
      `result` is null. Acceptance: unit test with a fake object store; the
      delivery payload carries `resultUri`; a run with an inline result
      skips the check; the TTL follows the variable.
- [x] P6.3 e2e scenario with MinIO, with a raw NetworkPolicy manifest in
      the pre-chart jobs namespace manifests allowing egress to the MinIO
      pods. Acceptance: `make e2e` green.

### Phase 7: Helm chart

Gate: `make helm-lint` green; `helm template` renders both modes; e2e
switches to installing the chart instead of raw manifests, in embedded
mode and in postgres mode with a plain Postgres Deployment from
`test/e2e/postgres.yaml`, each into a fresh krun namespace labelled
`pod-security.kubernetes.io/enforce=restricted`.

- [x] P7.1 Chart completed from the P0.8 stub: values from SPEC section 13
      including `config`, the CRD templated under `crds.install` with the
      keep annotation under `crds.keep`, no Function resources, Services
      (public and `krun-gateway-internal`, none for the admin ports),
      ServiceAccounts; every pod with the section 13 securityContext and
      the section 9 labels, probes on its admin port, default resources,
      `priorityClassName`, `terminationGracePeriodSeconds`; gateway PDB when
      `replicas > 1` and hostname topology spread; scheduler
      `RollingUpdate` `maxSurge: 1`, `maxUnavailable: 0`; keys mounted as a
      directory, no `subPath`. Acceptance: `helm lint` passes; the rendered
      manifests contain no `subPath`, no ConfigMap, no Function, no
      `kind: Secret`; `crds.install=false` drops the CRD; `crds.keep=false`
      drops the annotation; empty `apiKeys.existingSecret` fails with a
      clear message. Container probes, resources and env are asserted in
      P7.2 and P7.3.
- [x] P7.2 Postgres mode: two Deployments, migrate hook Job with weight 0
      and ServiceAccount `krun-migrate` rendered as a hook resource with
      weight -5, both with `pre-install,pre-upgrade` and
      `before-hook-creation,hook-succeeded`, no Role,
      `automountServiceAccountToken: false`, `restartPolicy: Never`,
      `backoffLimit: 1`, `activeDeadlineSeconds: 240`, DSN from the
      existing Secret. Acceptance: `helm template` renders without the
      StatefulSet; both hook resources carry the annotations and weights;
      the hook Job carries the bounds; every container has both probes with
      the section 13 timings, resources and every `config` key as env;
      postgres mode without `existingSecret` fails with a clear message.
- [x] P7.3 Embedded mode: StatefulSet with two containers, shared PVC with
      `fsGroup` 65532 and `OnRootMismatch`, scheduler
      `KRUN_ADMIN_LISTEN_ADDR=:9091` with port name `admin-sched`, ports and
      probes per container, init containers in order Litestream restore
      (orphan `-wal` and `-shm` removal, then restore) and `krun migrate`,
      Litestream as a native sidecar (init container with `restartPolicy:
      Always` between the restore init container and `krun migrate`) from
      `db.embedded.litestream.image`, `fail` when
      replicas exceed 1, Litestream Secret keys `LITESTREAM_ACCESS_KEY_ID`
      and `LITESTREAM_SECRET_ACCESS_KEY`; the pod runs as the scheduler
      ServiceAccount with no gateway ServiceAccount or RoleBinding; a
      headless Service as `serviceName`; `storageClassName` only when
      `storageClass` is non-empty. Acceptance: `helm template` with
      replicas 2 fails with a clear message; Litestream enabled without
      `image` or `existingSecret` fails with a clear message; the two
      containers expose different admin ports with different names and
      both probes with the section 13 timings, resources and every
      `config` key as env; the headless Service and the storageClassName
      rule render as specified.
- [x] P7.4a Jobs namespace resources gated by `jobsNamespace.create`:
      Namespace with versioned PSA labels and the keep annotation under
      `jobsNamespace.keep`, LimitRange with defaults and `max` for cpu,
      memory and ephemeral-storage, ResourceQuota including
      ephemeral-storage; always rendered: `krun-job-default` with
      `automountServiceAccountToken: false`; the digest
      ValidatingAdmissionPolicy and binding under
      `jobsNamespace.admissionPolicy`; chart `fail` when
      `config.maxRunning` exceeds `quota.pods` while `create` is true, when
      webhooks are enabled without a secret, or when object storage is
      enabled without `endpoint`, `bucket` or `existingSecret`. Acceptance:
      `helm template` output contains each kind with the ephemeral-storage
      entries; each `fail` case fails with a clear message;
      `jobsNamespace.keep=false` drops the annotation.
- [x] P7.4b RBAC: scheduler Role and RoleBinding and `krun-job-viewer`
      always rendered into `jobsNamespace.name`; gateway Role and
      RoleBinding, `krun-function-author`, Lease RBAC with `resourceNames`
      in the krun namespace. Acceptance: `helm template` contains each
      rule; `--set jobsNamespace.create=false` still renders the scheduler
      Role, RoleBinding, `krun-job-default` and `krun-job-viewer` and no
      Namespace, LimitRange, ResourceQuota or NetworkPolicy;
      `--set jobsNamespace.create=false --set config.maxRunning=300` renders
      successfully.
- [x] P7.4c NetworkPolicies per SPEC section 9: jobs namespace deny-all,
      `dnsEgress` peers, gateway 8081 by `krun.io/gateway` and namespace
      label, `objectStorage.egress`, `egressCIDRs`; krun namespace
      deny-all and allows for 8080, 8081 and the admin ports (9090, plus
      9091 in embedded mode) from `networkPolicy.metricsFrom`; `egressCIDRs`
      as `ipBlock` objects with `except`; NOTES.txt warning for an
      unrestricted `0.0.0.0/0`. Acceptance: `helm template` contains each
      rule in both modes, including a rendered `except`; the e2e checks run
      in P7.6.
- [x] P7.4d Optional features: `gatewayApi.httpRoute` renders an HTTPRoute
      to the public Service with the given `parentRefs` and `hostnames`;
      `jobsNamespace.userNamespaces` sets `hostUsers: false` on function
      pods through `KRUN_JOB_HOST_USERS`; `observability.*` sets the
      `OTEL_*` variables on both processes. Acceptance: `helm template`
      renders each only when enabled; e2e on kind with the admission policy
      on rejects a tag-only Job created by hand in the jobs namespace.
- [ ] P7.5 Chart README generated by `helm-docs` inside `make generate`,
      documenting every value, `crds.keep` consequences, the re-install
      procedure and the plain CRD manifest for `crds.install=false`.
      Acceptance: `make generate` leaves no diff; README matches
      `values.yaml` keys.
- [ ] P7.6 e2e installs through the chart in both modes into fresh
      namespaces with PSA `restricted` on the krun namespace, with
      `objectStorage.egress` pointing at the MinIO pods, and verifies: a job
      pod reaches the gateway internal port and not the public port; the
      embedded StatefulSet pod matches the 8081 policy; the admin ports are
      reachable from the monitoring namespace only when selected; postgres
      mode with `scheduler.replicas=2` yields one leader; an upgrade
      scenario: `helm upgrade --set config.logLevel=debug` then
      `helm rollback <release> 1`, both with pods Ready and a run
      succeeding after each, postgres mode asserting the migrate hook Job
      ran, a run submitted during the rollout succeeds and
      `holderIdentity` and `krun_scheduler_leader` move to the new pod,
      embedded mode asserting a run created before the upgrade is readable
      after it. Acceptance: `make e2e` green.
- [ ] P7.7 `metrics.podMonitor` (one endpoint per admin port name) and
      `metrics.prometheusRule` with the SPEC section 13 rule table and
      `thresholds`. Acceptance: `helm template` renders both when enabled;
      `promtool check rules` passes on the rendered rules; the rule names
      equal the table.

### Phase 8: SDKs and CLI

Gate: `krun init` for both languages yields a project whose tests pass and
whose image builds against vendored packed SDKs; e2e runs one SDK-built
function per language on kind.

SDK layout correction (owner-approved): both language SDKs belong under
`sdk/`: Node at `sdk/node`, Python at `sdk/python`. The completed P0.1
entry records the historical scaffold path `packages/sdk-node`; it is not
the target layout. Perform the migration at the start of P8.1, before new
Node SDK behavior, as a separate reviewed structural commit on a typed
feature branch. Move the existing package with its tests and TypeScript
configs; keep the npm identity `@krun/sdk` and its public API unchanged.
Update pnpm workspace membership/lockfile importers, build/test and Knip
configuration, Docker manifest/copy paths and ignore rules, CI, packing,
CLI templates, fixtures and active documentation/agent guidance together.
Do not include `sdk/python` as a pnpm package. Acceptance: a fresh frozen
install, `make build`, `make check`, current-source container build and
Node SDK packing pass; packed contents/exports are correct and no active
configuration references `packages/sdk-node`. Historical progress and
superseded decision records may retain the old path, explicitly labeled.
Do not mark P8.1 complete on the move alone; its behavior acceptance below
still applies.

- [ ] P8.1 `sdk/node`: `run(handler)` per SPEC section 7.1 and
      docs/INTERNAL-API.md, no runtime dependencies, `/internal/v1`, local
      mode (result on stdout, logs and status on stderr), the status send
      gate (latest payload, at most once per second, pending on 429, no
      eager `started`), `ctx.status` one attempt with a 3 s timeout that
      never throws, heartbeat with `setInterval(...).unref()` running until
      the result or error call returned, void handler sends no result,
      `ResultWriteError`, 10 s timeouts with 3 retries on the three other
      calls, 300 s upload, exit 1 on 401 and SIGTERM, `User-Agent`.
      Acceptance: unit tests against a local `http.createServer` fake of
      the internal API for success, void handler (no result request, exit
      0), result above `KRUN_MAX_RESULT_BYTES` uploaded to the presigned
      URL with `Content-Length`, upload 403 reported as `ResultWriteError`
      with exit 1, thrown error reported then exit 1, heartbeat pings at a
      third of `KRUN_HEARTBEAT_TIMEOUT` carrying the last status body and
      continuing during a slow result write, two immediate `ctx.status`
      calls yielding two requests 1 s apart, 429 re-sent at the next slot,
      oversized status and error bodies truncated to the contract limits,
      retry on 503, a never-answering fake timing out and retrying, 401
      ending the process, local mode stream separation; `package.json`
      lists no `dependencies`; the process exits without waiting for the
      heartbeat timer.
      `ci.yml` gains an `sdk-node` job running this suite on Node 22 and
      26.
- [ ] P8.2 `sdk/python`: the same with `urllib.request` and a daemon thread
      for heartbeats, `run(handle)` as a plain call under `__main__`, never
      a decorator; `pyproject.toml`, `uv`, `ruff`, `pytest`; `make test`
      runs it. Acceptance: the same test matrix as P8.1 against the same
      fake; importing a handler module executes nothing.
- [ ] P8.3 `test/sdk-conformance`: one scenario table (requests expected in
      order, with bodies) read by both SDK test suites, including
      `ctx.status("loading", 0.1)` followed by one heartbeat expecting two
      identical status bodies, two immediate `ctx.status` calls expecting
      two requests 1 s apart, a void handler expecting no result request,
      a slow result write with heartbeats during it, and an oversized
      status and error case. Acceptance: both suites pass on it;
      reordering one SDK's calls fails its suite.
- [ ] P8.4 `krun init --lang node` in `packages/cli` with the template from
      SPEC section 7.2: SDK dependency at the CLI version, Dockerfile with
      numeric `USER 65532:65532` copying the whole project, `function.yaml`,
      test, README. Acceptance: `pnpm pack` the SDK, then
      `krun init --lang node t && cd t && mkdir vendor && cp ../krun-sdk-*.tgz vendor/ && npm install ./vendor/krun-sdk-*.tgz && npm test && docker build .`
      green; `krun validate function.yaml` fails on `REPLACE_WITH_DIGEST`
      with a clear message.
- [ ] P8.5 `krun init --lang python`: the same template for Python.
      Acceptance: `uv build` the SDK, then
      `krun init --lang python t && cd t && mkdir vendor && cp ../krun-*.whl vendor/ && uv add ./vendor/krun-*.whl && uv run pytest && docker build .`
      green.
- [ ] P8.6 e2e: build both vendored template projects, `docker push` them
      to `localhost:5001/<name>`, take the digest from the push output's
      `digest:` line, reference `localhost:5001/<name>@sha256:...` in their
      Functions and apply them; run success with a result, a thrown error
      (`failureReason` `exit_code`, `error.source` `function`, `logTail`
      present), and a slow handler that outlives `heartbeatTimeout` while
      the SDK pings (stays `running`, then succeeds). Acceptance: `make e2e`
      green.
- [ ] P8.7 `krun deploy` per SPEC section 7.2 with `--no-apply`,
      `--namespace`, `--api-url`, `--registry`, the printed curl, the
      in-flight log command and the `GetRun` hint. Acceptance:
      on kind with `--registry localhost:5001`, `krun deploy` in a vendored
      template project ends with `Ready=True` and prints the three
      commands;
      `--no-apply` leaves the cluster untouched and `function.yaml` carries
      the digest.

### Phase 9: hardening, benchmarks, README, release

Gate: all e2e scenarios green; README states measured numbers and the
"when not to use krun" section; `release.yml` dry-run green.

- [ ] P9.1 Backpressure e2e: submit 3000 runs for a function with
      `maxQueued` 1000 and `maxConcurrency` 5; assert 429 `QUEUE_FULL`
      after the cap, never more than 5 Jobs active, quota rejections leave
      runs `queued`; a key with `maxQueued` 10 gets 429 at 11.
      Acceptance: test green.
- [ ] P9.2 Security e2e: input and token absent from
      `kubectl get pod -o yaml`; job pod blocked from the gateway public
      port, the admin ports and the database; a run's token rejected for
      another run id; tag-only image rejected at apply by the CRD; a
      Function with a non-compiling `inputSchema` shows `Ready=False` and
      gets 404 on POST whose envelope carries no validation reason; a
      Function naming a forbidden service account shows
      `ServiceAccountNotAllowed`; a run of another key is 404
      `RUN_NOT_FOUND`; a webhook to an unlisted `10.0.0.1` is rejected at
      create with `CALLBACK_NOT_ALLOWED`. Acceptance: test green.
- [ ] P9.3 Benchmark script: 500 runs of a 10 second function; record
      submit to `running` latency p50 and p95, failure detection latency
      p95 and sustained runs per second on kind. Acceptance: numbers
      written into README and docs/OPERATIONS.md.
- [ ] P9.4 README: purpose, boundaries, quick start for both modes as
      `scripts/quickstart.sh`, the golden path (`krun init`, `krun deploy`,
      run), platform-team onboarding (add a key, bind
      `krun-function-author` and `krun-job-viewer`, hand over namespace and
      URL), function container contract, API summary, link to SPEC.md and
      docs/OPERATIONS.md. `scripts/quickstart.sh` reads `KRUN_CHART`
      (default `oci://ghcr.io/xenarro/charts/krun`), `KRUN_IMAGE`
      (`repository:tag`, default unset), `KRUN_CLI` (default
      `npx @krun/cli`) and `KRUN_SDK_VENDOR` (packed SDKs copied into
      `vendor/` before `krun deploy`, default unset). Acceptance: e2e runs
      `scripts/quickstart.sh` on a fresh kind cluster in both modes with the
      local chart path, the pushed image, the workspace CLI, the packed
      SDKs and `KRUN_REGISTRY`, each exiting 0 within 30 minutes (timeout
      1800 s); durations recorded in README.
- [ ] P9.5 Release `v0.1.0`: prepare the release pull request (CHANGELOG,
      version stamps verified by the `release.yml` dry-run); the owner
      tags; after the tag `release.yml` publishes the signed image and OCI chart with SBOM to GHCR, `@krun/sdk` and `@krun/cli` to npm (after `publint` and `attw --pack` pass), `krun` to PyPI. Acceptance: the dry-run job is green on the release pull
      request; after the tag, `helm install` from the OCI chart works,
      `npx @krun/cli init` and `pip install krun` work, `cosign verify`
      passes on the image.
- [ ] P9.6 docs/OPERATIONS.md verified: every rule name in the alerts table
      exists in the rendered PrometheusRule (script), the Litestream
      restore drill runs in e2e embedded mode and a run created before the
      drill is readable after it, measured numbers filled in. Acceptance:
      e2e drill green; the name check passes.

## 5. Definition of done for v1

- Every task in Phases 0 to 9 is checked.
- `make check` and `make e2e` are green on CI.
- README quick start works on a fresh kind cluster in both database modes.
- No row in SPEC.md section 15 is contradicted by the code.

## 6. Progress log

2026-10-23 P0.1 d07922c Strict workspace and finite Effect entrypoints; TS/Python acceptance green.
2026-10-23 P0.2 d07922c Make targets, Biome/type checks and minimal Helm chart verified.
2026-10-23 P0.3 d07922c Current-source distroless image builds; numeric non-root command smoke verified in hosted CI.
2026-10-23 P0.4 d07922c CI run 39973106100 passed; syntax, generated-clean tree, container, audit and Trivy green.
2026-10-23 P0.5 d07922c 95 config tests and independent boundary/layer reviews passed; full make check green.
2026-10-23 P0.6 d07922c CLAUDE rules match required PLAN/SPEC constraints; no rule edit needed.

2026-10-23 P0.7 afc0375308920b271dd44340db6523a15ac120cc Scoped admin health and real Prometheus/conditional OTLP; P07-C1/C2 repaired. 43 health/runtime tests and make check (162 TypeScript/one Python) pass. Reconciled head 9f870d460898ac63e9221b497a9ce5887611e006 passed hosted CI https://github.com/xenarro/krun/actions/runs/40019565091 in PR #3; protected-main approval remains pending.

2026-10-24 P0.8 263c22b60108d5b022767cefd8eb30fa36c10719 Canonical strict Function schemas/types and native CRD/Helm/editor generation; P08-C1/C2 repaired and reviewer-authored regressions pass. 37 focused tests, make check (199 TypeScript/one Python), stable committed generation and Helm pass. Repaired-source Kubernetes acceptance passed 75 server checks; callback parity passed 317 cases. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40067784483 passed all gates in stacked PR #4 against feat/admin-health-telemetry; no layer merged or auto-merged.

2026-10-24 BLOCKED P0.9 Registry control and trusted-publisher preconditions remain unverified after implementation, two independent reviews and repair verification. Public npm scope metadata lists account krun as owner; @krun/sdk and @krun/cli return 404, which does not grant namespace control. PyPI krun already exists with an HTTP-test-library-described 0.1.0 release; project control/transfer or an owner fallback decision remains unverified. Exact npm/PyPI publisher bindings and intended GHCR package/repository grants are unverified; the CLI GHCR metadata query returns 403 for missing read:packages, not an Actions publishing denial. No fallback rename, credentials workaround, tag or publication. The release workflow/stamping implementation and real release PR dry-run acceptance remain absent; baseline make check (199 TypeScript/one Python), generation and Helm lint pass but do not complete P0.9 or Phase 0. Credential-free stamping/packaging/dry-run engineering is independent of publishing authorization and can be assigned separately. Continue independent P1.1 Store contracts from verified P0.8 lineage, preserving the release branch for recovery.

2026-10-24 P1.1 82d3a69239e728e0954dedf27ea7add2cee021e7 Store model and plain Kysely-compatible table interfaces, sole FULL/BASIC mappers, tagged errors and all 23 Effect Store method contracts; no database implementation. Both independent reviews and repair report no material findings. Task/root tsc --noEmit, 33 focused tests and make check (232 TypeScript/one Python) pass; independent probes pass 512 optional-field combinations, 42 result/state cases and 147 mapper/contract cases. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40072000762 passes all hosted gates in stacked PR #6 against build/release-preconditions, including current-source container build/smoke, generation, Helm, audit and scan. No installed-Kysely query integration or Phase 1 dual-backend gate claimed; actual migrations/Store implementations remain later tasks.

2026-10-24 P1.2 d862527a4dcf6c66f3400dae3850925b42af1485 Forward-only raw-SQL Kysely Migrator/FileMigrationProvider migrations for Postgres and built-in SQLite, scoped production database layers and the DB-only migrate command. Both independent reviews and repair found no material defects. Real temp-file SQLite and digest-pinned Postgres 18 Testcontainers acceptance verifies idempotency, unknown-only warning/zero exit, unknown-plus-pending one exit, rollback, schema isolation and sanitized resource failures. Store suite 61 and make check (263 TypeScript/one Python) pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40097891636 passes all hosted gates in stacked PR #7 against feat/store-contract, including frozen install, generated-clean, rebuilt non-root image with actual embedded migration smoke, Helm, audit and scan. D43/D44 preserve transactional SQLite DDL and explicit denial of unused transitive scripts. No layer merged or auto-merged; P1.9 and the full Phase 1 Store-method gate remain open.

2026-10-24 P1.3 8a189d466286bb5721c916b7db5011cc70963509 Database-backed createRun factory uses the composite partial unique index and one transaction for queued run/event insertion and Postgres notify. Both independent reviews found the same API3.3 fingerprint-default defect; repair reproduces and resolves P13-C1/P13-CONTRACT-1 with priority=0/callback=null normalization before Function callback fallback, preserving the supplied NewRun hash contract. Real temp-file SQLite/Postgres18 acceptance covers20 concurrent duplicates including mixed omitted/explicit-zero requests,one run/event,reordered JSON replay,genuine hash conflicts,owner/function scope,rollback,current-row decoding and committed notifications. Store suite87 and make check (289 TypeScript/one Python) pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40102991839 passes all hosted gates in stacked PR #8 against feat/store-migrations, including frozen install,generated-clean,rebuilt non-root image/migration smoke,Helm,audit and scan. Local rebuilt current-source image additionally passes compiled both-dialect normalized golden/replay/concurrency integration. D45 records real incremental factories without later-method stubs. No layer merged or auto-merged; full Store assembly,P1.4-P1.11 and the complete Phase1 gate remain open.

2026-10-24 P1.4 cda51a97494f71cc00748e10fbe5fbf6d302a830 All eight real leasing/scheduling/query methods implemented under D45 without future stubs: claimQueued,releaseLease,setJobToken,markScheduled,countByState,countQueued,countQueuedBy,listByState. Both independent reviews and no-defect repair verify unchanged accepted source. Real temp-file SQLite/Postgres18 contracts prove disjoint live claims,strict Clock-driven expiry/reclaim,priority/creation selection,release/token idempotency,scheduled CAS/event timestamp/lease clearing,stale cancellation,rollback including deferred-commit notify failure,scoped active/queue counts,list filtering and sanitized errors/spans. Exact5000-terminal/50-active ANALYZE/SET LOCAL/EXPLAIN names runs_active_idx.29 focused,116 Store and make check (318 TypeScript/one Python) pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40106782768 passes all hosted gates in stacked PR #9 against feat/store-create-run,including frozen install,generated-clean,rebuilt non-root image/migration smoke,Helm,audit and scan. Local immutable image additionally verifies all eight compiled methods on both dialects plus prior creation/migration integration,11 current emitted hashes and9 phases. No layer merged or auto-merged; full Store assembly,P1.5-P1.11 and complete Phase1 acceptance remain open.

2026-10-24 P1.5 4b15cd62064908e26024b3578349bb92a485a094 Real Database-backed transition factory under D45 uses one id/from-state CAS transaction for run update,shared Clock timestamp/actor state event,terminal pending BASIC callback delivery and Postgres notify. Both independent reviews consumed;P15-CONTRACT-1 reproduced as four failing lifecycle assertions and repaired so createRun/markScheduled retain their timestamps and missing-start enrichment is terminal-only. Four unchanged reviewer assertions pass;43 focused SQLite/Postgres18,159 Store and fresh make check (361 TypeScript/one Python) pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40110679826 passes all hosted gates in stacked PR #10 against feat/store-run-leasing,including frozen install,generated-clean,rebuilt non-root image/migration smoke,Helm,audit and scan. Local rebuilt repair image additionally verifies both-dialect compiled transition/lifecycle row-event-callback consistency,prior creation/leasing/migration behavior,13 emitted hashes and11 integration phases. Accepted function errors survive SQL coalesce;stale/event-delivery-decode-deferred failure paths preserve atomicity. No layer merged or auto-merged;full Store assembly,P1.6-P1.11 and complete Phase1 acceptance remain open.

2026-10-24 P1.6 5fe6834b15d77ada45e2ee3e8df9175201e30d07 Database-backed FULL getRun/BASIC listRuns factories under D45 implement documented AND filters, owner/function scoping, descending created_at/id row-value keysets and canonical scope/filter-bound cursors. BASIC physically excludes input/result/log_tail and uses the sole canonical mapper. Both independent reviews consumed; P16-C1 fractional RFC3339 comparison/hash drift reproduced and repaired by exact millisecond-grid operator normalization without narrowing grammar or changing Store types. Four new dialect regressions include192 independent integer comparisons; the unchanged reviewer oracle passes48/48 and rejects changed-filter cursors on both databases.36 focused,195 real temp-file SQLite/Postgres18 Store tests and make check (397 TypeScript/one Python) pass. Actual admin-list EXPLAIN names runs_created_idx. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40116652312 passes in PR https://github.com/xenarro/krun/pull/12 against main, including frozen installs, generated-clean checks, rebuilt non-root container/migration smoke, Helm, audit and fixable-critical scan; gate execution is verified from actual logs and the unchanged exact-SHA fail-closed workflow because the API omits per-step records. Local rebuilt repair image additionally verifies15 emitted hashes/13 phases with48 compiled fractional comparisons and previous migration/create/leasing/transition behavior. Authorized CLAUDE author policy is a separate docs(agents) commit with normal ancestry reconciliation of the already-merged integration#11; no published history rewritten. P1.6 is pushed/green, not merged; protected-main independent review remains required. Full Store assembly and Phase1 acceptance remain incomplete.

2026-10-24 P1.7 c7c1d766d8645c3042c8faa72725da46446f7bd3 Database-backed expireQueued, sweep, claimDeliveries and updateDelivery factories under D45 pass 53 focused and 248 real SQLite/Postgres 18 Store tests. Expiry returns FULL cleanup metadata and atomically writes finish/event, BASIC callback and Postgres notify; strict queued/function/cutoff CAS prevents duplicate winners. Retention performs bounded oldest-row cascades with same-connection SQLite incremental vacuum; delivery claims atomically lease due pending rows for 60 s using SKIP LOCKED/BEGIN IMMEDIATE. Both independent reviews were consumed; P17-C1/P17-CONTRACT-1 are one reproduced defect, fixed by coalescing a safe KRUN queue-timeout diagnostic in the same expiry UPDATE before decode/callback while preserving all accepted reports. Four new dialect regressions, the unchanged correctness eight-control probe and source-identical six-check contracts probe pass. Fresh make check passes 450 TypeScript tests and one Python test; the rebuilt local non-root image verifies 16 current emitted hashes/15 phases, including both compiled maintenance backends and prior Store/migration behavior. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40121735947 passes in stacked PR https://github.com/xenarro/krun/pull/13 against immediate unmerged parent feat/store-run-queries/PR #12, including frozen installs, generation/clean checks, rebuilt image/migration smoke, Helm, audit and fixable-critical scan. Gate execution is verified from successful API step records, actual logs and the unchanged exact-SHA fail-closed workflow. Source is pushed/green, not merged; no auto-merge or protected-main review bypass. Full Store assembly and Phase 1 acceptance remain incomplete.

2026-10-24 P1.8 2940bf228fef86fcd5f6e0169b85e7d875e198b9 Database-backed subscribe under D45 uses one lazy shared scoped Postgres LISTEN client outside the five-slot query pool, fresh-client bounded exponential reconnect, validated advisory kinds and scoped cancellation; SQLite snapshots max(rowid) and polls strict ordered one-second cursors without replay. Both independent findings P18-C1/P18-CONTRACT-1 reproduced one retention/rowid-reuse defect; D46 and forward0002 preserve shipped0001, sparse rowids/data,index/cascade and old six-column writers with an internal AUTOINCREMENT alias.19 real backend subscription checks plus3 migration regressions,270 Store and make check472 TypeScript/onePython pass. Newly rebuilt non-root image verifies20 emitted hashes/18 integration phases,including actual previous-image upgrade and old writer after upgrade;generation/generated-clean,Helm,actionlint,audit and scan pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40128846408 passed in https://github.com/xenarro/krun/pull/14 against the unmerged feat/store-expiry-delivery parent. Initial local full-check5s migration deadline retained;isolated3,unchanged full retry and exact hosted suite pass with no weakened assertions/timeouts;root scheduling cause not established. Source pushed/green,not merged;full Store assembly and Phase1 remain incomplete. P0.9 stays independently owner-blocked.

2026-10-25 P1.9 8a9fe97b03a58c241ea0f19cee69dc4255019c5d Completes native SQLite acceptance without duplicating the adapter and immediate driver already required by P1.2. Four new temp-file checks prove pre-body writer reservation with numeric SQLITE_BUSY 5, WAL committed-only visibility, commit/rollback writer recovery, serialized physical-connection reuse and reopened pragmas. All 10 dialect checks, 274 real SQLite/Postgres Store tests and make check (476 TypeScript tests and one Python test) pass. Both independent reviews found no confirmed material defect; the no-defect repair retained unchanged runtime and reran eight native control groups plus a separate native writer process. The current non-root image verifies 20 emitted hashes and 23 integration phases; generation, generated-clean checks, Helm, actionlint, audit and scanning pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40133747415 passed in https://github.com/xenarro/krun/pull/15 against immediate unmerged parent feat/store-subscriptions/PR #14. Historical default five-second parallel-test deadline failures are retained; their root cause is unconfirmed and instability is not claimed repaired. Fresh delivery Store/full gates and code CI passed without retries or weakened assertions, deadlines or scheduling. Source is pushed/green, not merged; full Store assembly and Phase 1 remain incomplete. P0.9 remains independently owner-blocked.

2026-10-25 P1.10 36afd4b374fe6ee0bbbecb2722d3591eca485271 Database-backed setRuntimeStatus, setResult, setError and setJobStatus under D45 enforce eligibility in SQL. Latest function reports do not mutate lifecycle, history or callbacks and retain FUNCTION error priority through terminal coalesce. Job-status semantic CAS ignores observedAt, key order and numeric spelling, appending one same-state event and committed hint only on genuine change. All 42 focused and 316 real SQLite/Postgres 18 Store tests plus make check (518 TypeScript tests and one Python test) pass. Both independent reviews have zero material findings; repair preserves source and reruns 16 native groups, 64 field cases, 40 concurrent writers, 24 terminal races, two semantic-oracle tests and four-method SQLite interruption/visibility/settle-before-close controls. The current non-root image verifies 21 emitted hashes and 25 phases; generation, generated-clean checks, Helm, actionlint, audit and scanning pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40137897538 passes in stacked PR https://github.com/xenarro/krun/pull/16 against immediate unmerged parent feat/store-sqlite-dialect/PR #15. Fresh code-delivery Store/full gates and hosted code checks passed without retries. A tracking full-check attempt exceeded the unchanged five-second SQLite migration-CLI test deadline; the isolated migration suite and exact unchanged full retry pass. Historical timing causes remain unconfirmed, not claimed repaired; P3.7 must separately verify strict HTTP cancellation/deadline semantics. Source is pushed/green, not merged; no auto-merge or protection bypass. P1.11, full Store assembly and Phase 1 remain incomplete; P0.9 stays independently owner-blocked.

2026-10-25 P1.11 5a7b2f37ef22d2baaa9899558051d3029a124cdf Completes listStale with the prescribed later-of-status/start expressions, strict cutoff, function/running-state scoping, FULL decoding and sanitized spans/errors. D45 assembly now provides all 23 real scoped Store methods without placeholders. Independent finding P111-CONTRACT-1 is reproduced and repaired: one validated classification is derived from either existing argument, missing/unknown/conflicting pairs roll back atomically, and failed row/event/BASIC callback agree while stale CAS and FUNCTION error coalesce remain intact. Native timing reproduced SQLite initialization under default FULL/0 policy before the required settings; applying the same NORMAL/5000 policy before persistent writes preserves all five pragma values and removes the observed avoidable initialization cost.13 new regressions,18 original stale/assembly checks,347 exact Store tests and make check549 TypeScript/one Python pass. Owned reviewer probes pass8 contract tests and14 native groups/600 oracle/18 reason cases; rebuilt nonroot repair image verifies23 hashes/29 phases. Fresh delivery exact phase gate and pre-commit make check pass without retries. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40145278152 passes in https://github.com/xenarro/krun/pull/17 against immediate unmerged parent feat/store-runtime-status/PR #16, including all9 required gates. Only then this task is checked. Phase1 Store acceptance is implemented and verified;source pushed/green,not merged,with no auto-merge or protected-main review bypass. Earlier failed attempts remain preserved;the observed startup cause is repaired,not every historical timeout or arbitrary host I/O latency. P3.7 strict HTTP cancellation/deadline acceptance and owner-blocked P0.9 remain separate. Next product task P2.1 follows final committed verified P1.11 lineage.

2026-10-25 P2.1 55bb6e1cac2ac1bacd6f1831bfeaca6332566d21 Reusable webhook helpers enforce compiled host globs, all-answer CIDR-or-unicast checks with mapped IPv4 normalization, fresh per-attempt DNS resolution and a scoped Undici Agent pin retaining TLS SNI, Host and certificate identity. Redirects fail; raw-byte HMAC emits one send-time signature per active validated key; bounded errors retain no URL, header, body or native diagnostics. Both independent reviews were consumed. P21-CONTRACT-1 was reproduced as a non-stable injected-provider checked/pinned mismatch and repaired with one frozen validated primitive address snapshot. Seven new regressions include the real allowed 127.0.0.2 versus excluded 127.0.0.1 receiver case without widening CIDRs; no stock OS-resolver remote exploit is claimed. All 71 webhook tests, the current Phase 2 command with 84 existing tests, and fresh pre-commit make check with 620 TypeScript tests and one Python test pass. Six owned contracts probes, compiled two-key raw-wire verification and seven correctness groups covering 384 address cases and 64 binary signature cases pass after repair. The rebuilt repair image verifies 29 emitted hashes and 42 integration groups; generation, Helm, actionlint, audit and fixable-critical scanning pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40150535757 passes all nine hosted gates in https://github.com/xenarro/krun/pull/18 against immediate unmerged parent feat/store-stale-runs/PR #17. Only after code CI passed was P2.1 checked. Source is pushed/green, not merged; no auto-merge, protection bypass or independent GitHub approval is claimed. Historical allocator timing and reviewer-wrapper attempts remain preserved; no deadline, worker or assertion was weakened and no universal timing fix is claimed. Helpers are not yet wired into gateway/scheduler. P2.2-P2.5, complete Phase 2/application/e2e acceptance, P3.7 and owner-blocked P0.9 remain separate. Next product task P2.2 follows final committed verified P2.1 lineage, not obsolete main.

2026-10-25 P2.2 4745b65838f7dd4064f3fa9852b205a1bc85abb5 One pure synchronous Function validator reuses the source wire/duration schemas and explicit installation ceilings,compiles owned size-checked UTF8 JSON snapshots with strict Ajv2020 and the complete default ajv-formats plugin,and returns existing bounded Ready reasons plus parsed Effect durations. Callback admission reuses P2.1 host matching without DNS/environment/clock/cluster access. Both independent reviews were consumed. P22-C1/P22-CONTRACT-1 reproduce one omitted own __proto__ constraint root;D48 records a tracked approved-Ajv8.20.0 patch preserving all schema-map names and null-prototype property/evaluation/dependency dictionaries in published TS and runtime JS,without key bans,renaming,schema rewriting or weakened strictness. P22-CONTRACT-2 restores four default format-comparison keywords,including inclusive/exclusive equality boundaries. All32 new compiler regressions,82 Function/72 webhook tests,current154-test Phase2 slice and fresh pre-commit make check690 TypeScript/one Python pass. Eight unchanged copied contracts tests and12 correctness cases now have zero mismatches;format/reference/snapshot controls pass. Rebuilt nonroot repair image verifies31 emitted hashes,eight dependency-file hashes and56 combined integration groups/phases including prior Store/webhook/resolver behavior;generation,Helm,actionlint,audit and scan pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40156786037 passes all9 required gates in https://github.com/xenarro/krun/pull/19 against immediate unmerged parent feat/webhook-security/PR18. Only after accepted code CI passed was P2.2 checked. Source is pushed/green,not merged;no auto-merge,protection bypass or independent GitHub approval is claimed. Original reviewer and failed-wrapper evidence is retained;no assertions,deadlines or scheduling were weakened. Informer/cache,keys/auth,real validate CLI,complete Phase2/application/e2e acceptance and owner-blocked P0.9 remain separate. Next product task P2.3 follows final committed verified P2.2 lineage,not obsolete main.

2026-10-25 P2.3 93daef9dc4e166d39110903384fabee357dc8e7a Scoped KubeConfig loading,authenticated namespace LIST/WATCH and Function cache implement add/update/delete/atomic relist,UID-generation validator reuse,404/watch-error bounded backoff,successful-initial-LIST readiness and bounded-label Prometheus gauges. Both independent reviews consumed;P23-C1/P23-CONTRACT-1 are one reproduced wide-schema snapshot root,repaired by per-child traversal without truncation,key bans,64KiB relaxation or hidden decode failures. Four new array/dictionary startup/update regressions preserve valid neighbors,invalid diagnostics/queueTimeout,own keys and stale-generation exclusion. All32 task tests,current169-test Phase2 slice and fresh unrestricted make check722 TypeScript/one Python pass. Owned reviewer reruns include four contracts cases,both compiled correctness regressions and eight native transport/isolation groups. Rebuilt nonroot repair image verifies35 emitted hashes,12 dependency hashes and70 integration groups;generation,Helm,actionlint,audit and critical scan pass. Initial feature commit fb8b35f702a0e894fe914dd026f77bf3d8f38f4d failed hosted CI because three fixtures required agent TMPDIR. Reproduced locally and fixed both paths with node:os.tmpdir(),retaining owned mkdtemp prefixes/cleanup and every assertion;missing-TMPDIR tests and fresh full gate pass before correction commit. Exact accepted code CI https://github.com/xenarro/krun/actions/runs/40163143968 passes all9 required gates in https://github.com/xenarro/krun/pull/20 against immediate unmerged parent feat/function-validation/PR19. Only after accepted code CI passed was P2.3 checked. Source is pushed/green,not merged;no auto-merge,protection bypass or new independent GitHub approval. Historical timing/private-harness/failed-CI evidence remains unchanged;no assertion,deadline,worker or affinity relaxation in repair/delivery. This is reusable infrastructure,not actual serving processes,status writer,keys/CLI or full Phase2/application/cluster/e2e acceptance. P0.9 remains independently owner-blocked. Next independent task P2.4 follows final committed verified P2.3 lineage;preserve current feature on recovery.

2026-10-25 P2.4 3367ae070b255fac27450a291c4c6afb9ab4ab3d Reusable gateway-only Keys/KeysLive strictly decode and validate keys.yaml,string/list rotation,unique label-value names,all five scopes including explicit runs:priority/admin,native case-sensitive/dot-enabled function globs and per-key maxQueued metadata. Every lookup hashes exact strings and compares all fixed-width digests with native timingSafeEqual without early return or a secret-indexed map;cross-owner ambiguity fails closed and returned frozen principals expose neither raw credentials nor digests. Scoped30-second raw-content-hash polls reopen mounted paths through Secret symlink swaps,publish complete snapshots atomically,retain last-good state on later failures and reject startup failures with bounded reason/field/index diagnostics. Both independent reviews found zero confirmed material defect;repair preserved source and reran six compiled correctness groups,six label cases,four additional contracts cases and native rotation/revocation/startup controls. Fresh44 auth tests,current213-test Phase2 slice and unrestricted pre-commit make check766 TypeScript/one Python pass. Rebuilt nonroot repair image verifies38 emitted hashes,19 dependency-file hashes and80 integration groups,plus standalone NodeRuntime startup exit1 without native diagnostics;generation/drift,Helm,actionlint,frozen install,audit and critical scan pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40167721878 passes all9 required gates in https://github.com/xenarro/krun/pull/21 against immediate unmerged parent feat/function-informer-cache/PR20. Only after accepted code CI passed was P2.4 checked. Source is pushed/green,not merged or formally independently approved;no auto-merge or protection bypass. Original implementation and reviewer harness failure evidence is preserved;no product repair,optional-peer installation,policy exception or assertion/deadline/worker relaxation. P2.5 validate CLI,actual gateway auth/envelopes/ownership/rates,CreateRun queue-cap enforcement and full Phase2/application/e2e acceptance remain later work;P0.9 publishing preconditions stay independently unresolved.

2026-10-25 P2.5 a0d16b02b2b799127aa341f47866de4c9420666c Real offline validate dispatch reads explicit files and sorted immediate YAML directories,parses every document,uses the source Function resource schema/defaults and shared pure second-layer validator,prints the five actual defaulted ceilings on stderr and one bounded result per Function,and exits1 on any error or empty set. No DB,namespace mount,keys file,generated-schema read,DNS or cluster acquisition. D49 records deterministic discovery/output;D50 keeps native ESM shared workspace builds before consumer lint without relaxing checks. Both independent reviews consumed;P25-C1 reproduced five valid reference-named property/definition/default/enum contexts rejected on host/image and was repaired at the shared owned-snapshot reference guard,not CLI delegation. D51 preserves actual nested/unused/pointer-promoted remote rejection,conservative native anchor inspection,strict synchronous compilation,no loader,own keys,size/privacy and unmodified snapshots. All72 shared reference regressions,25 real CLI tests,current285-test Phase2 gate and fresh pre-commit make check862 TypeScript/one Python pass;original native good/bad correctness probe and five additional contracts cases pass after repair. Rebuilt nonroot repair image verifies40 emitted hashes,19 dependency-file hashes,80 inherited integration groups and seven CLI groups including read-only tag-image exit1/one line,mixed exit1/two lines,callback denied/explicitly allowed and reference/remote controls. Generation/drift,Helm,actionlint,frozen install,audit and fixable-critical scan pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40174400276 passes all9 required gates in https://github.com/xenarro/krun/pull/22 against immediate unmerged parent feat/api-key-loader/PR21. Tracking verification retained two unchanged5s SQLite migration/dialect deadline failures;isolated migration controls pass and measured host I/O pressure is severe. Full tracking acceptance passes with only per-command best-effort I/O priority0 (ionice class2),without assertion/deadline/worker/CPU-affinity changes;no universal timing or product race repair is claimed. Only after accepted code CI passed was P2.5 checked. Phase2 declared helper/cache/keys/offline-CLI acceptance is verified;source pushed/green,not merged or formally independently approved,no auto-merge or protection bypass. Original failed attempts/reviewer reports and unrelated Store timeout evidence preserved;no assertions,timeouts,workers,security policy or SDK runtime dependency weakened. Gateway/scheduler serving routes,complete application/e2e,P3.7 HTTP cancellation/deadlines and owner-blocked P0.9 remain separate. Next independent task P3.1a follows final committed verified P2.5 lineage;fork a new typed child only when that feature begins.

2026-10-25 P3.1a b24b2062108f36ccbd60377a12e4db154ce6b9a4 Scoped non-listening Fastify factory exposes existing Store, Functions cache, Keys and cancellation-aware Effect runner through native encapsulated plugins. Pre-parser auth enforces declared scopes/function globs,raw duplicate-header rejection and generic hidden-function errors;all20 canonical API error mappings are covered. D52 preserves owning context and request-finalizer settlement before external dependencies close. Both independent reviews consumed;P31A-C1/P31A-CONTRACT-1 reproduce one pre-routing framework envelope/path-reflection defect,while P31A-CONTRACT-2 reproduces wrapped-root unknown-field stripping. D53/common renderer and supported-wrapper strict normalization repair both roots without new public methods/reasons/security exceptions,deep opaque-schema rewriting or lost omission/default/refinement/metadata semantics.59 exact gateway/phase tests include real SQLite/Postgres18 test-owned HTTP POST/GET,native malformed URLs with/without credentials,abort/finalizer ownership and strict/null/content-type controls. Fresh pre-commit make check920TypeScript+onePython passes using per-command IO priority only;no CPU-affinity,worker,existing deadline/assertion or Store changes. Rebuilt nonroot image verifies53 current emitted hashes and95 groups(80 inherited,eight gateway,seven CLI),plus16-row inject/socket credential matrix and blocked-finalizer/external-Store controls;generation,Helm,audit/scan/frozen install pass. Exact code-head hosted CI https://github.com/xenarro/krun/actions/runs/40188371354 passes all9 required gates/920TS+onePython in https://github.com/xenarro/krun/pull/23 against immediate open parent feat/function-validate-cli/PR22. Only after accepted code CI was P3.1a checked. Earlier failures remain retained,not universal timing-repair evidence. Source is pushed/green,not merged;no auto-merge,formal repository approval or protection bypass. Production public methods,request IDs/audit/metrics,OpenAPI,process/listener wiring,drain/full-app e2e and complete Phase3 remain later work;P0.9 remains independently owner-blocked. P3.1b starts only from final committed verified P3.1a lineage.

2026-10-25 P3.1b 6d3e2b347204f2dddd2341ac2a8e07e651d3a011 Shared public/admin HTTP observability uses owning Effect Clock UUIDv7 correlation,one redacted native pino policy and request Effect logger/active-span IDs. Exactly-once public completion audits retain authenticated key names(null on401),trusted-proxy IP,User-Agent and approved run/function/query-idempotency metadata;no raw target,Run body or credential reflection. Native completion/finish deduplication covers bootstrap router failures. Exact krun_http_requests_total{route,code} and krun_http_request_seconds{route} use bounded registered labels and404 unmatched. Both independent correctness/contracts reviews consumed;P31B-C1 absolute-form native audit omission andP31B-C2 body/query correlation mismatch reproduced before source repair. D54/D55/native origin-http-https matrix and query-only own-string128-character extraction fix both roots without API/security/dependency changes.73 gateway phase tests include real SQLite/Postgres18 test-owned HTTP round trips;26 focused tests and actual exported-span privacy pass. Rebuilt nonroot repair image passes101 groups(80 inherited,eight gateway,six observability,seven CLI),56 module hashes plus native absolute/idempotency/framework/credential regressions. Fresh code precommit make check946TypeScript+onePython passes with per-command IO priority only;one earlier unchanged ten-suite120s Postgres startup-hook failure remains retained,with Docker/pinned-image health and isolated original fixture control plus unchanged full recovery green. All assertions,budgets,workers and runtime dependencies preserved. Normal source-identical ancestry reconciliation bd791d58c5eba84042922995c2b86256c360381c integrates main3a91f836 without discarding dirty work;all prior required stack PRs are merged. Exact code-head hosted CI https://github.com/xenarro/krun/actions/runs/40199214351 passes all9 gates/946TS+onePython in https://github.com/xenarro/krun/pull/25 against main. Only after that accepted CI was P3.1b checked. Source is pushed/green,OPEN with REVIEW_REQUIRED,not merged;no auto-merge,formal approval or protection bypass. Next independent taskP3.1c starts from final committed verified current feature lineage while PR25 awaits independent main review;OpenAPI,public methods,request spans,listeners/drain and fullPhase3/kind/e2e remain later work.

2026-10-25 P3.1c 58db616e628e3b6e6c0a2db52df5340ca5681a08 Generate the canonical OpenAPI 3.1 public contract through actual Swagger/Zod transforms for all nine normative methods, paths and scopes, with open response enum descriptions and non-nullable owned schemas. D56/D57 preserve scoped development-only generation, opaque own-key identity and strict writable validation while discarding recognized output-only non-null request values. Both independent review roots are reproduced, repaired and permanently regressed; all three findings are resolved. Fresh local make check passes 987 TypeScript tests and one Python test; focused acceptance 41, gateway phase gate 97, actual two-run generation is byte-identical. Rebuilt non-root image passes compiled native regressions, seven CLI groups and 57 emitted hashes; Helm, frozen install, production audit, workflow lint and fixable-critical scan pass. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40209410324 passes all nine required gates in https://github.com/xenarro/krun/pull/26 against main after normal content-preserving reconciliation with merged PR25. Source is pushed and green, not approved or merged; no auto-merge or protection bypass. No production business method, listener, publication or complete Phase 3/e2e claim.

2026-10-25 P3.2 22edfcc408e1b784f194fd58b761e2c1113401c0 Deliver real authenticated ListFunctions/GetFunction from the validated Function cache with Ready/current-glob visibility, exact public-field projection, optional callback/heartbeat omission, configured zero caps and generic hidden/missing/invalid errors. D58 records owning parsed configuration and canonical bounded principal/grant-bound name-keyset cursors. Both independent P32-C1 findings share one reproduced canonical-admission/public-int32 mismatch; D59 corrects all three source fields and generated CRD/editor/Helm bounds without widening or clamping. Permanent boundary, mixed-page, reload/keyset and schema-parity regressions pass. Focused acceptance 23, gateway factory gate 117 and fresh pre-commit make check 1010 TypeScript plus one Python pass. Rebuilt hardened image passes original 11 native handler groups, three boundary cases plus seven independent native controls, seven CLI groups and 58 module hashes. Dedicated disposable Kubernetes admission passes all 12 boundary cases and verified cleanup; double generation, Helm, frozen install, audit, workflow lint and scan pass. Normal content-preserving main reconciliation fcaf13ac457c7ae3ed45aaa7783b06a535854df0 retains reviewed source after PR26 merged. Exact code-head CI https://github.com/xenarro/krun/actions/runs/40218290772 passes all nine gates in https://github.com/xenarro/krun/pull/27 against main before this P3.2-only tracking closure. Earlier unrestricted-host Store timeout receipts and controls remain preserved. Tracking pre-commit verification uses the complete unchanged make check in a disposable two-CPU/default-parallelism container with file-backed SQLite temporary files on tmpfs and normal Postgres Testcontainers; actual Node/pnpm/Python versions match. Assertions, budgets, repository worker configuration, Store code and policy are unchanged; this does not claim unrestricted-host timing repair. Runtime code is independently approved and merged via PR27; this follow-up delivers only its PLAN/README tracking after normal reconciliation with current main. No agent auto-merge, protection bypass, production/publication or complete Phase 3/application-e2e claim.

2026-10-26 P3.3 326a3966e560b1d602a54e7796371e2fec30a593 Deliver authenticated CreateRun with byte limits before parsing, canonical BadRequest/errors, current-grant priority enforcement, callback/address policy, rate/function/key queue admission, Clock UUIDv7, transactional actor events, early current-state fingerprint replay and scoped capped waits. D60-D64 record real composition, native completed-body cancellation and owning-registry fixes, current-priority replay repair and lossless PostgreSQL Unicode NUL input/identifier storage with a forward migration. Both independent reviews consumed; P33-C1/C2 reproduced, repaired and dispositioned. All52 focused tests (42 CreateRun,2 UUID/Clock,8 real-database Unicode/migration/rollback controls), exact159-test gateway gate and fresh make check1062 TypeScript/onePython pass; no assertion, deadline or worker relaxation. Rebuilt nonroot image verifies15 native admission/isolated-metric groups,7 CLI groups,63 hashes,native SQLite/Postgres and actual previous-image ordinary-ID/NUL-input compatibility; deterministic generation,Helm,frozen install,audit,workflow lint and fixable-critical scan pass. Runtime commit 0961769ff6b0f7607e23d6f5e6c2b62fa30c1315; normal verified-main reconciliation produces accepted code head above. Exact code-head hosted CI https://github.com/xenarro/krun/actions/runs/40237884278 attempt2 passes all9 gates. Its first attempt hit the unchanged four-process CLI test's aggregate5s deadline; isolated and unchanged exact-head retry pass,not a universal timing repair. Runtime PR https://github.com/xenarro/krun/pull/29 is independently APPROVED/MERGED as 68f2e7cd35cda44eba3f35cba12c613beecf663a; this job did not merge or bypass protections. Only after accepted code CI was P3.3 checked. This documentation-only tracking follow-up normally reconciles that merged main and requires its own fresh pre-commit/full hosted acceptance. Public Run reads,listener/process startup and complete Phase3/application-e2e remain separate PLAN tasks.

2026-10-26 P3.4 394792cb474635cc7e466ba1cf77394d24a21c61 Deliver real authenticated GetRun FULL/default and BASIC, stored-function wildcard resolution and generic missing/forbidden/other-owner/wrong-parent RUN_NOT_FOUND; successful wildcard audits use authorized stored metadata. ListRuns returns canonical BASIC summaries with typed state/reason/precise-time filters, current owner/glob visibility before full-page boundaries, pageSize defaults/cap/negative rejection and opaque parent/exact-filter/current-principal/grant-bound navigation. D65 preserves stored Run history independently of current Function cache state, bounded-batch lookahead without hidden-tail tokens and pure existing Store-cursor validation without masking real database errors. Both independent final reviews have zero confirmed findings; reviewed runtime/tests/SPEC are unchanged in repair. Fresh62 focused,185 exact gateway tests and full precommit make check1088 TypeScript/onePython pass. Existing immutable nonroot image verifies26 native groups per backend,64 runtime hashes,7 CLI groups; all four generated artifacts,Helm,frozen install,audit,workflow lint and fixable-critical scan pass. Exact pushed code-head CI https://github.com/xenarro/krun/actions/runs/40246285257 attempt1 passes all9 required gates in https://github.com/xenarro/krun/pull/31 against main before only-P3.4 tracking closure. At code acceptance PR31 is OPEN/REVIEW_REQUIRED; source peer reviews do not bypass actual independent protected-main approval, and this job does not auto-merge. The separate documentation tracking commit requires its own fresh full precommit and exact-head hosted acceptance. Later CancelRun/result reads,listener/process/internal API assembly and complete application-e2e remain separate PLAN work.

2026-10-26 P3.5 46712f2f29448dc324d81ad43d2fbd19deaac148 Deliver real authenticated CancelRun through the existing scoped factory and transactional Store CAS, with current stored Function/owner/glob/parent checks before FULL projection or terminal metadata. queued/scheduled/running request cancelling with payload.actor equal to the actual caller key name; winning/losing CAS re-read current state, cancelling/cancelled are idempotent200 and succeeded/failed return400 FAILED_PRECONDITION/RUN_TERMINAL with public metadata.state. D66 preserves current-state resolution,empty patch,null reason,interruptible response work and no premature Job/terminal callback completion. Both independent reviews complete with no confirmed defects; reviewed runtime/tests/SPEC preserved through repair. Fresh65 focused (20 handler,2 native,43 dual-dialect Store),207 exact gateway and9 OpenAPI tests pass. Fresh accepted precommit make check1110 TypeScript/onePython passes; initial unchanged Postgres leasing5000ms deadline and original two-backend control are retained,then complete unchanged recovery passes without universal timing-fix,assertion,deadline or worker changes. Immutable implementation-built nonroot/read-only image revalidated with38 native groups per backend,65 emitted hashes,7 CLI groups;four generated artifacts stable,Helm,frozen install,audit,workflow lint and scan pass. Exact pushed code-head CI https://github.com/xenarro/krun/actions/runs/40251974274 attempt1 passes all9 gates/1110TS+onePython in https://github.com/xenarro/krun/pull/32 against immediate unmerged parent feat/gateway-run-reads/PR31 before only-P3.5 closure. PR32 remains OPEN,not merged;parent PR31 remains OPEN/REVIEW_REQUIRED for protected-main integration. No auto-merge,independent-approval fabrication or protection bypass. Separate documentation tracking requires its own fresh full precommit and exact-head CI. Result reads,listener/process/scheduler assembly and complete Phase3/application-e2e remain later PLAN tasks.

2026-10-26 P3.6 8325f9366d6319c832c9e3f520ffe011de249a20 Deliver authenticated Store-backed GetRunResult: raw inline JSON, terminal/missing-result branches, kept failed/cancelled results and bodyless307 with no-store/fresh literal300-second signing. D67 explicit optional presigner boundary, D68 forward PostgreSQL opaque-result json migration, D69 shared bounded native GET parsing and D70 exact raw Location client-resolution validation preserve current owner/glob/parent privacy and opaque JSON. Both distinct lens-qualified P36-C1 findings are reproduced/resolved;1147 TypeScript+1Python,241gateway,34handler/native and33Unicode/migration controls pass. Rebuilt repair image137 native groups/backend,67module hashes,7CLI,5redirect and3actual previous-image compatibility controls pass;generators/Helm/audit/scan remain green. Source is pushed and accepted at https://github.com/xenarro/krun/actions/runs/40260319575 attempt1,all nine gates;stacked https://github.com/xenarro/krun/pull/33 targets feat/gateway-cancel-run/PR32 and is OPEN,not merged. Only P3.6 is closed after exact source CI;tracking receives separate precommit and hosted verification. P3.7 next from current committed verified feature lineage;concrete ObjectStore/P6.1,serving-process/later Phase3 and complete application end-to-end remain unclaimed.

2026-10-26 P3.7 e0dd5713dc14aaa49ba810de658ad0e985af6dce Deliver the real scoped gateway process: config/logging/telemetry, SQLite/PostgreSQL Store, native Function LIST/WATCH cache, keys and isolated public/internal/admin listeners under NodeRuntime.runMain. Readiness becomes 503 before the single configured grace; public requests stay live, owned admission/waits settle 201 before dependency closure, pure interruption exits 0 and failures exit 1 with a scoped watchdog. D71-D73 cover composition, response settlement and the independently reproduced precommit/drain ownership and internal framework-envelope fixes. Full local and exact hosted code acceptance pass 1158 TypeScript tests and one Python test; gateway phase 252, focused 12, rebuilt hardened-image lifecycle 10 and real PostgreSQL admission 2, 69 module hashes, CLI 7, stable generators/Helm/audit/workflow/scan. https://github.com/xenarro/krun/actions/runs/40270654763 attempt 1 passes all nine gates for this exact code head. Stacked https://github.com/xenarro/krun/pull/34 targets feat/gateway-run-results/PR33 and remains OPEN, not merged; no protection bypass or fake approval. Only P3.7 closes after code acceptance; tracking receives a separate precommit full check and exact-head CI. P3.8 follows from the final committed verified feature lineage; real internal methods, concrete ObjectStore/P6.1, scheduler and complete application e2e remain future acceptance. Tracking verification exposed the unchanged aggregate CLI ceiling test hitting its shared 5000 ms deadline twice;parameterize its four independent subprocess cases with the same default limit and identical assertions. No application/deadline/worker change;current full total becomes 1161 TypeScript plus one Python,while the original exact code-head evidence above remains 1158.

2026-10-26 P3.8 d4d759df93dafba34717610b37dbc76b328e7e0f Deliver GetInput, ReportStatus, SetResult and SetError on the separate internal Fastify listener with per-run constant-time authentication, ordered validation/caps, replica-local accepted-status rate windows, guarded reports and bounded/cancelled native Store work. D74-D75 preserve opaque Unicode reports and mixed-writer heartbeat freshness with forward0004 projection invalidation and atomic publication. Both independent review reports consumed; all four distinct findings reproduced, repaired and permanently regressed: zero-cap chunked framing, incomplete-body/validated-write shutdown, nested nonfinite JSON classification and legacy-writer timestamp freshness. Fresh delivery make check1209TypeScript+onePython and exact297-test gateway phase gate pass, including actual SQLite/Postgres POST/GET; repair66focused/45migration-OpenAPI checks, actual parent-writer3groups and unchanged-runtime rebuilt-image12lifecycle/73module hashes/7CLI/cap controls pass. Double generation, Helm, audit, workflow syntax and critical scan remain green. Exact pushed code-head CI https://github.com/xenarro/krun/actions/runs/40285156613 attempt1 passes all nine gates and1209TS+onePython in stacked https://github.com/xenarro/krun/pull/35 against immediate unmerged parent feat/gateway-process-wiring/PR34. Only P3.8 is closed after accepted code CI; this documentation tracking update requires its own fresh make check and exact-head CI. Phase3 gateway gate passes;source is pushed/green,not merged,with no auto-merge,fake approval or protected-main bypass. P4.1 follows from the final committed verified feature lineage; scheduler/platform kind e2e and concrete ObjectStore/P6.1 remain later acceptance.

2026-10-26 P4.1 d973de8cf6c0884295454fd2bd5536db62bb9314 Deliver pure Result-returning Job/immutable Secret builders matching SPEC7 and D76:deterministic names/four labels,no owner refs,all env/Secret references and exact omission/order,tolerations,UID/GID/defaults,restricted security contexts,tmp volume,deadline/TTL and exact heartbeat seconds. Both independent reviews found no material defect;repair rechecked18builder/19scheduler,50Function prerequisites,11OpenAPI,native SPEC-derived192Job/192Secret oracle and real client loopback serialization. Fresh make check1227TS+onePython before code and reconciliation commits;current-source image74hashes/7builder/7CLI/12gateway groups and scan pass. PRs31-35 merged during delivery;normal reconciliation c2068f3fd2b2b735a95cf7ae9ac8b9be79414527 incorporates main b518d71fc1f6fe76f3f018879ace74de046f327c without altering the reviewed tree. PR https://github.com/xenarro/krun/pull/37 correctly targets main;exact integrated-code CI https://github.com/xenarro/krun/actions/runs/40295121160 attempt1 passed all nine gates/1227TS+onePython. Code PR37 approved and merged outside this delivery job as 031d4268fe0d64a17e9e854c4ae08b477436a993;the separate PLAN/README tracking update requires its own exact-head hosted CI. No auto-merge or review bypass by this job. Scheduler orchestration and whole Phase4 kind/e2e remain later tasks. Next:P4.2 after accepted final tracking CI,from current committed verified lineage;preserve this feature on recovery.

2026-10-26 P4.2 5fb7e60a4a738907df9726cd64d79af84254a443 Deliver scoped Lease election and the native LeaseApiLive boundary per SPEC8 and D77-D78: pod identity, read/replace resourceVersion CAS, 15-second locally observed expiry, 2-second retry, independent 10-second renewal watchdog, leader-only resource cancellation, real gauge/readiness state and bounded owner-checked release. Both independent reviews found no confirmed material defect; repair retained runtime unchanged. Fresh delivery make check1249TypeScript+onePython,41scheduler including22focused tests,4actual host+4immutable-image NodeRuntime/native-client cases and76module hash matches pass; frozen install and double generation remain green. Exact code CI https://github.com/xenarro/krun/actions/runs/40309685305 attempt1 passes all nine gates at this SHA. Stacked https://github.com/xenarro/krun/pull/39 targets immediate unmerged tracking parent feat/scheduler-job-builders/PR38; pushed/green is not merged-main acceptance. Only P4.2 closes after accepted code CI; this PLAN/README tracking update requires its own fresh make check and exact-head CI. No automatic merge or protection bypass. Actual scheduler command wiring, future Job/Pod informer/loop/status-writer implementations, complete Phase4 e2e(P4.12) and two-scheduler kind(P7.6) remain later acceptance. Next:P4.3a from current verified committed lineage after fresh parent/main refresh; preserve this feature on recovery.

2026-10-26 P4.3a 159efaafd1aadbc2d86ae203af5c092c2eb8dcdf Kubernetes API plumbing delivered in PR#40 (https://github.com/xenarro/krun/pull/40) to main after merged parents#39/#38 and ancestry-preserving reconciliation cbe00e1b7cafb22dd8301d61a0196729104fac33. Exact accepted head CI https://github.com/xenarro/krun/actions/runs/40323798272 passes all nine gates (attempt1,1287TypeScript+onePython). Both unique review findings repaired:shared total deadline including queued deadline-tick no-dispatch,and UTC/all-form Retry-After with RFC850 year semantics;42focused/75scheduler/21sharedK8s and native host/image acceptance with79module hashes pass. Pushed/green,not merged;tracking receives its own full precommit check and exact-head CI. Scheduler loop/Store/process wiring,Phase4kind/e2eP4.12/P4.13 and two-schedulerP7.6 remain later tasks.

2026-10-26 P4.3b eb0b27825315350b073c500d1b488daad0170a73 Deliver leader-local count/expiry/capacity/claim scheduling in PR#41 (https://github.com/xenarro/krun/pull/41) against immediate unmerged P4.3a parent feat/scheduler-kubernetes-api/PR40. Both independent findings repaired under D83:successful scheduling retains interruptible cached-replay ownership across deadline settlement;adoption GET errors bypass creation counters/backoff while GET429 retains release-before-pause. Fresh acceptance:26focused/101scheduler;make check1313TypeScript+onePython;10native plus2review-derived groups each on SQLite/PostgreSQL host/image,3replay controls each host/image,and80matching emitted modules. Exact code CI https://github.com/xenarro/krun/actions/runs/40343964037 attempt1 passes all nine gates at this SHA. Pushed/green,not merged or independently approved;only P4.3b closes after accepted codeCI. This PLAN/README tracking update requires its own fresh make check and exact-head hostedCI. P4.3c cancelling,P4.4 informers/terminal handler,P4.5 lostJobs,P4.6 remaining metrics,P4.11 process composition and wholePhase4kind/e2eP4.12/P4.13 remain later acceptance. Next:P4.3c from the final committed verified task lineage after refreshing actual main/parent state;no auto-merge or protection bypass.

2026-10-26 P4.3c 0eeaf7dd9493f2b9ba970b04c66a0a71f0e4ca0f Deliver foreground Job delete, Secret delete and real Store cancelling-to-cancelled CAS in PR#43 (https://github.com/xenarro/krun/pull/43) to main after external parent PR41/PR40 merges and content-preserving normal reconciliation 98dcc124ceacd4eb91b1be8d304df63bb3978807. Both reviews' shared P43C-C1 starvation finding reproduced and repaired under D85: isolate per-run delete/terminal-write failures and retain bounded cursor-page progress across deadlines without reattempting a failed row in the same iteration. Fresh delivery43focused;full make check1330TypeScript+onePython before code and reconciliation commits. Eleven cancellation,ten scheduling andtwo prerequisite-regression native groups pass each host/image andSQLite/PostgreSQL,with80matching runtime modules;native503 isolation,actual OTLP/privacy,429/deadline/CAS ordering,Helm,audit,workflow,image CLI/gateway/critical scan,frozen install andstable double generation pass. Exact reconciled-code CI https://github.com/xenarro/krun/actions/runs/40362250064 passes all nine gates,attempt1,1330TypeScript+onePython. Only P4.3c checkbox closes after code CI;this PLAN/README tracking receives a separate fresh make check and exact-head hostedCI. Pushed/green,not merged;required independent main approval remains,no auto-merge or bypass. Production informer/terminal-handler and scheduler process assembly remainP4.4/P4.11;wholePhase4 makee2e exits2 atP4.12placeholder,kind scenariosP4.13. Native HTTP boundary is simulated,not Kubernetes admission or actual Jobexecution.

2026-10-26 P4.4 29d2d6de3485c3e7c0f3807253d74c3eb6498d23 Deliver leader-scoped native Job/Pod informers and cache-backed terminal handling in PR#44 (https://github.com/xenarro/krun/pull/44) against main after parent PR43 merged and content-preserving normal reconciliation 7da86a66975cf0bf105394ead963efb25ee3fa4f. D86 uses the installed public ListWatch/Watch extension points for processed-LIST sync, shared bounded acquisitions, leader-scoped bodies and reconnect backoff. D87 atomically preserves inline-result precedence in the existing Store CAS. Both independent reviews' three distinct findings reproduced/repaired under D88: compact terminal deletion debt survives queued gating, failures and interruption until disposition; normative Job startTime fallback and cancelling status-only updates are restored. Fresh87focused/160scheduler;make check1374TypeScript+onePython before source/reconciliation commits;16native-client/informer/real-Store groups each host/image andSQLite/PostgreSQL with82matching runtime modules;container smoke,Helm,workflow,audit,critical scan andstable double generation pass. Exact reconciled-code CI https://github.com/xenarro/krun/actions/runs/40386333038 attempt1 passes all nine gates and1374TypeScript+onePython. Only P4.4 closes after accepted code CI;this PLAN/README tracking receives its own fresh full check and exact-head hosted CI. Source PR44 was merged externally as 0207e8f6da77ab0740ae28c6aec93409d1a77bef;this job did not merge it. PLAN/README tracking is delivered separately with its own exact-head hosted acceptance;no auto-merge or protection bypass. Production process assembly P4.11,actual S3 adapter P6.2 andwholePhase4e2e/kind P4.12/P4.13 remain later acceptance;makee2e exits2 at its documented placeholder. Loopback Kubernetes server and controlled object-check provider are component boundaries,not Kubernetes admission/Job execution or actual S3. Next:P4.5 from current verified committed task lineage after refreshing actual main/parent;known terminal debt must precede absence/lost classification.

2026-10-27 P4.5 b14c9488e7fbf13fb2c9084e1b1d89156d633833 Deliver cache-backed main-loop step6 and initial/five-minute job_lost detection in PR#46 (https://github.com/xenarro/krun/pull/46) to main after normal reconciliation 955c08fa04b1574a5c1ae26188061f238d7a8fe2. D89 retains leader-local first-absent grace and retry-only Secret cleanup ownership after settled CAS, with bounded cursor/debt progress. D90 repairs both independent reviews' shared P45-C1 ingress race: native pending generations fence only their run before queued consumption; safe exact acknowledgement cannot erase newer observations and terminal handoff survives failed reads and long backlog. Fresh108focused/183scheduler;make check1397TypeScript+onePython before source and reconciliation commits;28native-client/informer/real-Store groups per host/image andSQLite/PostgreSQL with82matching baked runtime modules;independent native queue assertions,container smoke,Helm,workflow,audit,critical scan,frozen install andstable double generation pass. Exact source-head CI https://github.com/xenarro/krun/actions/runs/40410837737 attempt1 passes all nine gates and1397TypeScript+onePython. Source PR46 was approved and merged externally as b20a73ba3d9ed05955db5137b9f2376e688b2c21;this job did not merge it. Only P4.5 closes after accepted code CI;this PLAN/README-only tracking receives a separate fresh make check and exact-head hosted acceptance on a follow-up PR,without auto-merge or protection bypass. Production scheduler compositionP4.11,actualS3P6.2 andwholePhase4e2e/kindP4.12/P4.13 remain later acceptance;makee2e exits2 at documented placeholder. Native loopback acceptance is not Kubernetes admission or actual Jobexecution. Next:P4.6 from current verified lineage after refreshing actual main/parent.

2026-10-27 P4.6 4ee85c97d9193e86fbca6b0493608a4e00526332 Deliver leader-owned lifecycle metrics and native HTTP request tracing in PR#48 (https://github.com/xenarro/krun/pull/48), based on verified main fa03d9314b2125be38ede49c8ca54a4341c9a8d0. D91 observes exact committed Store rows and publishes countByState gauges; D92 supplies incoming traceparent parenting, request-runner context and per-run correlation without cross-process trace persistence. Both independent reviews consumed; sole material contracts finding P46-C1 reproduced and repaired under D93: validate selected UUIDv7 identity before span attachment, omit invalid values without normalization or fallback. Fresh full make check1405TypeScript+onePython including183scheduler; four native host/image xSQLite/PostgreSQL lifecycle and HTTP401 identity variants pass with84matching runtime modules. Rebuilt nonroot/read-only image, adversarial probes, smoke, critical scan, Helm, workflow, production audit, frozen install and stable double generation pass. Exact source-head CI https://github.com/xenarro/krun/actions/runs/40423366076 attempt1 passes all nine gates and1405TypeScript+onePython. Source PR48 independently approved/merged externally as 2bc7cd6c7e94a27f3b291aafc279ffea6fe81d71; this job did not merge it. Squash ancestry reconciled through a content-preserving normal merge. Only P4.6 closes after accepted source CI; this PLAN/README-only tracking receives a separate fresh make check and exact-head hosted CI on a follow-up PR. Production scheduler assemblyP4.11, actualS3P6.2 and whole-phase e2e/kindP4.12/P4.13 remain later acceptance; make e2e actually exits2 at its documented placeholder. Native loopback acceptance does not prove Kubernetes admission or actual Jobexecution. Next:P4.7 from current verified committed lineage after refreshing actual main/parent; preserve this feature on recovery, no auto-merge or protection bypass.

2026-10-27 P4.7 1947b20a05913bed370934e92e05314e199c3002 Deliver the leader-scoped Function Ready/observedGeneration writer in PR#51 (https://github.com/xenarro/krun/pull/51) against the recorded unmerged feat/scheduler-run-metrics parent PR#50. D94 uses existing P2.2 validation, a separate complete-cache capability with bounded replay-one invalidations, explicit native JSON Merge Patch, UID/resourceVersion fencing, exact-input acknowledgement and real-status drift repair. Both independent reviews report no confirmed scoped defect; repair and delivery preserve the reviewed runtime. Fresh precommit make check passes 1,420 TypeScript tests plus one Python test, including 198 scheduler tests. All 15 permanent status-writer controls and four additional reviewer race/lifecycle controls pass. Original six-group, contracts seven-group and correctness four-group native probes pass each host and rebuilt nonroot/read-only image with all 85 runtime module hashes matching; counts overlap. Image smoke/security, Helm, workflow, production audit, frozen offline install and two identical generations pass. Exact source-head CI https://github.com/xenarro/krun/actions/runs/40433248388 attempt 1 passes all nine gates and 1,420 TypeScript tests plus one Python test. Only P4.7 closes after accepted source CI; this PLAN/README-only tracking receives a separate fresh make check and exact-head hosted CI. PR50 main approval and PR51 integration remain pending at source acceptance; no automatic merge or protection bypass. Production scheduler composition remains P4.11, and whole-phase make e2e actually exits 2 pending P4.12/P4.13, not a passing kind/admission gate. Next: P4.8 failure detection from current verified committed lineage after refreshing actual main/parent; preserve this feature on recovery.
2026-10-27 P4.8 50a66d1aba801a421d6c89b20101c8771a9766c9 Deliver D95 failure detection and committed-only metrics in PR#52 (https://github.com/xenarro/krun/pull/52) against current main. Preserve the first bounded function-container tail and known exit time, UTF-8-safe 16 KiB cap, native/shared ten-second abort and job_lost retention. Resolve both distinct peer P48-C1 findings: correctness excludes early captured tails from successful stored/FULL results; contracts retains token-bearing queued diagnostics before markScheduled without queued jobStatus/lifecycle publication. Fresh make check passes 1,451 TypeScript tests plus one Python test, including 227 scheduler tests and 35 focused controls; 23 targeted and six native HTTP controls pass. Eight compiled native-client/informer/real-Store groups pass across host/image SQLite/PostgreSQL with all 85 runtime hashes matching the rebuilt hardened nonroot image; four independent adversarial groups pass host/image. Source exact-head CI https://github.com/xenarro/krun/actions/runs/40444940823 passes all nine gates and the same full counts. PR51 then PR50 integrated externally during preflight; PR52 independently approved/merged externally as c83f09a49c422d8b1d4f9d05d517d67ba4f2b61e; this job did not merge them. Normal ancestry reconciliation preserves the committed verified task lineage without force-push. Only P4.8 closes after source acceptance; this PLAN/README-only tracking receives a separate fresh make check and exact-head hosted CI in a follow-up PR. Production scheduler assembly remains P4.11 and actual kind/admission/e2e remains P4.12/P4.13; make e2e actually exits 2 at its explicit placeholder, not a phase pass. Next: P4.9 from current verified committed lineage after refreshing main and pending parents; preserve this feature on recovery and do not bypass required review.
2026-10-27 P4.12 458a651e7fd74bcb7a2b5e6c0d80300a4110792d Deliver the D99 pinned kind foundation in PR#57 (https://github.com/xenarro/krun/pull/57) against main from merged/approved P4.11 lineage. Pin kind0.33.0 and node/registry digests,configure the local registry recipe,deploy the real embedded gateway/scheduler with generated CRD and restricted jobs namespace,then prove current Function/API readiness and real open/deny/reopen network enforcement before the zero-scenario runner. Real Kubernetes exposed a Lease MicroTime serialization prerequisite;both native write paths are repaired with failing-first regressions. Independent correctness/contracts reviews plus repair resolve private-kubeconfig teardown isolation and the unresolvable kind-action pin;actual hosted installer/cluster gates now pass. Fresh local make check passes1552TypeScript+onePython,real make e2e/native teardown preserves matching selected ambient configuration,and88 runtime module hashes match the rebuilt image. Exact source CI https://github.com/xenarro/krun/actions/runs/40502110628 passes verify and kind,including the same full test counts,five hardened-image process cases and owned cleanup. Retain the initial unchanged Store5000ms timeout:all42file cases and the subsequent unchanged-budget full gate pass;no historical cause is claimed. PR57 was OPEN/REVIEW_REQUIRED at source acceptance,then became APPROVED/MERGED at d5656054b846c9135baebca4ed478542f1e6ac5c while tracking checks ran;delivery did not enable auto-merge or bypass protections. The already-pushed tracking head234182d had no PR-triggered run because PR57 was closed;preserve this feature and normally reconcile the content-identical squash merge for a follow-up tracking PR against main. Only P4.12 closes after source acceptance;this PLAN/README-only tracking gets fresh make check and its own exact-head CI. P4.13 behavioural Run/admission/lifecycle scenarios and the complete Phase4 gate remain open. Next:P4.13 from the final committed verified feature lineage after refreshing the follow-up tracking PR/main state;an unmerged tracking PR remains its immediate parent/base. Preserve this feature on recovery,not obsolete main.

2026-10-27 P4.9 353462feaa844f5a3c5b03722eb308009b295f2c Deliver the leader-scoped ten-second heartbeat component under D96 in PR#54 (https://github.com/xenarro/krun/pull/54) against main after normal ancestry reconciliation of merged parent PR53. Both initial Job/Pod LISTs and Function-cache synchronization gate work; current validated same-UID Function policy and Store freshness authorize each first foreground DELETE. Preserve bounded logs, running-only heartbeat_timeout CAS, atomic BASIC privacy and retry-only post-delete CAS/Secret ownership. Both independent reviews are resolved by thirteen permanent policy/exporter regressions. Fresh make check passes 1,494 TypeScript tests plus one Python test, including 265 scheduler tests; 43 focused controls pass. Sixteen compiled native-client/informer/real-Store groups pass on host/image with SQLite/PostgreSQL and 86 matching runtime module hashes; seven independent policy/trace groups pass. Exact source-head CI https://github.com/xenarro/krun/actions/runs/40454569909 passes all nine gates and the same full counts. Source PR54 is OPEN/REVIEW_REQUIRED at code acceptance; required main approval remains and this job does not auto-merge or bypass protections. Only P4.9 closes after source acceptance; this PLAN/README-only tracking receives a separate fresh make check and exact-head hosted CI. Production scheduler assembly remains P4.11 and actual kind/admission/e2e remains P4.12/P4.13; make e2e actually exits 2 at its documented placeholder. Next: P4.10 from current verified committed task lineage after refreshing main and pending parents; preserve this feature on recovery.

2026-10-27 P4.10 e9e5091249cff2344a7288afd753c27156b5599b Deliver the D97 leader-scoped immediate/ten-minute retention sweep in PR#55 (https://github.com/xenarro/krun/pull/55) against main after content-preserving normal reconciliation of merged/approved parent PR54. Freeze one Effect-clock cutoff,drain existing Store.sweep in1000-row batches,publish committed-only run counts,and safely page old orphan Secrets with current/pending Job guards and UID/resourceVersion preconditions. Both independent reviews report no confirmed defect;repair closed the qualified contracts verification gaps,including four corrected permit/age/pagination controls,without product changes. Fresh make check1522TypeScript+onePython,282scheduler and20focused;all eight compiled native-client/informer/real-Store groups pass each host/image xSQLite/PostgreSQL with87matching runtime modules;six independent adversarial groups pass. Exact source CI https://github.com/xenarro/krun/actions/runs/40465434121 passes all nine gates and the same full counts. PR55 is OPEN/REVIEW_REQUIRED at source acceptance,pushed/green but not merged;no auto-merge or protection bypass. Only P4.10 closes after accepted source CI;this PLAN/README-only tracking requires its own fresh make check and exact-head hosted CI. Production scheduler assembly remainsP4.11 and whole-phase kind/admission/e2e remainsP4.12/P4.13;make e2e remains the explicit exit2 placeholder,not a phase pass. Next:P4.11 from current verified committed lineage after refreshing main/pending parent;preserve this feature on recovery.

2026-10-27 P4.11 9d2dfe4797b15450c31450f1c9945a5b153abc98 Deliver the D98 real scoped scheduler process in PR#56 (https://github.com/xenarro/krun/pull/56) against main after content-preserving normal ancestry reconciliation of merged/approved parent PR55. Wire Config/Telemetry/Database/Store, one bounded Kubernetes connection, process-wide Function cache/admin and existing Lease election with leader-only controller/main/heartbeat/sweep/status components. Require downward-API KRUN_POD_NAME, gate claiming on all initial LISTs, keep standby ready, propagate leader loss and stop Function/leader watches before releasing the owned Lease. Both independent reviews report no confirmed scoped defect; verification-only repair closes qualified gaps without product changes. Fresh precommit make check passes 1,541 TypeScript tests plus one Python test; five image process cases and PostgreSQL standby/completion on host and image pass with 88 matching runtime hashes. Exact source CI https://github.com/xenarro/krun/actions/runs/40482390594 passes all nine gates, the same full counts and hardened-image serving acceptance. PR56 is OPEN/REVIEW_REQUIRED at source acceptance: pushed/green, not merged; no auto-merge or protection bypass. Only P4.11 closes after accepted source CI; this PLAN/README-only tracking receives its own fresh make check and exact-head hosted CI. Actual kind/admission/Job execution and the whole-phase gate remain P4.12/P4.13; make e2e retains its explicit exit2 placeholder. Configured object-store wiring remains P6.2 and webhook delivery P5.3. Next: P4.12 from current verified committed lineage after refreshing main/pending parent; preserve this feature on recovery.

2026-10-27 P4.13 2f8f5e2be90eb45b193e78fc3cab517542212f5b Deliver the D100 Phase 4 native-kind gate in PR #59 (https://github.com/xenarro/krun/pull/59) against main from the verified, merged P4.12 lineage. Five actual curl/missing-image workloads prove the input/status/result round-trip, exit 1 and two-status exit 3 projection within ten seconds, the native 60-second image-pull deadline, and 30-second heartbeat expiry with positively observed Job deletion within sixty seconds. Fresh local exit 1/exit 3 detection took 4476/4252 ms; heartbeat failure plus Job removal took 35743 ms. Anchored native Pod/Secret watches retain fast events and identity-fenced Run credentials privately. Independent correctness finding P413-C1 was reproduced and repaired so the privacy oracle rejects actual-token leakage. Both independent reviews and scoped repair are complete. Historical Store/namespace verification failures remain qualified; their causes are not invented. Fresh delivery make check passes 1,567 TypeScript tests plus one Python test. Five actual credential/privacy witnesses, 88 matching rebuilt runtime module hashes, image process/identity/critical-scan controls, audit, stable generators, Helm/workflow checks and owned cleanup pass. Exact source CI https://github.com/xenarro/krun/actions/runs/40523418351 passes verify and kind with the same test counts, all five real scenarios, the pinned installer and owned cleanup. PR #59 was OPEN/REVIEW_REQUIRED at source acceptance: pushed and green, not merged; no auto-merge or protection bypass. Close only P4.13 after accepted source CI. This tracking and phase-end documentation receive fresh make check and their own exact-head hosted verify/kind checks. The current Phase 4 gate is accepted; later SSE/webhook, object-store, chart/admission, capacity, production and release gates are not claimed. Next: P5.1 from fresh verified origin/main if PR #59 has merged; otherwise use an actually dependent child of this verified feature and record pending PR #59 explicitly. Preserve this branch on recovery and reconcile main normally without force-push or history rewriting.

2026-10-27 P5.1 f211ba0efce75afdf7cf86c1e54045bec23c3a91 Deliver D101 shared gateway Run waits in PR #60 (https://github.com/xenarro/krun/pull/60) against main from merged P4.13. One scoped Store consumer fans id-only hints into per-request sliding queues registered before insert/read; authoritative reads and the mandatory one-second fallback retain CreateRun 201 and WaitRun 200 at terminal state, capped/default timeout or graceful shutdown. Stored function/owner authorization is rechecked on every WaitRun read, including wildcard/deleted-Function history. Both independent reviews have no confirmed material finding; exclusive integration verification preserves all eight reviewed paths. Fresh delivery make check passes 1,584 TypeScript tests plus one Python test, including 314 gateway tests and 17 new handler controls. Native/image timeout and simultaneous-wait SIGTERM, five actual kind regression scenarios with credential witnesses and 88 matching runtime modules pass. Exact source CI https://github.com/xenarro/krun/actions/runs/40537869519 passes verify/kind, including the same full counts, current-source image build/process/security gates, the five existing scenarios and owned cleanup. Preserve the initial reviewer scheduler standby ten-second observation timeout: unchanged-image rechecks pass all five process cases and its historical cause remains unproven. PR #60 was independently APPROVED/MERGED externally as 8d9d59015f75028f83112feb62001feeccedb69e while source CI ran; this job did not merge or bypass protection. Normal content-preserving squash-ancestry reconciliation retains this verified feature as first parent. Only P5.1 closes after accepted source CI; this PLAN/README-only tracking receives its own fresh make check and exact-head hosted acceptance in a follow-up PR. The complete Phase 5 kind wait/signed-webhook gate remains P5.4; SSE/webhooks, object storage,production and release acceptance are not claimed. Next: P5.2 from fresh verified main if final tracking is merged, otherwise an explicitly dependent child of the verified tracking feature; preserve this feature on recovery.

2026-10-27 P5.2 f359516231090722ca63de613514b8f6dae26faf Deliver D102/D103 WatchRun SSE in PR #62 (https://github.com/xenarro/krun/pull/62), opened against the then-unmerged P5.1 tracking parent PR #61. Reuse the gateway's single scoped Store notification consumer and per-Run hint queues, registering before the first authorized read. The initial BASIC state, terminal-at-connect EOF, later state/status/job_status groups with their own timestamp IDs, one-second authoritative fallback, independent fifteen-second keepalive, per-read owner/function authorization and native SIGTERM closure pass. FULL-only fields never enter SSE; Last-Event-ID is ignored and reconnect starts with the current snapshot. Both independent reviews and exclusive repair are complete. P52-C1 was reproduced on ordinary readers and the prior image against real SQLite, then repaired with serialized native drain waits, a two-second stalled-reader bound and shutdown cancellation covering the initial write. Twenty-four permanent WatchRun cases, 107 focused checks, thirteen replayed independent reviewer controls, nineteen rebuilt-image gateway groups and 89 exact runtime modules pass. Preserve failed first source CI https://github.com/xenarro/krun/actions/runs/40554302541: a pre-existing CLI test aggregated four native launches under one five-second test deadline. Corrective commit f359516231090722ca63de613514b8f6dae26faf separates the four scenarios with identical assertions and unchanged per-scenario/default/native deadlines; no runtime, worker or policy change. Fresh corrected delivery make check passes 1,611 TypeScript tests plus one Python test, including 338 gateway tests; three additional assertion-equivalent CLI cases do not represent new product coverage. Exact corrected-source CI https://github.com/xenarro/krun/actions/runs/40556676305 passes verify/kind with the same full counts, current-source image/process/security gates, all five actual Phase 4 native regression scenarios with credential/privacy witnesses, pinned tools and owned cleanup. Original reviewer deadlines remain preserved with their historical causes unproven. At source-acceptance readback PR #62 was externally merged into its parent and PR #61 was independently APPROVED/MERGED to main as 9f311a312c3d49c632209a9062e2ef1f64567fcb; a fresh diff proves main's tree equals the accepted source. This job did not merge or bypass protection. Normal non-destructive ancestry reconciliation retains the verified source as first parent. Close only P5.2 after accepted source CI; this PLAN/README-only tracking receives fresh make check and its own exact-head hosted checks in a follow-up PR against main. The complete Phase 5 native wait/signed-webhook gate remains P5.4; webhook delivery, production and release acceptance are not claimed. Next: P5.3 from fresh verified main when no real unmerged functional dependency requires a recorded child lineage.

2026-10-27 P5.3 8cab0062b82081bb5384b78d0cd47680b610273a Deliver D104/D105 signed durable webhook dispatch in PR #64 (https://github.com/xenarro/krun/pull/64) against main. Claim 40 due rows, await at most eight pinned sends, re-claim full batches immediately, apply fixed retries/dead after six failures and accept only 2xx. Fresh per-attempt rotation HMAC and traceparent use stored BASIC bytes. Independent correctness findings P53-C1/C2 are reproduced and fixed with pending/attempt/lease CAS and applied-only counters; the contracts review has no material finding. Fresh precommit make check passes 1,640 TypeScript tests plus one Python test; 19 delivery controls, 59 SQLite/PostgreSQL maintenance contracts, 388 area tests and eight reviewer controls pass. Rebuilt image passes 19 gateway/nine scheduler/seven CLI groups, 90 matching modules plus launcher, identity and critical scan. Exact source CI https://github.com/xenarro/krun/actions/runs/40574895994 passes verify/kind, including the same counts, image/security gates and five actual credential witnesses. Preserve the historical unchanged PostgreSQL claim deadline; complete reruns pass without relaxed budgets and its original cause remains unproven. PR #64 and prior PR #63 were independently APPROVED/MERGED externally; this job did not merge or bypass protection. Reconcile current main 6799afde9789a773a6cfb015afadb96f4787366e as a genuine second parent; remove the identical P5.3 README section duplicated by documentation reconciliation. Only P5.3 is newly closed by this tracking edit; prior P5.2 tracking comes from integrated main. This PLAN/README-only follow-up receives fresh make check and exact-head CI in a new PR against main. Full Phase 5 kind wait/in-cluster signed-webhook acceptance remains P5.4, which is next. No production or publication acceptance is claimed.

2026-10-28 P5.4 94317d6a0e4b0f637a8ea549d4c43644d22bbda3 Deliver native wait and signed-webhook acceptance in PR #66 (https://github.com/xenarro/krun/pull/66) against main. CreateRun with wait returns 201, SUCCEEDED, inline result and FULL input; WaitRun returns 200 with the identical FULL Run. The restricted in-cluster receiver verifies the actual persistent 500→200 retry, stable delivery ID and raw BASIC bytes, both rotation signatures and fresh attempt timestamp/trace. All seven scenarios, seven actual credential/privacy witnesses, CIDR allowlisting, mandatory NetworkPolicy enforcement and owned cleanup pass. Both source reviews have no confirmed material finding; incomplete reviewer runs remain qualified by complete integration reruns. The mixed-Vitest local shim defect was repaired through a frozen offline relink without source, dependency, policy or budget changes. Fresh delivery make check passes 1,654 TypeScript tests and one Python test. Exact source CI https://github.com/xenarro/krun/actions/runs/40593392023 passes verify and kind, generators, image smokes/identity, Helm lint, audit and fixable-critical scan. Only P5.4 is newly checked. This PLAN/README tracking update receives a separate fresh precommit make check and exact-head hosted CI. Required independent repository approval remains pending; pushed/green is not merged, and no auto-merge or protection bypass is enabled. Next task: P6.1 from the current committed verified lineage after refreshing parent/main state. Object-storage, SDK runtime and production/chart acceptance remain incomplete.

2026-10-28 P6.1 fb4228a6f984c50536a501e8ae96476ff96da960 Deliver D106 scoped ObjectStore S3 signing in PR #67 (https://github.com/xenarro/krun/pull/67) against the immediate unmerged P5.4 parent feat/wait-webhook-e2e/PR #66. PUT uses explicit whole-second TTL and host-only signing without Content-Type, checksum or size constraints; an application/json upload succeeds against genuine MinIO. Fixed 300-second GET returns identical bytes, canonical Run refs fail closed, and object absence requires an accessible bucket. Effect-clock dates, ten-second bounds, HEAD cancellation, scoped client cleanup and privacy-safe errors pass. Both independent reviews have no material finding; repair changes README only and replays nine HTTP and two MinIO controls. Checksum-enforced genuine release binaries and a digest-pinned nonroot base resolve vendor image access without fake S3 responses or policy overrides. Fresh precommit make check passes 1,677 TypeScript tests plus one Python test, including 23 adapter controls. Exact source CI https://github.com/xenarro/krun/actions/runs/40605426490 passes verify/kind, real MinIO tests, generators, rebuilt-image smokes/identity/security, Helm, audit, seven native scenarios and seven privacy oracles covering eight actual Run credential contexts. The exit_code_status scenario passes on its existing configured retry; its first-attempt cause is unestablished and retry/deadline policy is unchanged. The private collector initially assumed exactly one Run per scenario; it now checks positive witnessed counts and records actual totals, retaining the rejected collector receipt. Preserve also the historical reviewer scheduler shutdown failure: unchanged fresh-image full smoke and three repeats pass with no relaxed deadline. Only P6.1 is newly checked; this PLAN/README tracking receives fresh make check and exact-head hosted CI. No auto-merge or protection bypass; pushed/green is not merged and parent PR #66 remains a pending-main dependency. P6.2 process/config/TTL/resultUri wiring and the P6.3 complete kind large-result/public 307/expiry gate remain future work. No complete Phase 6, production or publication claim. Next: P6.2 from the current committed verified lineage after refreshing parent/main.

2026-10-28 P6.2 2853ac37b510dc8cb317d354455b4cc9aff6c61a Deliver D107/D108 optional scoped result-storage runtime wiring in PR #68 (https://github.com/xenarro/krun/pull/68) against the immediate unmerged P6.1 parent feat/object-store-presigning/PR #67. The actual Job gets KRUN_RESULT_UPLOAD_URL with the configured ceil-rounded TTL or Function deadline;unsafe installation defaults require an explicit representable TTL without clamping. Typed signing failures release only their claim and do not skip unrelated scheduling,cancellation or loss checks. Complete/no-inline checks HEAD before CAS and atomically publishes resultUri in deliveries;inline false/zero/empty values and cancellation retain precedence. Scoped bounded cross-Run dispatch coalesces hot-Run events without dropping compact terminal deletion or newest ingress-generation evidence. Both independent medium findings are reproduced and resolved;all 146 focused cases and 31 new permanent task tests pass. Fresh delivery make check passes 1,708 TypeScript tests and one Python test. Source-rebuilt image passes 93 runtime-module hashes plus launcher,scheduler 13/gateway 19/CLI 7,identity and fixable-critical scan. Exact source CI https://github.com/xenarro/krun/actions/runs/40619376457 passes verify/kind,locked install,generators,image smokes,Helm,audit,seven native scenarios and seven privacy oracles covering 7 actual Run credential contexts. Earlier failed bootstrap/test-observation receipts and the local unchanged-policy native retry remain qualified,not erased. Only P6.2 is newly checked;this PLAN/README tracking receives its own fresh precommit make check and exact-head hosted CI. No auto-merge or protection bypass;pushed/green is not merged and PRs #67/#66 remain pending-main dependencies. P6.3 still owns genuine MinIO-in-kind 1 MB/resultUri/public307/object-read and jobs-namespace-egress phase acceptance.

2026-10-28 P6.3 55df49060ba20a683ec0d71eff77f80170a2a608 Deliver D109/D110/D111 genuine MinIO-in-kind large-result acceptance in PR #69 (https://github.com/xenarro/krun/pull/69) against immediate unmerged parent feat/object-store-runtime/PR #68. A real isolated Node26 Function uploads exactly1,048,576 UTF-8 JSON bytes through its per-Run PUT capability;the persisted Run has canonical resultUri and no inline result. Authenticated GetRunResult is bodyless,no-store307 with a300-second GET;an independent client never forwards krun API authorization and checks exact raw bytes/SHA256,while unsigned object access is403. Raw jobs egress selects only the MinIO namespace/server Pods on TCP9000,retains default deny and enforced-policy probe,and passes native deny/backend-healthy/exact-restore controls. Both independent reviews and repair are complete:P63-C1 private-query masking and repeated bucket409 are reproduced and fixed with closed capability validation,known-private scans and HEAD/404-only initialization. Fresh delivery make check passes1,733 TypeScript tests plus one Python test;45 focused controls,both six-control reviewer replays,generators twice,Helm,audit and actionlint pass. Rebuilt deployed image matches93 runtime modules plus launcher and passes scheduler13/gateway19/CLI7,identity and critical scan. Exact source CI https://github.com/xenarro/krun/actions/runs/40634100991 passes verify/kind and full native eight-scenario/eight-privacy-oracle acceptance over8 actual Run credential contexts. Preserve earlier setup,cleanup,reviewer interruption and installed-module-state failures with their explicit qualifications;no budgets/retry policy relaxed or speculative causes claimed. Only P6.3 is newly checked. This PLAN/README-only tracking update receives fresh precommit make check and exact-head hosted CI. Pushed/green is not merged;no auto-merge or protection bypass,with PRs #68/#67/#66 pending-main dependencies. Phase6 local/hosted acceptance is established;P7.1 production chart work is next,SDK/runtime/release acceptance remains later.

2026-10-28 P7.1 63adbabfb65345d9e93a0fe96f129ec6d3d3584f Deliver D112/D113 common Helm chart foundation in PR #70 (https://github.com/xenarro/krun/pull/70) against immediate still-unmerged parent feat/object-store-e2e/PR #69. Values match SPEC section13 verbatim;generated CRD install/keep bytes and controls remain intact. Public/internal-only Services,mode-appropriate ServiceAccounts,conditional gateway PDB and concrete baseline Postgres Deployments exercise reusable secure labels/selectors/images/env/probes/resources/topology/grace/rolling-update helpers. API-key reference fails clearly and mounts a read-only directory without subPath;renders contain no Secret,ConfigMap or Function. Both independent P71-C1 findings are reproduced and resolved through a dedicated DNS-label-safe public-Service name without changing workload/selector identity or the fixed internal endpoint,including a normalization-created collision regression. All36 foundation/62 focused controls,seven independent replays and64 real-Helm combinations pass. Actual native API controls create/read back16 separate Services across8 both-mode naming cases after reproducing old dot/duplicate rejection. Preserve the two failed native cleanup wrappers;exact owned exited-node readback and identical normal kind-delete retries succeed,and the resumed verifier rechecks actual API receipts and final cleanup without weakening policy or inventing a daemon cause. Fresh precommit make check passes1769 TypeScript tests plus one Python. Exact source CI https://github.com/xenarro/krun/actions/runs/40642433372 passes verify/kind,locked install,generators,new image smokes/identity/security,Helm,audit and the unchanged raw-manifest native8-scenario/8-privacy-oracle suite over9 actual Run credential contexts;existing retry policy is unchanged and no no-retry claim is made. Only P7.1 is newly checked. This PLAN/README-only tracking update receives fresh make check and its own exact-head hosted CI. Pushed/green is not merged;no auto-merge or protection bypass,with PRs #69/#68/#67/#66 pending-main dependencies. This is not an install-ready full chart or Phase7 gate:Postgres hooks/P7.2,embedded lifecycle/P7.3,security/options/P7.4,generated docs/P7.5,chart-installed two-mode native gate/P7.6 and monitoring/P7.7 remain required. Next:P7.2 from the current committed verified lineage after refreshing parent/main state.

2026-10-28 P7.2 cfda0f4b93e312afda4e4f05a4f876a176d980d1 Deliver D114 Postgres migration hooks in PR #72 (https://github.com/xenarro/krun/pull/72) against main after prerequisite PR#70 independently merged/approved. A normal two-parent source commit reconciles the byte-identical committed main/feature trees without rebase,force-push or loss of the reviewed six-path implementation. Keep the two concrete serving Deployments and exact admin probes;add a one-shot migrate Job at weight0 and dedicated ServiceAccount at weight-5,pre-install/pre-upgrade,before-hook-creation/hook-succeeded,bounded backoff1/deadline240/Never,existing Secret reference and shared restricted helpers,without token/RBAC/API-key mounts or probes to a nonexistent Job listener. Both independent reviews have no scoped material product finding;repair changes no product source. Fresh standard and exact taskset14,15 complete checks each pass1782 TypeScript+onePython,and exact scheduler replay passes333 cases without altered timeouts/workers/retries/skips. Historical5s/20s reviewer failures remain retained;their original cause is unestablished. All75 focused controls,12 independent controls,both lint modes and generators twice pass. Fresh genuine PSA-restricted Helm4.3 initial bad-auth install gates serving Deployments and retains the failed Job;Helm correctly deletes the earlier succeeded hook ServiceAccount,and actual failed Pods have no projected token. Recovery,idempotent upgrade,bad-upgrade retention/recovery and uninstall pass with3 actual successful migrate executions and4 source-matched Postgres migrations;owned resources/private inputs are removed. The unchanged runtime matches93 modules+launcher. Fresh delivery make check passes1782 TypeScript+onePython. Exact source CI https://github.com/xenarro/krun/actions/runs/40721426046 passes verify/kind,locked install,generators,image smokes/identity/security,Helm,audit and all8 existing raw-manifest native scenarios/privacy oracles over9 actual Run credential contexts;existing retry policy is unchanged and no no-retry claim is made. Only P7.2 is newly checked after accepted code CI. This PLAN/README-only tracking update receives a fresh precommit make check and exact-final hosted CI. Pushed/green is not merged;no auto-merge/protection bypass. Zero-serving-replica hook lifecycle is not full Phase7 serving/two-mode/RBAC/network/admission/upgrade/rollback/data-plane acceptance. Next P7.3 embedded lifecycle,then remaining Phase7 tasks and full gate. No publication or production write.

2026-10-28 P7.3 c6ede61f7e227feb408fcb759d9ccc1adc251aab Deliver D115 embedded StatefulSet lifecycle in PR #73 (https://github.com/xenarro/krun/pull/73), based on immediate unmerged prerequisite feat/helm-postgres-hooks/PR #72. One gateway/scheduler StatefulSet shares a local RWO PVC with fsGroup 65532 and OnRootMismatch; its distinct bounded DNS-label-safe headless Service has no ports and is serviceName. Preserve separate admin 9090/admin-sched 9091 probes, resources and quoted config, nonempty-only storageClassName and required replica/image/Secret failures. Init order is real Litestream restore, native sidecar with Always restart, then real migrate; remove only orphan WAL/SHM with absent DB and pass URL as data. Explicit rotating API access mounts only into apps, API keys only into gateway, and named backup Secret keys only into Litestream. Both independent reviews report no material product defect; repair preserves all eight implementation paths and qualifies the earlier namespace rationale: mounted ServiceAccount namespace fallback already works, so explicit Release.Namespace is valid but absence of env alone is not a proven prior Postgres defect. All 24 embedded/99 combined controls, 12 independent controls, six mock shell-boundary controls, two namespace counterfactuals, strict replay types, both lint modes and generators twice pass. Genuine restricted Helm StatefulSet verification starts both real processes Ready with scheduler leadership, two SQLite migrations and shared PVC; a committed witness survives actual file-replica restore after DB deletion/orphan WAL-SHM, plus real serving upgrades disabling and re-enabling Litestream. Init/sidecar have no API token; apps use projected access. Uninstall retains the PVC, then owned fixture cleanup removes it, cluster, aliases and private inputs. Runtime matches 93 modules plus launcher without application/dependency changes. Original fixture/import/host-UID/S3 hypothesis failures are retained and qualified, not product defects; credential protocol controls are not real S3 authentication/durability acceptance. Fresh delivery make check passes 1,806 TypeScript tests plus one Python. Exact source CI https://github.com/xenarro/krun/actions/runs/40733378478 passes verify/kind, generators, actual image smokes/identity/security, Helm/audit and all eight existing raw-manifest native scenarios/privacy oracles over 9 actual Run credential contexts under unchanged retry policy; no no-retry claim. Only P7.3 is newly checked after source CI. This PLAN/README-only tracking update receives fresh make check and exact-final hosted CI. Pushed/green is not merged; parent PR #72 remains OPEN/REVIEW_REQUIRED, with no auto-merge or protection bypass. Full Phase7 chart-owned RBAC/network/admission/two-mode rollback/Run-data-plane and S3 production backup acceptance remain future gates. Next P7.4a namespace/security resources, then remaining Phase7 tasks. No publication or production write.

2026-10-28 P7.4a 2106479253344dfb725a4b62ab10ff4d9a5596c4 Deliver D116 jobs namespace resources and digest admission in PR #74 (https://github.com/xenarro/krun/pull/74) against immediate unmerged parent feat/helm-embedded-lifecycle/PR #73,with PR #72 still the protected-main ancestor. Creation gates Namespace with versioned restricted PSA/keep,exact LimitRange defaults/max and ResourceQuota including ephemeral-storage;tokenless krun-job-default always renders,and fixed-name digest policy/binding follow admissionPolicy independently. Required webhook/object-storage guards run even when CRD/create output is disabled. Both independent reviews reproduce the same semantic-quota defect;repair replaces silent-zero atoi with exact fixed-point count-quantity comparison,preserving literals,create=false,equality and true-exceeds failure across SI/exponent/binary forms,rounding,precision/overflow and zero concurrency. All56 namespace/155 combined controls,14 original reviewer controls and144 rational-oracle cases pass,both modes lint,and generators twice are deterministic. Hardened and exact taskset14,15 full repair checks each pass1862 TypeScript+onePython;all333 scheduler tests pass unchanged. Original deadline failures remain retained with unestablished cause,no timeout/worker relaxation. Genuine disposable exact-source task-resource Helm/API lifecycle verifies PSA,tokenless SA,defaults,ephemeral-storage max,CPU quota,CEL regular/init CREATE,Pod main/init UPDATE and legacy-Job metadata UPDATE,outside scope,creation/policy toggles,keeptrue/false uninstall,and real1k/2e2/1Ki quota installs/readbacks/uninstalls. Initial binding-readiness failure remains qualified;final bounded behavior-synchronized lifecycle passes without policy changes;owned resources/private inputs are removed. Fresh delivery make check passes1862 TypeScript+onePython. Exact source CI https://github.com/xenarro/krun/actions/runs/40747966142 passes verify/kind,locked install,generators,image smokes/identity/security,Helm,audit and all8 existing raw-manifest native scenarios/8privacy oracles over8 actual Run credential contexts,without changing retry policy. Only P7.4a is newly checked. This PLAN/README-only tracking update receives fresh make check and separate exact-head hosted CI. Pushed/green is not merged;no auto-merge or protected-main approval bypass. Full Phase7 chart-installed two-mode serving/security/data-plane,upgrade/rollback and monitoring gate remains pending;P7.4b is next.

2026-10-28 P7.4b 77f49198db688461fbbfc80c97eb71b404c792fe Deliver D117 exact namespaced RBAC in PR #76 (https://github.com/xenarro/krun/pull/76) against main after normal two-parent reconciliation of the byte-identical committed feature/main trees;PR72/73/74 are merged. Jobs scheduler Role/binding always render into jobsNamespace.name with exact Job/pod/log/Secret verbs;platform scheduler Lease get/update is name-restricted and create separate,Function reads/status patch exact. Postgres-only gateway read access and unbound author/viewer Roles add no wildcard,cluster-wide,extra Secret,migrate/job-default or automatic operator grants. Both independent reviews consumed;contracts P74B-C1 duplicate same-namespace identities reproduced and repaired with purpose-specific krun-scheduler-jobs Role/binding while keeping ServiceAccount and Lease krun-scheduler. All20RBAC/175combined controls,seven unchanged reviewer controls,both lint modes and generators twice pass. Fresh source-matched real Helm/API task-resource acceptance passes6mode/layout matrices including both coincident-namespace modes,528asserted SubjectAccessReview outcomes (213allow/315deny),exact rule/binding readback,fixture-only operator grants and uninstall revocation. Both retained exact reviewer nodes were later observed exited and removed through normal kind lifecycle;original shutdown/generation/gateway readiness failure causes remain unestablished,with no global runtime surgery or relaxed workers/budgets. Fresh source precommit make check passes1882TypeScript+onePython. Exact source CI https://github.com/xenarro/krun/actions/runs/40767862469 passes verify/kind,locked install,generators,current-source image smokes/identity/security,Helm,audit and8existing raw-manifest native scenarios/privacy oracles over8actual Run credential contexts;retry policy unchanged. Only P7.4b is newly checked after source hosted acceptance. This PLAN/README-only tracking receives fresh make check and its own exact-head hosted CI. PR76 remains OPEN/REVIEW_REQUIRED;pushed/green is not merged,required independent main review remains,no auto-merge or protection bypass. No full chart-installed serving/data-plane/upgrade or completePhase7 gate is claimed. Next:P7.4c from current committed verified lineage after refreshing main/parent;preserve feat/helm-rbac on recovery.

2026-10-29 P7.4c 25b809d2d85c966240573995732a2f7be1fbabf6 Deliver D118 namespace NetworkPolicies in PR #77 (https://github.com/xenarro/krun/pull/77) against main after normal two-parent reconciliation of the source-identical merged-parent lineage. Jobs ownership gates default deny and exact DNS, gateway TCP8081, optional object-storage and CIDR egress; release-scoped ingress always exposes the specified public/internal/admin ports, preserving selector conjunction, configured peer bodies, ipBlock exceptions, empty-list denial and coincident/external namespace behavior. NOTES warns on unrestricted IPv4/IPv6 CIDRs. Both independent reviews are consumed; P74C-C1 runtime/chart URL-authority mismatch is reproduced and repaired without endpoint mutation, new configuration restrictions, runtime dependencies or normative security changes. All 92 policy / 267 combined controls, 18 adapter boundary cases including six scoped actual HEAD requests, two unchanged reviewer regressions, 14 extra semantics controls and 94 finite policy decisions pass. Actual final-source Kubernetes acceptance passes six mode/layout matrices, 44 exact installed policy spec/label readbacks, independent expected storage ports, server validation, NOTES and uninstall. A private API-Pod Ready watch preserves strict raw health and original per-operation budgets; owned node/verifier/private inputs are removed. Historical timing, etcd, bootstrap and cleanup failures remain retained and qualified, with no invented upstream diagnosis. Fresh source precommit make check passes 1,992 TypeScript tests and one Python test. Exact source CI https://github.com/xenarro/krun/actions/runs/40789149949 passes verify/kind, locked install, generators, current-source image smokes/identity/security, Helm, production audit and all eight existing raw-manifest scenarios/privacy oracles over 8 actual Run credential contexts. Only P7.4c closes after accepted source CI. This PLAN/README-only tracking update requires its own fresh make check and exact-head hosted acceptance. PR #77 is OPEN/REVIEW_REQUIRED at source acceptance; no auto-merge, fake approval or protection bypass. Native policy readback and offline semantics are not CNI traffic proof or full chart-installed serving/upgrade acceptance; P7.4d onward and the mandatory P7.6/Phase7 gate remain later work.

2026-10-29 P7.4d 99090a1b37a8e41c42d5a7242241f54a5ff9147e Deliver D119 optional chart integrations in PR #78 (https://github.com/xenarro/krun/pull/78) against main after normal two-parent reconciliation with the source-identical merged-parent lineage; PR77 is merged. Gateway API v1 HTTPRoute renders only when enabled, preserves supplied parentRefs/non-empty hostnames and targets only the actual public Service on TCP8080. A non-empty observability endpoint injects standard component-specific OTEL endpoint/service/sampler/ratio variables into serving processes only, preserving zero and excluding migrate/restore/Litestream. userNamespaces injects scheduler KRUN_JOB_HOST_USERS=false into the existing parsed config and function Job builder; platform hostUsers and namespace/admission/network/security/value contracts remain unchanged. Both independent reviews report no confirmed material finding; repair preserves all five product paths. Fresh414scaffold controls include47optional cases;4author runtime boundaries,28correctness extras including12actual OTLP HTTP off/zero/one cases,and6contracts processor controls pass. Both-mode current-source task-resource Helm/API installs verify exact HTTPRoute/public-Service parents/hosts/backend,complete source workload server dry-runs,actual handwritten tag-only Job CREATE rejection plus absence readback,pinned suspended positives,init-image/outside-binding controls,serialized hostUsers settings,disable/re-enable empty-reference route lifecycle and uninstall. Default/enabled mode lints and generators twice pass;owned resources/private inputs are removed. Prior reviewer600s full-gate timeout and repair PostgreSQL gateway process60s test/10s hook timeout remain retained,with unestablished timing causes;unchanged9-case file replay and fresh full repair/precommit gates pass without worker/test/hook/native/security relaxation. Fresh source precommit make check passes2039TypeScript+onePython. Exact source CI https://github.com/xenarro/krun/actions/runs/40799749550 passes verify/kind,locked install,generators,current-source container/process/identity/security checks,Helm,audit and8existing raw-manifest scenarios/privacy oracles over8actual Run credential contexts. Only P7.4d closes after this accepted source CI. This PLAN/README-only tracking update requires fresh make check and its own exact-head hosted CI. PR#78 remains OPEN/REVIEW_REQUIRED at source acceptance;pushed/green is not merged,no auto-merge/fake approval/protection bypass/publication or tags. Gateway-controller traffic,ID-mapped function execution and complete chart-installed both-mode serving/CNI/data-plane/upgrade/rollback remain mandatory later P7.6/Phase7 work. Next:P7.5 generated chart docs from freshly verified committed lineage,not obsolete main.

Historical delivery snapshots below precede cumulative integration#11; current delivery status follows.
Delivery: bootstrap PR #2 merged to main as 3952108982b2fea4b37c9d9677da60ad22c17ca6.
P0.7 is pushed and green in https://github.com/xenarro/krun/pull/3 (base main), not merged.
The stack remains unmerged by instruction; required repository protections still apply and no layer is auto-merged.
P0.8 code is pushed and green in https://github.com/xenarro/krun/pull/4 (base feat/admin-health-telemetry), not merged.
P1.1 is pushed and green in https://github.com/xenarro/krun/pull/6 (base build/release-preconditions), not merged.
P1.2 is pushed and green in https://github.com/xenarro/krun/pull/7 (base feat/store-contract), not merged.
P1.3 is pushed and green in https://github.com/xenarro/krun/pull/8 (base feat/store-migrations), not merged.
P1.4 is pushed and green in https://github.com/xenarro/krun/pull/9 (base feat/store-create-run), not merged.
P1.5 is pushed and green in https://github.com/xenarro/krun/pull/10 (base feat/store-run-leasing), not merged.
Current delivery: cumulative integration https://github.com/xenarro/krun/pull/11 is merged/approved. P1.6 remains pushed/green and unmerged in https://github.com/xenarro/krun/pull/12 (base main). P1.7 is pushed and code-head green in https://github.com/xenarro/krun/pull/13 (base feat/store-run-queries), OPEN with no auto-merge;protected-main independent review still applies at integration. Next task: P1.8 subscribe from the final committed,verified P1.7 feature lineage;fork a new typed feature branch only when that new feature begins. The full dual-backend Store-method gate remains pending. P0.9 remains independently owner-blocked and unchecked;preserve its release branch and require nonsecret ownership/name/publisher evidence before release execution.
P1.8 is pushed and green in https://github.com/xenarro/krun/pull/14 (base feat/store-expiry-delivery), not merged. Next task: P1.9 from the final committed,verified P1.8 lineage;preserve this feature on recovery and fork a new typed child only when the new feature begins. Full Store assembly and Phase 1 remain incomplete.
P1.9 is pushed and green in https://github.com/xenarro/krun/pull/15 (base feat/store-subscriptions), not merged. Next task: P1.10 from the final committed, verified P1.9 lineage; preserve this feature on recovery and fork a typed child only when that new feature starts. Full Store assembly and Phase 1 remain incomplete.
P1.10 is pushed and code-head green in https://github.com/xenarro/krun/pull/16 (base feat/store-sqlite-dialect), not merged. Next task: P1.11 from the final committed, verified P1.10 lineage; preserve this feature on recovery and fork a new typed child only when that feature begins. Full Store assembly and Phase 1 remain incomplete.
P1.11 is pushed and code-head green in https://github.com/xenarro/krun/pull/17 (base feat/store-runtime-status), not merged. Phase1 complete Store acceptance passes both real backends;no auto-merge or protected-main review bypass. Next task P2.1 starts from final committed verified P1.11 lineage,not obsolete main;preserve this feature on recovery and fork a typed child only when that new feature begins. P0.9 remains independently owner-blocked;P3.7 must verify strict HTTP cancellation/deadline behavior.
Full Phase 0 and v1 acceptance remain incomplete.
