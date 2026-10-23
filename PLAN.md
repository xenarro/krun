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
- [ ] P0.7 Admin listener plugin in `packages/shared/src/health`:
      `/healthz`, `/readyz`, `/metrics` on `KRUN_ADMIN_LISTEN_ADDR` for both
      processes (a readiness route over an Effect `Ref`; the OpenTelemetry
      Prometheus exporter serving `/metrics`; the `Telemetry` layer with OTLP
      traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set); readiness returns 503 until marked ready,
      when the database check exceeds 2 seconds, and from the start of
      shutdown. Acceptance: `@effect/vitest` test with Fastify `inject` and `TestClock`,
      including a stalled database check.
- [ ] P0.8 `packages/shared/src/functions/schema.ts`: Function spec as a Zod
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

- [ ] P1.1 Model types, Kysely table types, `toRun`, `toRunSummary`
      (the only row-to-wire mappers: `name`, UPPER_SNAKE enums, `*Time`,
      `resultUri`, `reportTime`, `observeTime`) and the `Store` interface exactly as SPEC section 6 (`transition`
      takes the optional `event` payload), with error classes `NotFoundError`, `ConflictError`. Acceptance: `tsc --noEmit`
      passes, no implementation yet.
- [ ] P1.2 Migrations for both dialects with the Kysely `Migrator` and
      `FileMigrationProvider`, one directory per dialect, each migration
      runs raw SQL through `sql` templates; `krun migrate` first reads
      `kysely_migration` and diffs it against the binary's names: unknown
      names with nothing pending warn and exit 0, unknown names plus
      pending exit 1. Acceptance: migrate up twice is idempotent on both; a
      database with one extra migration recorded yields exit 0 and the
      warning; extra plus pending yields exit 1.
- [ ] P1.3 `createRun` with idempotency: composite unique index on
      (`created_by`, `function_name`, `idempotency_key`), `request_hash` the
      SHA-256 of the RFC 8785 serialisation of `{ input, priority,
      callback }`, returns the existing run on same key and hash,
      `ConflictError` on same key and different hash; when created, appends
      the `queued` `run_events` row with `payload.actor` and notifies.
      Acceptance: contract test with concurrent duplicate creates yields
      exactly one row and one event; a duplicate with reordered JSON keys
      returns the same row.
- [ ] P1.4 `claimQueued`, `releaseLease`, `setJobToken`, `markScheduled`
      (boolean; sets `scheduled_at`, appends a row, notifies),
      `countByState`, `countQueued`, `countQueuedBy`, `listByState` with
      the shared literal predicate, lease expiry semantics. Acceptance:
      contract test: two claimers never receive the same run while the
      lease is valid; an expired lease is reclaimable; `markScheduled` on a
      cancelled run returns false; `countByState` counts only non-terminal
      states; after seeding 5000 terminal and 50 active rows and `analyze
      runs`, Postgres `explain` inside a transaction with `set local
      enable_seqscan = off` names `runs_active_idx` for `countByState`.
- [ ] P1.5 `transition` compare-and-set that sets `started_at` or
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
- [ ] P1.6 `getRun`, `listRuns` returning `RunSummary` items with the
      docs/API.md filter (`state`, `failureReason`, `createTime` bounds,
      `AND`), order `created_at desc, id desc`, cursor base64url of
      `created_at|id` plus a hash of parent and filter, default limit 50,
      the cursor as the row-value comparison
      `(created_at, id) < ($createdAt, $id)`, owner scoping. Acceptance:
      pagination test over 250 rows with limit 100; items lack `input`,
      `result`, `logTail`, `error.details`; Postgres `explain` for an
      unfiltered admin list names `runs_created_idx`.
