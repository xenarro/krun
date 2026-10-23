---
name: krun-development
description: Use when starting any krun task or session. Routes to the krun-* and stack skills for the PLAN phase and restates the agent protocol and the Node 26 / Effect 4 / Zod 4 / OpenTelemetry stack.
---

# krun development (router)

krun runs HTTP-triggered functions as one-off Kubernetes Jobs: gateway
(three Fastify listeners inside an Effect program), leader-elected
scheduler, Postgres or embedded SQLite, a `Function` CRD, Helm chart,
Node.js and Python SDKs, CLI (SPEC.md section 2). Load this skill first in
every session.

## When to use

Any krun work: pick the next PLAN task, implement it, review a task branch,
answer a design question.

## Read order and session loop

1. Read fully, in order: `CLAUDE.md`, `docs/PROBLEM.md`, `SPEC.md`,
   `docs/API.md`, `docs/INTERNAL-API.md`, `docs/STACK.md`, `PLAN.md`,
   `docs/OPERATIONS.md` (CLAUDE.md:3, docs/AGENT-KICKOFF.md:13-15). Then
   PLAN section 6 (progress log) and `git log --oneline -20`. Every `[x]`
   needs a commit. A commit without `[x]` means the log is behind: fix the
   log first (docs/AGENT-KICKOFF.md:69-73).
2. Pick the first unchecked task in the lowest unfinished phase. Tasks run
   in order unless marked "parallel" (PLAN.md:9-12).
3. Restate the acceptance criterion in one line before coding. Write the
   acceptance test first (docs/AGENT-KICKOFF.md:33-34, 50).
4. Load the `krun-*` and stack skills from the routing table (CLAUDE.md
   rule 7, docs/STACK.md section 5).
5. Implement. Run the acceptance command and `make check`. Mark `[x]`,
   append `YYYY-MM-DD P1.3 <sha> note` to the progress log, commit the plan
   change with the code (PLAN.md:17-22).
6. Stop after a phase gate or six tasks (docs/AGENT-KICKOFF.md:56). Final
   message: tasks with short SHAs, gate status, BLOCKED items, Decisions
   rows added, next task id (docs/AGENT-KICKOFF.md:58-59).

## Protocol (non-negotiable)

- SPEC.md is the only source of truth for behaviour. docs/API.md and
  docs/INTERNAL-API.md are normative for the two HTTP contracts,
  docs/STACK.md for libraries. Code contradicting SPEC needs a new SPEC.md
  section 15 row first (PLAN.md:23-27, SPEC.md:3-5).
- Owner decisions never get an agent-written Decisions row: published
  package names beyond the P0.9 fallbacks, public API shape, SPEC section
  9 policy, non-goals. Write `BLOCKED <task>: <need>` in the progress log;
  take the next independent task (PLAN.md:24-29).
- Dependencies: only PLAN.md section 2 / docs/STACK.md section 2-3. A new
  one needs a Decisions row with a one-line reason (PLAN.md:30-31).
- In house, no library (PLAN.md:86-90, docs/STACK.md 2.3): token bucket,
  SSE on `reply.raw`, Lease election (scoped Effect layer), duration
  grammar (Zod refinement into `Duration`), `traceparent` parser,
  `node:sqlite` Kysely dialect adapter.
- Globs (API key functions, webhook hosts): `picomatch`, never a
  hand-written regex (docs/STACK.md 2.5).
- Build nothing in SPEC.md section 1 non-goals. No option, flag or
  abstraction no task asks for (SPEC.md:19-24, PLAN.md:32-33). Server
  processes take no flags except `--help` (SPEC.md:1210). CLI flags: only
  those SPEC section 7.2 names.
- Branch per task id (`p1-3-claim`). Conventional Commits, package as scope
  (`feat(store): ...`). PR to main, merge on green CI. Never push main.
  Only the owner tags `v*` (PLAN.md:13-22).
- Never add a `Co-Authored-By` trailer or any Claude attribution (CLAUDE.md
  rule 5, PLAN.md:16).
- Never commit secrets; tests generate their own keys (PLAN.md:34). Never
  log input, results, tokens or API keys (SPEC.md:1104-1105, 1181-1186).
- Check tools at phase start. Missing tool: BLOCKED
  (docs/AGENT-KICKOFF.md:41-46).

