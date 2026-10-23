---
name: krun-development
description: Use when starting any krun task or session. Routes to the krun-* and stack skills for the PLAN phase and restates the agent protocol and the Effect 4 / Zod 4 stack.
---

# krun development (router)

krun runs HTTP-triggered functions as one-off Kubernetes Jobs: a gateway
(three Fastify listeners inside an Effect program), a leader-elected
scheduler, Postgres or embedded SQLite, a `Function` CRD, a Helm chart,
Node.js and Python SDKs and a CLI (SPEC.md section 2). Load this skill first
in every session. It tells you the read order, the protocol, the stack rules,
which focused `krun-*` skill and which stack skills to load for the task you
pick, and which generic skills supply technique without overriding SPEC.

## When to use

Any work in the krun repository: picking the next PLAN task, implementing it,
reviewing a task branch, or answering a question about krun's design.

## Read order and session loop

1. Read completely, in order: `CLAUDE.md`, `docs/PROBLEM.md`, `SPEC.md`,
   `docs/API.md`, `docs/INTERNAL-API.md`, `docs/STACK.md`, `PLAN.md`,
   `docs/OPERATIONS.md` (CLAUDE.md:3, docs/AGENT-KICKOFF.md:13-15). Then PLAN
   section 6 (progress log) and `git log --oneline -20`; a task marked `[x]`
   must have a commit, a commit without `[x]` means the log is behind: fix
   the log first (docs/AGENT-KICKOFF.md:69-73).
2. Pick the first unchecked task in the lowest unfinished phase. Tasks run in
   order unless marked "parallel" (PLAN.md:9-12).
3. Restate the task's acceptance criterion in one line before coding; the
   acceptance test is written first (docs/AGENT-KICKOFF.md:33-34, 50).
4. Load the `krun-*` skill(s) and the stack skills from the routing table
   below (CLAUDE.md rule 7, docs/STACK.md section 5).
5. Implement, run the task's acceptance command and `make check`, mark `[x]`,
   append one progress-log line `YYYY-MM-DD P1.3 <sha> note`, commit the plan
   change with the code (PLAN.md:17-22).
6. Stop after a phase gate or after six tasks (docs/AGENT-KICKOFF.md:56).
   Final message: tasks done with short SHAs, gate status, BLOCKED items,
   Decisions rows added, next task id (docs/AGENT-KICKOFF.md:58-59).

## Protocol (non-negotiable)

- SPEC.md is the only source of truth for behaviour; docs/API.md and
  docs/INTERNAL-API.md are normative for the two HTTP contracts and
  docs/STACK.md for libraries. Code that contradicts SPEC needs a new row in
  SPEC.md section 15 first (PLAN.md:23-26, SPEC.md:3-5).
- Owner decisions never get an agent-written Decisions row: published package
  names beyond the P0.9 fallbacks, the public API shape, SPEC section 9
  policy, non-goals. Write `BLOCKED <task>: <need>` in the progress log and
  take the next independent task (PLAN.md:24-28).
- Dependencies: only PLAN.md section 2 / docs/STACK.md section 2-3. A new one
  needs a Decisions row with a one-line reason (PLAN.md:29-30). Token bucket,
  glob-to-regex, SSE on `reply.raw`, Lease election (a scoped Effect layer),
  the duration grammar (a Zod refinement into `Duration`) are written in
  house (PLAN.md:82-86).
- Build nothing in SPEC.md section 1 non-goals; add no options, flags or
  abstractions no task asks for (SPEC.md:19-24, PLAN.md:31-32). The server
  processes take no flags except `--help` (SPEC.md:1178); the CLI flags are
  the ones SPEC section 7.2 names.
- Branch named after the task id (`p1-3-claim`), Conventional Commits with the
  package as scope (`feat(store): ...`), PR to main merged when CI is green,
  never push main, only the owner tags `v*` (PLAN.md:13-22).
- Never add a `Co-Authored-By` trailer or any Claude attribution (CLAUDE.md
  rule 5, PLAN.md:16).
- Never commit secrets; tests generate their own keys (PLAN.md:33). Never log
  input, results, tokens or API keys (SPEC.md:1088-1089, 1149-1154).
- Tool checks at phase start; a missing tool is BLOCKED
  (docs/AGENT-KICKOFF.md:41-46).

## Stack (docs/STACK.md, SPEC D35, CLAUDE.md rules 6-8)