- [ ] P1.7 `expireQueued` returning the expired runs (each with
      `finished_at`, its `run_events` row, notify and delivery), `sweep`
      (SQLite runs `pragma incremental_vacuum` after each batch),
      `claimDeliveries` leasing rows for 60 s in the claim statement,
      `updateDelivery`. Acceptance: contract tests for each; a claimed
      delivery is not re-claimed within 60 s.
- [ ] P1.8 `subscribe`: Postgres `LISTEN` with reconnect; SQLite polls
      `run_events where rowid > $last` every second from `max(rowid)` at
      subscribe, kind `job_status` when `from_state = to_state`.
      Acceptance: a transition is observed within 2 seconds in both modes;
      SQLite never re-emits a row.
- [ ] P1.9 SQLite on Node's built-in `node:sqlite`: an in-house Kysely
      dialect adapter (`packages/shared/src/store/sqlite/dialect.ts`),
      pragmas on open, one connection per process, a `SqliteDriver` subclass whose `beginTransaction` runs
      `begin immediate`. Acceptance: on the temp-file database, test
      asserts `journal_mode` is `wal`; while a Store transaction is open, a
      second `node:sqlite` connection's `begin immediate` with
      `busy_timeout` 0 fails `SQLITE_BUSY`.
- [ ] P1.10 `setRuntimeStatus`, `setResult` and `setError`, allowed in
      `queued` with a token set, `scheduled` or `running`; `setJobStatus`,
      allowed in `scheduled`, `running` and `cancelling`, writes and appends
      `run_events` only when a field other than `observedAt` changed.
      Acceptance: contract test: all return false on a terminal run and on
      a `queued` run without a token; runtime status publishes a notify and
      writes no `run_events` row; a changed job status appends one; an
      `observedAt`-only change writes nothing.
- [ ] P1.11 `listStale(fn, before)` using the later of `runtime_status.at`
      and `started_at` (section 6 expressions) and `failure_reason` in the
      `transition` patch. Acceptance: contract test: a running run with an old status is
      returned, one with a fresh status is not, one with no status but an
      old `started_at` is returned; `failed` rows carry `failure_reason`.

### Phase 2: webhooks, functions and auth (parallel with Phase 1)

Gate: `pnpm exec vitest run packages/shared/src/webhook packages/shared/src/functions packages/shared/src/auth` green, no cluster needed.

- [ ] P2.1 `packages/shared/src/webhook`: host glob allowlist, address
      check after DNS resolution (unwrap IPv4-mapped; accept when inside
      `KRUN_WEBHOOK_ALLOWED_CIDRS`, else only ipaddr.js `unicast`), an
      undici `Agent` whose `connect.lookup` returns only the checked
      address with `servername` set, HMAC signing with timestamp and one
      `v1=` per secret. Acceptance: unit tests reject `127.0.0.1`,
      `10.0.0.1`, `169.254.169.254`, `100.64.0.1`, `::1`,
      `::ffff:127.0.0.1`; accept an allowed public host; accept `10.0.0.1`
      when `10.0.0.0/8` is listed; a signature verifies with each of two
      secrets.
- [ ] P2.2 Function validation: the second layer from SPEC section 3 as one
      pure function, Ajv2020 `strict`, no `loadSchema`, `$ref` to URLs
      rejected, 64 KiB cap, allowed service accounts, `krun-*` secretRefs,
      callback host via P2.1. Acceptance: table test with one invalid case
      per rule, including a schema that does not compile, a 65 KiB schema,
      a `heartbeatTimeout` of 5s, a remote `$ref` and a forbidden service
      account.
- [ ] P2.3 `packages/shared/src/k8s` KubeConfig loading, and the Function
      informer cache: informer on `functions.krun.io` in `KRUN_NAMESPACE`,
      add, update and delete handlers, validation on each event with the
      compiled validator cached per uid and generation, `error` handler
      restarting with backoff, 404 before the CRD is Established retried
      the same way, a `synced` promise for readiness, metrics
      `krun_functions_synced` and `krun_functions{ready}`. Acceptance:
      test feeds events through a stubbed informer; an invalid Function is
      absent from the map; the map reflects a delete; a status-only update
      does not recompile.