## Stack (docs/STACK.md, SPEC D35 and D36, CLAUDE.md rules 6-8)

| Area | Rule |
|---|---|
| Language | TypeScript 7 (native `tsc`, emits `dist/`), strict, Node.js 26 (LTS, supported to April 2029), ESM, pnpm workspace. Erasable syntax only: no `enum`, no parameter properties, no value namespaces. `import type` for types (`verbatimModuleSyntax`) (PLAN.md:43-45, docs/STACK.md section 3). |
| Effect | Effect 4 (`effect` and `@effect/platform-node`, same `~4.0.x`) under every process. Entry `NodeRuntime.runMain(Layer.launch(Main))`. Services `Context.Service`, wiring `Layer`. Core `effect` modules only: no `effect/sql`, `effect/http`, `effect/schema`, `effect/cli` (docs/STACK.md 2.1, 4.1). Renames: table below. |
| Errors | Domain and infrastructure failures are `Data.TaggedError` classes. One function maps tags to the AIP-193 envelope; a defect is 500 `INTERNAL`. No `throw` in application code outside adapters; adapters wrap promises with `Effect.tryPromise` (docs/STACK.md 4.2). |
| SPEC to Effect (docs/STACK.md 4.3) | `Semaphore` for `KRUN_K8S_CONCURRENCY`; `Effect.timeout` for every call bound; `Effect.retry`/`Effect.repeat` with `Schedule` for backoff and loops; `Stream` for informers; scope finalizers for SIGTERM order. |
| HTTP | Fastify 5 listeners are scoped layers. Acquire: build, `listen`. Release: readiness 503, drain, close. Readiness: small route over an Effect `Ref`. Shutdown: `runMain` plus finalizers in reverse order. |
| Schemas | Zod 4 only, for all krun schemas. Routes: `fastify-type-provider-zod` 7 (`validatorCompiler`, `serializerCompiler`, `jsonSchemaTransform`). Bodies `z.strictObject`; `.optional()`, never `.nullable()`. Zod also for Function spec, keys.yaml and config (a Zod schema over `process.env`, exposed as an Effect Config service layer). CRD and OpenAPI from `z.toJSONSchema`. No Effect Schema. Ajv (`Ajv2020`, strict, no `loadSchema`) compiles only user `inputSchema`. |
| Time | Application code never calls `Date.now()` or `new Date()`. Use `Clock.currentTimeMillis`, `DateTime.now`, `DateTime.formatIso`, `Duration`. UUIDv7: `uuid` `v7({ msecs })`, `msecs` from `Clock` (CLAUDE.md rule 8, docs/STACK.md 4.4). |
| Data | Kysely 0.29 + `pg` for Postgres. Embedded: built-in `node:sqlite` (release candidate in Node 26) via the in-house Kysely dialect `packages/shared/src/store/sqlite/dialect.ts`. All inside an Effect `Database` service. No native addons anywhere: image needs no build toolchain, no glibc constraint (PLAN P0.3). |
| Kubernetes | `@kubernetes/client-node` 2.x inside an Effect `Kube` service: semaphore, 10 s `Effect.timeout`, informers as `Stream`s. |
| Utilities (docs/STACK.md 2.5) | `ajv`/`ajv-formats` (user `inputSchema` only), `uuid` v7, `canonicalize`, `yaml`, `ipaddr.js`, `picomatch` (key function globs, webhook host globs). |
| CLI only (`packages/cli`, docs/STACK.md 2.7) | `@clack/prompts` (interactive `krun init`, deploy spinners; never prompts off a TTY), `picocolors`, `tinyexec` (runs `docker`, `kubectl`). Arguments: `node:util` `parseArgs`. `krun init --name` defaults to the target directory name. Missing `--lang`: prompt on a TTY, else fail with a usage message. |
| Tests | Vitest 5 + `@effect/vitest` (`it.effect`, already scoped in 4.x; `layer(...)`; `TestClock.adjust` from `effect/testing`). fast-check for properties; testcontainers for Postgres and MinIO. Gates run `pnpm exec vitest run <dir>`. No real sleeps, no fake timers for Effect code (PLAN.md:50-52). |
| Dev tooling (docs/STACK.md section 3, PLAN.md:79-82) | `biome` lint and format. `knip` (unused files, exports, dependencies) runs in `make check`: an unused export or dependency fails the gate. `publint` and `@arethetypeswrong/cli` check `@krun/sdk` and `@krun/cli` exports before publishing (P9.5). Python SDK: `uv`, `ruff`, `pytest`, `hypothesis` (property tests), `mypy --strict`. |
| SDKs, templates | SDKs (`packages/sdk-node`, `sdk/python`): no dependencies, no Effect. Node SDK tests run under Vitest as a dev dependency. `krun init` templates are the function author's project, not krun: no dependencies; a template's test runs with `node --test`. |
| Minimum versions (SPEC section 14, docs/STACK.md) | Node.js 26 for krun image and toolchain. Node SDK: Node 22+ (SPEC.md section 14 and 7.1). Python SDK: 3.11+. Kubernetes 1.33+; tests: kind 0.31+ with node image 1.33+ (PLAN.md:53-55). User namespaces: 1.36, or feature gate on 1.33-1.35. Postgres 16+; CI contract suite on Postgres 18. |