- TypeScript 7 (native `tsc`, emits `dist/`) strict on Node.js 24, ESM,
  pnpm workspace. Erasable syntax only: no `enum`, no parameter properties,
  no value namespaces; `import type` for types (`verbatimModuleSyntax`)
  (PLAN.md:42-44, docs/STACK.md section 3).
- Effect 4 (`effect` and `@effect/platform-node`, same `~4.0.x`) is the
  foundation of every process: entry `NodeRuntime.runMain(Layer.launch(Main))`;
  services are `Context.Service` (not `Context.Tag`), wiring is `Layer`,
  `Runtime<R>` is gone, `FiberRef` is `Context.Reference`. Core `effect`
  modules only; no `effect/sql`, `effect/http`, `effect/schema`,
  `effect/cli` (docs/STACK.md 2.1, 4.1).
- Errors: domain and infrastructure failures are `Data.TaggedError` classes;
  one function maps tags to the AIP-193 envelope, a defect is 500
  `INTERNAL`; no `throw` in application code outside adapters, which wrap
  promises with `Effect.tryPromise` (docs/STACK.md 4.2).
- SPEC rules map to Effect primitives (docs/STACK.md 4.3): `Semaphore` for
  `KRUN_K8S_CONCURRENCY`, `Effect.timeout` for every call bound,
  `Effect.retry`/`Effect.repeat` with `Schedule` for backoff and loops,
  `Stream` for informers, scope finalizers for SIGTERM order.
- Fastify 5 listeners are scoped layers (acquire: build and `listen`;
  release: readiness 503, drain, close); readiness is a small route over an
  Effect `Ref` (no `@fastify/under-pressure`); shutdown is `runMain` plus
  finalizers in reverse order (no `close-with-grace`).
- Zod 4 is the only schema language for krun's own schemas: routes through
  `fastify-type-provider-zod` 7 (`validatorCompiler`, `serializerCompiler`,
  `jsonSchemaTransform`), `z.strictObject` bodies, `.optional()` never
  `.nullable()`; the Function spec, config (a Zod schema over `process.env`
  exposed as an Effect Config service layer) and keys.yaml are Zod; CRD and
  OpenAPI are generated with `z.toJSONSchema`. Effect Schema is not used.
  Ajv (`Ajv2020`, strict, no `loadSchema`) compiles only user `inputSchema`.
- Time: application code never calls `Date.now()` or `new Date()`; use
  `Clock.currentTimeMillis`, `DateTime.now`, `DateTime.formatIso`, `Duration`;
  UUIDv7 via `uuid` `v7({ msecs })` with `msecs` from `Clock` (CLAUDE.md
  rule 8, docs/STACK.md 4.4).
- Data: Kysely 0.29 + `pg` + `better-sqlite3` inside an Effect `Database`
  service. Kubernetes: `@kubernetes/client-node` 2.x inside an Effect `Kube`
  service (semaphore, 10 s `Effect.timeout`, informers as `Stream`s).
- Tests: Vitest 5 with `@effect/vitest` (`it.effect`, which is already
  scoped in 4.x, `layer(...)`, `TestClock.adjust` from `effect/testing`),
  fast-check for properties, testcontainers for Postgres and MinIO; gates run
  `pnpm exec vitest run <dir>`. No real sleeps, no fake timers for Effect
  code (PLAN.md:49-51).
- The SDKs (`packages/sdk-node`, `sdk/python`) are dependency-free and
  Effect-free; the Node SDK's own tests run under Vitest as a dev dependency.
  `krun init` templates are the function author's project, not krun: keep
  them dependency-free (their own test may use `node --test`).

## Routing table

Every row also loads the six user-level `effect-*` skills listed below (the
SDK row excepted), `vitest` and `test-driven-development` for tests, and the
process skills `incremental-implementation`, `git-workflow-and-versioning`,
`code-review-and-quality` (docs/STACK.md section 5).