- [ ] P2.4 `keys.yaml` loader: `key` as string or list, duplicate names
      rejected, constant-time lookup, scopes including `runs:priority` and
      `admin`, function globs, per-key `maxQueued`, 30 second polling
      reload on the content hash. Acceptance: test for allowed, denied,
      `admin`, a key with two secrets during rotation, a duplicate name.
- [ ] P2.5 `krun validate <path>...` in `packages/cli`: CRD schema plus the
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

- [ ] P3.1a App factory, store, Function cache and keys as Fastify plugins
      and decorators, auth hook, the AIP-193 error envelope with
      `ErrorInfo.reason` per the docs/API.md table, rejection of unknown
      fields, `null` values and query parameters, `setNotFoundHandler` and
      `setErrorHandler` rendering every framework error in the envelope.
      Acceptance: 401 `KEY_MISSING` without key, 404 `FUNCTION_NOT_FOUND`
      for a function outside the globs with a generic message, envelope
      shape on both, 400 `REQUEST_INVALID` on an unknown query parameter
      and on `null`, 404 `ROUTE_NOT_FOUND` on an unknown path, 415
      `CONTENT_TYPE_UNSUPPORTED` on `text/plain`.
- [ ] P3.1b `X-Request-Id` handling, audit log fields, pino redaction,
      `krun_http_*` metrics with the `route` label rule. Acceptance: the
      401 line has `key: null` and a `reqId`; a 404 counts under
      `unmatched`; a redacted field never appears in a log line.
- [ ] P3.1c `@fastify/swagger` and the `make generate` step writing
      `docs/api/openapi-public.json` (OpenAPI 3.1, the machine-readable
      form of docs/API.md). Acceptance: no diff on a second run; every
      method in the docs/API.md table appears with its path; response enums
      are typed `string` with the known values in `description`; no schema
      is nullable.
- [ ] P3.2 `ListFunctions` (`{ functions, nextPageToken }`, `pageSize`,
      `pageToken`) and `GetFunction`, filtered by key globs, Ready only,
      Function fields per docs/API.md including `callback`, `queueTimeout`,
      `maxInputBytes`, `maxResultBytes`, `maxWait`. Acceptance: handler
      test; a key with no matching function gets an empty list;
      `callback` is present when `spec.callback` is set and omitted
      otherwise; no field is ever `null`.
- [ ] P3.3 `CreateRun`: size limit before parsing, schema validation with
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
- [ ] P3.4 `GetRun` (FULL, `view=BASIC` accepted, `-` wildcard) and
      `ListRuns` (`{ runs, nextPageToken }` of BASIC runs through
      `toRunSummary`, `-` wildcard, `pageSize` coercion and negative
      rejection, `pageToken` bound to parent and filter, the filter
      grammar with `FILTER_INVALID`, malformed or mismatched token
      `REQUEST_INVALID`, no `view`) with owner scoping and `RUN_NOT_FOUND`
      for other keys' runs. Acceptance: handler tests; a list item has no
      `input`; `state = FAILED AND createTime >= "..."` filters correctly;
      a bad filter is 400 `FILTER_INVALID`; a token replayed with another
      filter is 400 `REQUEST_INVALID`; `pageSize=500` returns 200 items.
- [ ] P3.5 `CancelRun` (`POST ...:cancel`): 200 with the FULL run from
      queued, scheduled, running (transition to `cancelling` with
      `payload.actor` = key name) and when already `cancelling` or
      `cancelled` (no new transition); 400 `FAILED_PRECONDITION`
      `RUN_TERMINAL` with `metadata.state` on `succeeded` or `failed`.
      Acceptance: handler test asserts the `cancelling` event carries
      `actor`, a repeat adds no event, a `cancelled` run returns 200.