Telemetry (SPEC section 11, docs/STACK.md 2.6; detail in
`krun-process-runtime`):

- OpenTelemetry via `@effect/opentelemetry`: one `Telemetry` layer
  (`NodeSdk.layer`) provided in each process's `main.ts`.
- Metrics: Effect `Metric`s exported by `@opentelemetry/exporter-prometheus`
  on the admin listener's `/metrics`, exactly SPEC names (no doubled
  `_total`). No second metrics library.
- Spans: `Effect.withSpan` for requests, loop iterations, store and
  Kubernetes calls. Every span about a run carries `krun.run_id`. v1 does
  not join a run's spans into one trace across processes: no trace column,
  no trace variable to the pod.
- OTLP/HTTP export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Honour
  incoming `traceparent`. Log lines in a span carry `traceId` and `spanId`.
  Span attributes follow log redaction rules.
- OpenTelemetry packages stay on the 2.x / 0.223 lines that
  `@effect/opentelemetry` 4.0.6 peers on.

## Routing table

Every row also loads the six user-level `effect-*` skills below (except
the SDK row), `vitest` and `test-driven-development` for tests, and
`incremental-implementation`, `git-workflow-and-versioning`,
`code-review-and-quality` (docs/STACK.md section 5).

| PLAN tasks | krun skill | Stack skills (docs/STACK.md section 5) |
|---|---|---|
| P0.1-P0.4, P0.9, P4.12, P4.13, P5.4, P6.3, P7.6, P8.6, P9.1-P9.6 | `krun-testing-ci` | `pnpm`, `node`, `typescript-project-contracts`, `building-ci-pipelines`, `github-actions-advanced`, `dockerfile-optimise`, `testing-strategies`; P9 also `kubernetes-hardening`, `security-and-hardening` |
| P0.5, P0.7, P3.1b, P3.7, P4.6, P4.11 | `krun-process-runtime` plus the app skill | `zod-4`, `fastify-best-practices`, `node`; P0.7, P3.1b, P4.6 also `observability-and-instrumentation` |
| Telemetry in any task: a new metric, span, span attribute or `traceparent` handling (request spans in P3.x, store spans in P1.x, Kubernetes spans in P4.x) | `krun-process-runtime` (`../krun-process-runtime/references/telemetry.md`) next to the task's own skill | `observability-and-instrumentation`; `agent-observability` for span and redaction rules only |
| P0.8, P2.2, P2.3, P2.5, P4.7 | `krun-functions-crd` | `zod-4`, `kubernetes-operator`, `kubernetes-skill`; P2.5 also `building-clis` |
| P1.1-P1.11 | `krun-store` | `kysely`, `using-relational-databases` |
| P2.1, P5.3, P6.1, P6.2 | `krun-webhooks-objstore` | `security-and-hardening` |
| P2.4, P3.1a-P3.8, P5.1, P5.2 | `krun-gateway-api` | `fastify-best-practices`, `zod-4`, `designing-apis`, `api-and-interface-design`, `security-and-hardening` |
| P4.1-P4.5, P4.8-P4.11 | `krun-scheduler-k8s` | `kubernetes-operator`, `kubernetes-skill`, `operating-kubernetes` |
| P7.1-P7.7 | `krun-helm-chart` | `helm-chart-scaffolding`, `operating-kubernetes`, `kubernetes-hardening` |
| P8.1-P8.7 | `krun-sdk-cli` | `building-clis`, `python-patterns`, `python-type-system`, `pytest-advanced`; no `effect-*` for SDK code |
| Review prompt (docs/AGENT-KICKOFF.md:84-98) | the skill of the task under review, plus the review checklist below | `code-review-and-quality` |

