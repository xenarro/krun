---
name: krun-development
description: Use when starting any krun task or session. Routes to the krun-* skill for the PLAN phase and restates the agent protocol.
---

# krun development (router)

krun runs HTTP-triggered functions as one-off Kubernetes Jobs: a Fastify
gateway, a leader-elected scheduler, Postgres or embedded SQLite, a `Function`
CRD, a Helm chart, Node.js and Python SDKs and a CLI (SPEC.md section 2).
The processes are Effect 4 programs with Fastify 5 as the HTTP engine and
Zod 4 as the only schema language (SPEC D35, docs/STACK.md). Load this skill
first in every session: read order, protocol, which focused `krun-*` skill
to load for the task, and which generic skills supply technique.

## When to use

Any work in the krun repository: picking the next PLAN task, implementing
it, reviewing a task branch, or answering a design question.

## Read order and session loop

1. Read completely, in order: SPEC.md, docs/API.md, docs/INTERNAL-API.md,
   docs/STACK.md, PLAN.md, docs/OPERATIONS.md (CLAUDE.md:3, PLAN.md:9-10).
   docs/PROBLEM.md says why krun exists; docs/AGENT-KICKOFF.md holds the
   session prompts.
2. Read PLAN section 6 (progress log) and `git log --oneline -20`. A task
   marked `[x]` must have a commit; a commit without `[x]` means the log is
   behind: fix the log first (docs/AGENT-KICKOFF.md, resume prompt).
3. Pick the first unchecked task in the lowest unfinished phase; tasks run
   in order unless marked "parallel" (PLAN.md:10-12).
4. Restate the task's acceptance criterion in one line; write that test
   first (docs/AGENT-KICKOFF.md, kickoff rule 5).
5. Load the `krun-*` skill(s) from the routing table and the generic skills
   docs/STACK.md section 5 lists for the area (CLAUDE.md:9).
6. Implement, run the acceptance command and `make check`, mark `[x]`,
   append `YYYY-MM-DD P1.3 <short sha> note` to the progress log, commit
   the plan change with the code (PLAN.md:16-21).
7. Stop after a phase gate or six tasks. Final message: tasks done with
   short SHAs, gate status, BLOCKED items, Decisions rows added, next task.

## Protocol (non-negotiable)

- SPEC.md is the source of truth for behaviour; docs/API.md and
  docs/INTERNAL-API.md are normative for the two HTTP contracts (D34, D24);
  docs/STACK.md is normative for libraries and idioms (D35). Code that
  contradicts any of them needs a new SPEC section 15 row first
  (PLAN.md:23-24).
- Owner decisions never get an agent-written Decisions row: published
  package names beyond the P0.9 fallbacks, the public API shape, SPEC
  section 9 policy, non-goals. Write `BLOCKED <task>: <need>` and take the
  next independent task (PLAN.md:24-28).
- Dependencies: only docs/STACK.md (PLAN section 2 points there). A new one
  needs a Decisions row (PLAN.md:29-30, docs/STACK.md:4-6).
- Build nothing in SPEC section 1 non-goals; add no options, flags or
  abstractions no task asks for (SPEC.md:19-24, PLAN.md:31-32).
- Branch per task id (`p1-3-claim`), Conventional Commits with the package
  as scope, PR to main merged on green CI, never push main, only the owner
  tags `v*` (PLAN.md:13-21).