- [ ] P3.6 `GetRunResult` (`GET ...:getResult`) with inline, 307 (300 s
      presign, `Cache-Control: no-store`), `RESULT_MISSING` and
      `RUN_NOT_TERMINAL` branches; 200 on a failed run that kept a result.
      Acceptance: handler test with a fake object store covering all five.
- [ ] P3.7 `krun gateway` wires config, store, Function cache, keys, the
      three listeners as scoped Effect layers under `NodeRuntime.runMain`,
      readiness, SIGTERM drain through scope finalizers:
      `/readyz` 503 first, `KRUN_SHUTDOWN_DELAY`, then close. Acceptance:
      process starts in embedded mode with a temp directory and `KUBECONFIG`
      pointing at `test/fake-kube` serving one Function, answers `/readyz`
      200 on the admin port, `/v1/*` is 404 on the admin port, with
      `KRUN_SHUTDOWN_DELAY=2s` a `/v1` request after `/readyz` turned 503
      still answers 200, and the process exits 0 within 5 seconds of
      SIGTERM.
- [ ] P3.8 Internal API per docs/INTERNAL-API.md: second Fastify instance
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

- [ ] P4.1 `apps/scheduler/src/k8s`: Job and Secret builders producing
      exactly the manifest in SPEC section 7 (immutable Secret, labels
      including `krun.io/created-by`, tolerations, `runAsUser`,
      `runAsGroup`, `HOME`, every env). Acceptance: golden-file test of the
      rendered Job and Secret for one function.
- [ ] P4.2 Leader election with the Lease per the SPEC section 8 contract:
      `holderIdentity` is the pod name, `get` then `update` with the read
      `resourceVersion`, 409 retry in 2 s, expiry judged on the local clock
      from the last observed change, exit non-zero after 10 s without a
      renew; `krun_scheduler_leader`; Job and Pod informers, loops and the
      status writer start on acquisition and stop on loss; release on
      SIGTERM. Acceptance: unit test with a stubbed `CoordinationV1Api` for
      acquire, renew, 409, lose (informers stopped), renew failure exit and
      release. The two-scheduler check runs in P7.6.
- [ ] P4.3a Kubernetes API plumbing: the `KRUN_K8S_CONCURRENCY` limiter with
      10 s `Effect.timeout` per call (the request's `AbortSignal` fires on interruption), error classification (transient
      back-off, permanent `job_create_failed` with `error.source` `krun`,
      `details.code` and `details.reason`), 429 with `Retry-After`,
      `krun_quota_rejections_total`, `krun_job_create_errors_total`.
      Acceptance: unit test: at most 8 calls in flight; a 503 is transient;
      a 422 is permanent with `details.code` 422; 429 honours
      `Retry-After`.
- [ ] P4.3b Main loop per SPEC section 8: `countByState` first, expire
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
- [ ] P4.3c Cancelling handling: foreground Job delete, Secret delete,
      transition to `cancelled`. Acceptance: unit test with the Job absent
      and present.
- [ ] P4.4 Job and Pod informers (`makeInformer`) with the `krun.io/run-id`
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
- [ ] P4.5 Main-loop step 6 and the reconcile timer: `job_lost` detection
      from `listByState` against the informer cache with a leader-local
      first-absent map, active only after the Job informer's initial list,
      2 minute grace, `krun`-sourced error unless the function reported
      one, written `result` kept, Secret deleted; startup log of
      `scheduled` or `running` runs with no Job. Acceptance: unit test with
      a run in `running` and no Job fails after 2 minutes; a run with a
      result keeps it; a run with a reported error keeps it; a Job reappearing clears the
      entry; nothing fires before the initial list.