| PLAN tasks | krun skill | Stack skills (docs/STACK.md section 5) |
|---|---|---|
| P0.1-P0.4, P0.9, P4.12, P4.13, P5.4, P6.3, P7.6, P8.6, P9.1-P9.6 | `krun-testing-ci` | `pnpm`, `node`, `typescript-project-contracts`, `building-ci-pipelines`, `github-actions-advanced`, `dockerfile-optimise`, `testing-strategies`; P9 also `kubernetes-hardening`, `security-and-hardening` |
| P0.5, P0.7, P3.1b, P3.7, P4.6, P4.11 | `krun-process-runtime` plus the app skill | `zod-4`, `fastify-best-practices`, `node` |
| P0.8, P2.2, P2.3, P2.5, P4.7 | `krun-functions-crd` | `zod-4`, `kubernetes-operator`, `kubernetes-skill`; P2.5 also `building-clis` |
| P1.1-P1.11 | `krun-store` | `kysely`, `using-relational-databases` |
| P2.1, P5.3, P6.1, P6.2 | `krun-webhooks-objstore` | `security-and-hardening` |
| P2.4, P3.1a-P3.8, P5.1, P5.2 | `krun-gateway-api` | `fastify-best-practices`, `zod-4`, `designing-apis`, `api-and-interface-design`, `security-and-hardening` |
| P4.1-P4.5, P4.8-P4.11 | `krun-scheduler-k8s` | `kubernetes-operator`, `kubernetes-skill`, `operating-kubernetes` |
| P7.1-P7.7 | `krun-helm-chart` | `helm-chart-scaffolding`, `operating-kubernetes`, `kubernetes-hardening` |
| P8.1-P8.7 | `krun-sdk-cli` | `building-clis`, `python-patterns`, `python-type-system`, `pytest-advanced`; no `effect-*` for SDK code |
| Review prompt (docs/AGENT-KICKOFF.md:84-98) | the skill of the task under review, plus the review checklist below | `code-review-and-quality` |

Tasks that call into another component load that component's skill too (for
example P3.3 reads `krun-store` for `countQueued` and `krun-webhooks-objstore`
for the callback address check).

## Repository layout

Files land exactly where PLAN.md section 3 (PLAN.md:94-131) and the SPEC
paths say: `packages/shared/src/{config,store,functions,k8s,auth,health,
runtime,objstore,webhook}`, `packages/sdk-node`, `packages/cli`,
`sdk/python`, `apps/gateway`, `apps/scheduler`, `deploy/crds`,
`deploy/helm/krun`, `scripts`, `docs/api`,
`test/{e2e,fake-kube,sdk-conformance}`. Effect layers (Config, Logger,
Database, Kube, ObjectStore, Metrics) and the error-to-envelope mapping live
in `packages/shared/src/runtime` (PLAN.md:107). Tests sit next to the code as
`*.test.ts` (PLAN.md:133).

## Generic skills: technique only, SPEC and STACK win

Vendored in this repository under `.claude/skills/`, pinned by
`skills-lock.json`:

| Skill | Use it for | Do not let it |
|---|---|---|
| `fastify-best-practices` | plugin encapsulation, hooks, logging, testing with `inject` | change the error envelope (SPEC.md:218-224), add plugins outside PLAN section 2 (no `@fastify/under-pressure`, no TypeBox provider), or own the process: Fastify lives inside scoped Effect layers |
| `node` | streams, AbortSignal, ESM, `unref`, performance | introduce CJS, `node:test` as krun's runner, or raw `setTimeout`/`Date` in application code |
| `pnpm` | workspace, catalogs, `workspace:` protocol, `onlyBuiltDependencies` for `better-sqlite3` | add tooling PLAN does not list |
| `kysely` | query builder, `sql` tag, Migrator, dialects | replace the raw-SQL migrations or the literal-predicate rule (SPEC.md:535), or swap in `@effect/sql-kysely` (docs/STACK.md 2.3) |
| `vitest` | config per package, filtering, coverage, `vi` mocks for non-Effect adapters | use `vi.useFakeTimers` or real sleeps for Effect code: `TestClock` instead |
| `zod-4` | Zod 4 API, `z.strictObject`, `.meta`, `z.toJSONSchema`, v3-to-v4 differences | use `.nullable()` on API shapes, Zod 3 idioms, or a second schema library |
| `kubernetes-skill` | Job/Pod semantics, RBAC verbs, NetworkPolicy, PSA, probes | relax the jobs-namespace policy (SPEC.md:996-1047) |
| `kubernetes-operator` | reconcile and status-condition concepts (it is Go/controller-runtime) | make you add controller-runtime-style abstractions; krun uses `@kubernetes/client-node` informers as Effect `Stream`s and hand-written loops (SPEC.md:847-853) |
| `helm-chart-scaffolding` | chart hygiene, helpers, lint | render a Secret, ConfigMap or Function, or move the CRD to `crds/` (SPEC.md:1316, 1365-1380, D22) |