- Never add a `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7).
- Never commit secrets; tests generate their own keys (PLAN.md:33). Never
  log input, results, tokens or keys (SPEC section 11).
- Never call `Date.now()` or `new Date()` in application code; use Effect
  `Clock` and `DateTime`; tests use `TestClock`, never sleep (CLAUDE.md:10,
  docs/STACK.md section 4.4).
- No `throw` outside adapters; domain and infrastructure failures are
  `Data.TaggedError`s; adapters wrap promises with `Effect.tryPromise`
  (docs/STACK.md section 4.2).
- Effect 4 `MIGRATION.md` and `node_modules/effect/AGENTS.md` override any
  skill text written for Effect 3: `Context.Tag` is `Context.Service`,
  `Runtime<R>` is gone, `FiberRef` is `Context.Reference` (CLAUDE.md:9,
  docs/STACK.md:210-213).

## Routing table

| PLAN tasks | Load |
|---|---|
| P0.1-P0.4, P0.9, P4.12, P4.13, P5.4, P6.3, P7.6, P8.6, P9.1-P9.6 | `krun-testing-ci` |
| P0.5, P0.7, P3.1b, P3.7, P4.6, P4.11 | `krun-process-runtime` plus the app skill |
| P0.8, P2.2, P2.3, P2.5, P4.7 | `krun-functions-crd` |
| P1.1-P1.11 | `krun-store` |
| P2.1, P5.3, P6.1, P6.2 | `krun-webhooks-objstore` |
| P2.4, P3.1a-P3.8, P5.1, P5.2 | `krun-gateway-api` |
| P4.1-P4.5, P4.8-P4.11 | `krun-scheduler-k8s` |
| P7.1-P7.7 | `krun-helm-chart` |
| P8.1-P8.7 | `krun-sdk-cli` |
| Review prompt (docs/AGENT-KICKOFF.md) | the skill of the task under review, plus the checklist below |

Tasks that call into another component load that component's skill too
(P3.3 reads `krun-store` for queue counts and `krun-webhooks-objstore` for
the callback address check).

## SPEC rules mapped to Effect (docs/STACK.md section 4.3)

| SPEC rule | Effect construct |
|---|---|
| `KRUN_K8S_CONCURRENCY` cap | `Semaphore` around every Kubernetes call |
| 10 s per API call, 5 s per internal store call, 2 s readiness check | `Effect.timeout` |
| retries with backoff | `Effect.retry` with `Schedule.exponential` and `Schedule.recurs` |
| main loop 1 s, sweep 10 min, heartbeat 10 s | `Effect.repeat` with `Schedule.spaced` |
| coalesced `state` notifies, no overlapping iterations | one loop fiber on a sliding `Queue` of capacity 1 |
| 10 s iteration deadline | `Effect.timeout`, leases released in `Effect.ensuring` |
| leader election | scoped layer whose renew fiber interrupts the leader scope on loss |
| informers | `Stream` over client-node informer events; reconcile timer is a `Schedule` |
| SIGTERM order | `NodeRuntime.runMain` and scope finalizers |
| leases, deadlines, staleness | `Clock`, `DateTime`; `TestClock` in tests |
| durations in config and CRD | Zod refinement of `^\d+(ms|s|m|h)$` into `Duration` |

Exceptions: `@krun/sdk` stays dependency-free and Effect-free (plain
`fetch`, `setInterval(...).unref()`); the Python SDK is stdlib only
(docs/STACK.md principle 6). Ajv compiles only user `inputSchema`; every
krun schema is Zod (principles 2-3).

## Generic skills: technique only, SPEC and STACK win

Vendored project-level under `.agents/skills/` and `.claude/skills/`
(pinned by `skills-lock.json`):

| Skill | Use it for | Do not let it |
|---|---|---|
| `fastify-best-practices` | plugin encapsulation, hooks, logging, `inject` | change the AIP-193 envelope or add plugins outside STACK |
| `zod-4` | Zod 4 API, `z.strictObject`, refinements, v3 to v4 changes | introduce `.nullable()` on API shapes (STACK 2.1 rule) |
| `vitest` | Vitest 5 config, CLI, mocking, concurrency | replace `@effect/vitest` `it.effect` / `TestClock` for Effect code |
| `kysely` | query builder, `sql` tag, Migrator, dialects | replace raw-SQL migrations or the literal partial-index predicate |
| `node` | streams, ESM, AbortSignal, process behaviour | add CJS or reintroduce `node:test` |
| `pnpm` | workspace, catalogs, `onlyBuiltDependencies` for `better-sqlite3` | add tooling STACK does not list |
| `kubernetes-skill` | Job/Pod semantics, RBAC, NetworkPolicy, PSA, probes | relax the jobs-namespace policy (SPEC section 9) |
| `kubernetes-operator` | reconcile and status-condition concepts (Go/controller-runtime) | add controller-runtime-style frameworks; krun wraps client-node informers as Effect Streams |
| `helm-chart-scaffolding` | helpers, lint, values schema hygiene | render a Secret, ConfigMap or Function, or move the CRD to `crds/` (D22) |

User-level skills docs/STACK.md section 5 names: `effect-core-patterns`,
`effect-error-handling`, `effect-dependency-injection`,
`effect-resource-management`, `effect-concurrency`, `effect-testing`
(Effect 3 era: MIGRATION.md wins), `using-relational-databases`,
`typescript-project-contracts`, `operating-kubernetes`,
`kubernetes-hardening`, `designing-apis`, `api-and-interface-design`,
`security-and-hardening`, `test-driven-development`, `testing-strategies`,
`pytest-advanced`, `building-ci-pipelines`, `github-actions-advanced`,
`dockerfile-optimise`, `building-clis`, `python-patterns`,
`python-type-system`, `incremental-implementation`,
`git-workflow-and-versioning`, `code-review-and-quality`. Do not load
`backend-dev-guidelines` (Express/Prisma conflicts).

## Research behind the krun-* skills

The `krun-*` skills absorbed source-cited evidence from KEDA (ScaledJob Job
lifecycle, status conditions, controller hygiene), knative/func (templates,
build-push-digest-apply-wait, CLI testing), Dapr (HTTP conventions, outbox
vs same-transaction delivery, shutdown ordering, operator informers) and
Knative Serving (condition sets, observedGeneration, drain, leader
election, validation messages, table-driven reconciler tests). Citations
are `repo path:line` at pinned commits; the reports live outside the repo
and are not needed to use the skills.

## Review checklist

Report only defects with path:line, severity, failure scenario and fix:

1. The task's acceptance criteria are proven by a test.
2. Behaviour matches SPEC.md, docs/API.md, docs/INTERNAL-API.md section by
   section for what the task touches.
3. No SPEC section 1 non-goal was built.
4. No dependency or idiom outside docs/STACK.md (no `Date.now()`, no
   `throw` outside adapters, no second schema language).
5. No secret, input, result, token or key reaches logs or manifests.
6. `make check` passes.
7. A behaviour change without a new Decisions row is a blocker.

## Ten invariants most often violated

1. Every state change is compare-and-set on `state = $from`; zero rows is a
   stale event, log at debug (SPEC section 5).
2. A terminal transition inserts the `deliveries` row in the same
   transaction when a callback is set, on every path: transition,
   queue expiry, heartbeat, job-create failure (SPEC section 5, D29).
3. Active-run counts use the partial-index predicate as literal SQL from
   one shared fragment, never bound parameters (SPEC section 6).
4. Lease expiry is judged on the candidate's own clock from the last
   observed change of `holderIdentity`/`renewTime` (SPEC section 8).
5. client-node informers have no resync and stop on error: the 5-minute
   reconcile and restart-with-backoff are mandatory (SPEC section 8, D33).
6. Heartbeat and job-lost checks start only after both informers' initial
   list and defer to the informer path for terminal cached Jobs (D33).
7. Terminal order: object-store check, CAS with final job status, failure
   reason, error and log tail, then delete Secret, then delete Job; pod
   logs always fetched before any delete (SPEC section 8, D28).
8. Per-run token hash stored before the Job exists; Secret immutable with
   no owner reference; `AlreadyExists` reads the existing token (D27).
9. Kubernetes errors: 403 quota, 429, 5xx, network are transient; any other
   4xx is permanent `job_create_failed`; 404 on delete is success (D23).
10. Logs never contain input, result, runtime status, error details,
    tokens, keys, bodies, Job manifests or env lists (SPEC section 11).

## Limitations

This skill routes and restates; component rules live in the `krun-*`
skills and the authoritative text is SPEC.md, docs/API.md,
docs/INTERNAL-API.md and docs/STACK.md. Section references are used here
instead of line numbers because those files are still being edited;
re-verify any line citation in a component skill before relying on it.