- [ ] P4.6 Metrics from SPEC section 11 owned by the leader:
      `krun_runs_transitions_total`, `krun_runs_current` from
      `countByState` each loop, queue wait, cold start, run duration.
      Acceptance: with `test/fake-kube` completing the Job, the exact metric
      names of SPEC section 11 appear on the admin `/metrics` after one run
      (no doubled `_total`, histograms in seconds), and with an in-memory span exporter the run's create request, iteration
      and Kubernetes calls appear as spans carrying the same `krun.run_id`;
      a `traceparent` sent with `CreateRun` becomes the parent of the request
      span.
- [ ] P4.7 Function status writer on the leader: `Ready` condition with the
      reason from P2.2, patched through `CustomObjectsApi` only when
      `observedGeneration` or the condition changes. Acceptance: stubbed
      API; an invalid Function gets `Ready=False` with the reason; a
      repeated event causes no second patch.
- [ ] P4.8 Failure detection per SPEC section 8: log tail capture on the
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
- [ ] P4.9 Heartbeat loop every 10 seconds, started only after both
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
- [ ] P4.10 Sweep loop every 10 minutes: `sweep(now - KRUN_RETENTION, 1000)`
      until a batch returns fewer than 1000; delete `krun.io/run-id` Secrets
      older than 1 hour with no matching Job; `krun_sweep_deleted_total`.
      Acceptance: unit test with a fake clock and stubbed `CoreV1Api`.
- [ ] P4.11 `krun scheduler` wires config, store, KubeConfig, Function
      cache, admin listener, leader election and loops; `/readyz` 503 until
      the database and the Function informer are ready, a standby stays
      ready and reports leader status; SIGTERM order per SPEC section 11
      ending with `holderIdentity` cleared. Acceptance: embedded mode with
      `KUBECONFIG` pointing at `test/fake-kube`: `/readyz` 200 as standby,
      exits 0 within 5 seconds of SIGTERM with the Lease cleared in the
      fake.
- [ ] P4.12 `test/e2e` foundation: `make kind-up` pinned to kind 0.31 or
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
- [ ] P4.13 `test/e2e` scenarios in the gate above. Acceptance: `make e2e`
      green.

### Phase 5: wait, SSE, webhooks

Gate: e2e adds a `?wait=30s` scenario on `CreateRun` returning 201 with
`state: SUCCEEDED` and the inline `result`, then a `POST ...:wait` on the
same run returning 200 with the same terminal run, and an in-cluster webhook
receiver pod, reachable through
`KRUN_WEBHOOK_ALLOWED_CIDRS` set to the kind pod and Service CIDRs, that
records one signed delivery and verifies the timestamped signature.

- [ ] P5.1 Notify fan-out in the gateway: subscribe before insert, 1 second
      poll fallback, `wait` on `CreateRun` (status stays 201) and
      `WaitRun` (`POST ...:wait` with `timeout`), `KRUN_MAX_WAIT` cap,
      SIGTERM answers in-flight waits at once. Acceptance: handler test with
      a fake store emitting a transition, `WaitRun` returning the run at
      timeout without error, and one where SIGTERM ends the wait early.
- [ ] P5.2 `WatchRun` (`GET ...:watch`) SSE of state, status and job
      status events with BASIC run data, `id` per docs/API.md, keepalive
      comments every 15 seconds, closes after terminal state and on
      SIGTERM; the first message is the current state, a terminal run at
      connect gets one message then EOF. Acceptance: handler test reads a
      state event, a status event, then EOF; `data` has no `input`;
      terminal-at-connect yields one message then EOF.
- [ ] P5.3 Deliveries loop: `claimDeliveries(now, 40)`, POST through the
      P2.1 dispatcher with concurrency 8, a 10 second timeout,
      `redirect: 'manual'`, signature per attempt, the tick awaiting the
      batch and re-claiming at once when full, six attempts on the schedule
      then `dead`, 2xx only, `krun_deliveries_total`. Acceptance: unit test
      with a local `http.createServer` receiver returning 500 then 200, a
      302 counted as failure, a sixth failure marking `dead`, 40 pending
      rows delivered with at most 8 in flight.