User-level (owner's machine; elsewhere work from docs/STACK.md and the
libraries' docs): `effect-core-patterns`, `effect-error-handling`,
`effect-dependency-injection`, `effect-resource-management`,
`effect-concurrency`, `effect-testing`. They predate Effect 4 in places:
Effect's `MIGRATION.md` and docs/STACK.md win. `Context.Tag` is
`Context.Service`, `Runtime<R>` is gone, `FiberRef` is `Context.Reference`;
in `effect` 4.0.6 there is no `Effect.fork` (`forkChild`, `forkScoped`,
`forkIn`, `forkDetach`), no `Layer.scoped` (`Layer.effect` takes scoped
acquisition), no `Either` module (`Result`), and `@effect/vitest` has no
`it.scoped` (`it.effect` is scoped). For any other name you are unsure of,
check Effect's `MIGRATION.md` rather than guess. Never load `effect-schema`
(Effect Schema is not used) or `backend-dev-guidelines` (Express/Prisma
conflicts with Fastify/Kysely).

Also useful: `test-driven-development`, `testing-strategies`,
`github-actions-advanced`, `dockerfile-optimise`,
`observability-and-instrumentation`, `api-security-best-practices`,
`security-and-hardening`, `pytest-advanced`. Any conflict between a generic
skill and a cited SPEC, PLAN or STACK line is resolved in favour of
SPEC/PLAN/STACK.

## Research behind the krun-* skills

Each `krun-*` skill absorbed evidence from KEDA (Job lifecycle, conditions),
knative/func (CLI templates, deploy, digest), Dapr (HTTP conventions, outbox,
shutdown, operator) and Knative Serving (conditions, drain, leader election,
validation), plus verified facts about the Node stack. Competitor citations in
the skills are `repo path:line`; the reports and shallow clones live outside
the repo (the authoring session's scratch directory) and are not required to
use the skills.

## Review checklist (for the review prompt)

Report only defects with path:line, severity, failure scenario and fix, in
this order (docs/AGENT-KICKOFF.md:89-98):

1. The task's acceptance criteria are proven by a test.
2. Behaviour matches SPEC.md (and docs/API.md, docs/INTERNAL-API.md) section
   by section for what the task touches.
3. No SPEC section 1 non-goal was built.
4. No dependency outside PLAN section 2.
5. No `Date.now()`, `new Date()` or bare `throw` in application code; Zod is
   the only schema library for krun's own schemas.
6. No secret, input, result, token or key reaches logs or manifests.
7. `make check` passes.
8. A behaviour change without a new Decisions row is a blocker.

## Ten invariants most often violated

1. Every state change is compare-and-set on `state = $from`; zero rows means a
   stale event, log at debug (SPEC.md:340-342).
2. A terminal transition inserts the `deliveries` row in the same transaction
   when `callback_url` is set, on every path: `transition`, `expireQueued`,
   heartbeat, `job_create_failed` (SPEC.md:347-350, D29).
3. `countByState`/`listByState` use the `runs_active_idx` predicate as literal
   SQL from one shared fragment, never bound parameters (SPEC.md:535).
4. Lease expiry is judged on the candidate's own clock (Effect `Clock`) from
   the last observed change of `holderIdentity`/`renewTime`, never
   `renewTime` vs now (SPEC.md:787-790).
5. `@kubernetes/client-node` informers have no resync and stop on error: the
   5-minute leader reconcile `Schedule` and restarting the watch with backoff
   are mandatory (SPEC.md:847-853, D33).
6. Heartbeat and `job_lost` start only after both informers' initial list and
   defer to the informer path when the cached Job is terminal
   (SPEC.md:779-781, 900-906, D33).
7. Terminal order: object-store check, CAS with final `jobStatus`,
   `failureReason`, `error`, `logTail`, `startTime` when missing, then delete
   Secret, then delete Job (background); `pods/log` always before any delete
   (SPEC.md:862-873, 896-899).
8. Per-run token hash stored before the Job exists; Secret immutable with no
   owner reference; `AlreadyExists` reads the existing token; `markScheduled`
   false deletes Job and Secret (SPEC.md:566-573, 820-825, D27).
9. Kubernetes error classification: 403 quota, 429, 5xx, network are
   transient (release lease, `2^n` backoff capped 60 s, honour `Retry-After`);
   any other 4xx is permanent `job_create_failed`; 404 on delete is success
   (SPEC.md:795-799, 827-836, D23).
10. Logs never contain input, result, runtimeStatus, error.details, tokens,
    keys, bodies, Job manifests or env lists (SPEC.md:1149-1154).

## Limitations

This skill routes and restates; the component rules live in the `krun-*`
skills and the authoritative text is SPEC.md, docs/API.md,
docs/INTERNAL-API.md and docs/STACK.md. Line numbers were taken from SPEC.md
and PLAN.md as of 2026-10-23; re-verify a citation before relying on it if
those files have changed.