A task calling into another component loads that skill too. Example: P3.3
reads `krun-store` for `countQueued` and `krun-webhooks-objstore` for the
callback address check.

## Repository layout

Files land exactly where PLAN.md section 3 (PLAN.md:98-135) and SPEC paths
say: `packages/shared/src/{config,store,functions,k8s,auth,health,runtime,objstore,webhook}`,
`packages/sdk-node`, `packages/cli`, `sdk/python`, `apps/gateway`,
`apps/scheduler`, `deploy/crds`, `deploy/helm/krun`, `scripts`, `docs/api`,
`test/{e2e,fake-kube,sdk-conformance}`. Effect layers (Config, Logger,
Database, Kube, ObjectStore, Metrics, Telemetry) and the error-to-envelope
mapping: `packages/shared/src/runtime` (PLAN.md:111). Tests: `*.test.ts`
next to the code (PLAN.md:137).

## Generic skills: technique only, SPEC and STACK win

Vendored under `.claude/skills/`, pinned by `skills-lock.json`:

| Skill | Use for | Never let it |
|---|---|---|
| `fastify-best-practices` | plugin encapsulation, hooks, logging, `inject` tests | change the error envelope (SPEC.md:218-224); add plugins or a schema provider outside PLAN section 2 (routes use `fastify-type-provider-zod`; readiness is an Effect `Ref`); own the process: Fastify lives inside scoped Effect layers |
| `node` | streams, AbortSignal, ESM, `unref`, performance | introduce CJS, a test runner other than Vitest for krun packages, raw `setTimeout`/`Date` in application code |
| `pnpm` | workspace, catalogs, `workspace:` protocol | add tooling PLAN does not list; allow a native build in `onlyBuiltDependencies` (no native addons, SPEC D36) |
| `kysely` | query builder, `sql` tag, Migrator, dialects (`SqliteDialect`, which the in-house `node:sqlite` adapter implements) | replace raw-SQL migrations or the literal-predicate rule (SPEC.md:535); swap in `@effect/sql-kysely` (docs/STACK.md 2.3); add a native SQLite driver (embedded is `node:sqlite`, D36) |
| `vitest` | per-package config, filtering, coverage, `vi` mocks for non-Effect adapters | use `vi.useFakeTimers` or real sleeps for Effect code: use `TestClock` |
| `zod-4` | Zod 4 API, `z.strictObject`, `.meta`, `z.toJSONSchema`, v3-to-v4 differences | use `.nullable()` on API shapes, Zod 3 idioms, a second schema library |
| `kubernetes-skill` | Job/Pod semantics, RBAC verbs, NetworkPolicy, PSA, probes | relax the jobs-namespace policy (SPEC.md:1002-1063) |
| `kubernetes-operator` | reconcile and status-condition concepts (Go/controller-runtime) | add controller-runtime-style abstractions: krun uses `@kubernetes/client-node` informers as Effect `Stream`s and hand-written loops (SPEC.md:853-859) |
| `helm-chart-scaffolding` | chart hygiene, helpers, lint | render a Secret, ConfigMap or Function; move the CRD to `crds/` (SPEC.md:1365, 1418-1435, D22) |