- [ ] P5.4 e2e scenarios for wait (201 on `CreateRun`, 200 on `WaitRun`)
      and webhook (constant `X-Krun-Delivery` across a retried attempt, two
      `v1=` entries during rotation) with the CIDR allowlist. Acceptance:
      `make e2e` green.

### Phase 6: object storage

Gate: e2e with MinIO in kind: a function uploads a 1 MB result, the run
shows `resultUri`, `GetRunResult` returns 307 to a URL that
serves the object.

- [ ] P6.1 `packages/shared/src/objstore`: presigned PUT with TTL and no
      signed `Content-Type` (`requestChecksumCalculation: WHEN_REQUIRED`),
      presigned GET, object exists. Acceptance: unit test against a MinIO
      testcontainer; a PUT with `Content-Type: application/json` succeeds
      against the presigned URL.
- [ ] P6.2 Scheduler sets `KRUN_RESULT_UPLOAD_URL` when configured
      (`KRUN_S3_PRESIGN_TTL` else `activeDeadlineSeconds`) and checks object
      existence before the terminal compare-and-set on `Complete` when
      `result` is null. Acceptance: unit test with a fake object store; the
      delivery payload carries `resultUri`; a run with an inline result
      skips the check; the TTL follows the variable.
- [ ] P6.3 e2e scenario with MinIO, with a raw NetworkPolicy manifest in
      the pre-chart jobs namespace manifests allowing egress to the MinIO
      pods. Acceptance: `make e2e` green.

### Phase 7: Helm chart

Gate: `make helm-lint` green; `helm template` renders both modes; e2e
switches to installing the chart instead of raw manifests, in embedded
mode and in postgres mode with a plain Postgres Deployment from
`test/e2e/postgres.yaml`, each into a fresh krun namespace labelled
`pod-security.kubernetes.io/enforce=restricted`.

- [ ] P7.1 Chart completed from the P0.8 stub: values from SPEC section 13
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
- [ ] P7.2 Postgres mode: two Deployments, migrate hook Job with weight 0
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
- [ ] P7.3 Embedded mode: StatefulSet with two containers, shared PVC with
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
- [ ] P7.4a Jobs namespace resources gated by `jobsNamespace.create`:
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
- [ ] P7.4b RBAC: scheduler Role and RoleBinding and `krun-job-viewer`
      always rendered into `jobsNamespace.name`; gateway Role and
      RoleBinding, `krun-function-author`, Lease RBAC with `resourceNames`
      in the krun namespace. Acceptance: `helm template` contains each
      rule; `--set jobsNamespace.create=false` still renders the scheduler
      Role, RoleBinding, `krun-job-default` and `krun-job-viewer` and no
      Namespace, LimitRange, ResourceQuota or NetworkPolicy;
      `--set jobsNamespace.create=false --set config.maxRunning=300` renders
      successfully.
- [ ] P7.4c NetworkPolicies per SPEC section 9: jobs namespace deny-all,
      `dnsEgress` peers, gateway 8081 by `krun.io/gateway` and namespace
      label, `objectStorage.egress`, `egressCIDRs`; krun namespace
      deny-all and allows for 8080, 8081 and the admin ports (9090, plus
      9091 in embedded mode) from `networkPolicy.metricsFrom`; `egressCIDRs`
      as `ipBlock` objects with `except`; NOTES.txt warning for an
      unrestricted `0.0.0.0/0`. Acceptance: `helm template` contains each
      rule in both modes, including a rendered `except`; the e2e checks run
      in P7.6.
- [ ] P7.4d Optional features: `gatewayApi.httpRoute` renders an HTTPRoute
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

Delivery: implementation commit d07922c is pushed in PR #2; hosted CI is green.
Merge to protected main awaits the required independent repository approval.
Next task: P0.7. Full Phase 0 and v1 acceptance remain incomplete.