User-level (owner's machine; elsewhere use docs/STACK.md and library docs):
`effect-core-patterns`, `effect-error-handling`,
`effect-dependency-injection`, `effect-resource-management`,
`effect-concurrency`, `effect-testing`. Parts predate Effect 4: Effect's
`MIGRATION.md` and docs/STACK.md win.

| Effect 3 / skill text | `effect` 4.0.6 |
|---|---|
| `Context.Tag` | `Context.Service` |
| `Runtime<R>` | none |
| `FiberRef` | `Context.Reference` |
| `Effect.fork` | `forkChild`, `forkScoped`, `forkIn`, `forkDetach` |
| `Layer.scoped` | `Layer.effect` (takes scoped acquisition) |
| `Either` module | `Result` |
| `@effect/vitest` `it.scoped` | `it.effect` (is scoped) |

Unsure of another name? Check `MIGRATION.md`; never guess. Never load
`effect-schema` (no Effect Schema) or `backend-dev-guidelines`
(Express/Prisma conflicts with Fastify/Kysely).

Also useful: `test-driven-development`, `testing-strategies`,
`github-actions-advanced`, `dockerfile-optimise`,
`api-security-best-practices`, `security-and-hardening`, `pytest-advanced`.
`observability-and-instrumentation` is technique only: no
auto-instrumentation, no second metrics library, no series beyond SPEC
section 11, no OpenTelemetry packages outside docs/STACK.md 2.6.

Generic skill conflicts with a cited SPEC, PLAN or STACK line:
SPEC/PLAN/STACK wins. Competitor citations in `krun-*` skills are
`repo path:line` (KEDA, knative/func, Dapr, Knative Serving); the clones
are outside the repo and not needed.

## Review checklist (for the review prompt)

Report only defects: path:line, severity, failure scenario, fix. Check in
this order (docs/AGENT-KICKOFF.md:89-98):

1. A test proves the task's acceptance criteria.
2. Behaviour matches SPEC.md (and docs/API.md, docs/INTERNAL-API.md) section
   by section for what the task touches.
3. No SPEC section 1 non-goal built.
4. No dependency outside PLAN section 2.
5. No `Date.now()`, `new Date()` or bare `throw` in application code. Zod
   is the only schema library for krun schemas.
6. No secret, input, result, token or key in logs, span attributes or
   manifests. `/metrics` names exactly SPEC section 11.
7. `make check` passes.
8. A behaviour change without a new Decisions row is a blocker.

## Ten invariants most often violated

1. Every state change is compare-and-set on `state = $from`. Zero rows: a
   stale event, log at debug (SPEC.md:340-342).
2. When `callback_url` is set, a terminal transition inserts the
   `deliveries` row in the same transaction, on every path: `transition`,
   `expireQueued`, heartbeat, `job_create_failed` (SPEC.md:347-350, D29).
3. `countByState`/`listByState` use the `runs_active_idx` predicate as
   literal SQL from one shared fragment, never bound parameters
   (SPEC.md:535).
4. Judge Lease expiry on the candidate's own clock (Effect `Clock`) from
   the last observed change of `holderIdentity`/`renewTime`. Never compare
   `renewTime` with now (SPEC.md:793-796).
5. `@kubernetes/client-node` informers have no resync and stop on error.
   The 5-minute leader reconcile `Schedule` and a backoff watch restart are
   mandatory (SPEC.md:853-859, D33).
6. Heartbeat and `job_lost` start only after both informers' initial list.
   They defer to the informer path when the cached Job is terminal
   (SPEC.md:785-787, 906-912, D33).
7. Terminal order: object-store check; CAS with final `jobStatus`,
   `failureReason`, `error`, `logTail`, `startTime` when missing; delete
   Secret; delete Job (background). `pods/log` always before any delete
   (SPEC.md:868-879, 902-905).
8. Store the per-run token hash before the Job exists. Secret immutable,
   no owner reference. `AlreadyExists` reads the existing token.
   `markScheduled` false deletes Job and Secret (SPEC.md:569-576, 826-831,
   D27).
9. Kubernetes errors: 403 quota, 429, 5xx, network are transient (release
   lease, `2^n` backoff capped 60 s, honour `Retry-After`). Any other 4xx is
   permanent `job_create_failed`. 404 on delete is success
   (SPEC.md:801-805, 833-842, D23).
10. Logs never contain input, result, runtimeStatus, error.details, tokens,
    keys, bodies, Job manifests or env lists (SPEC.md:1181-1186).

## Limitations

Routes and restates only. Component rules: `krun-*` skills. Authority:
SPEC.md, docs/API.md, docs/INTERNAL-API.md, docs/STACK.md. Line numbers
from SPEC.md and PLAN.md as of 2026-10-23: re-verify a citation if those
files changed.
