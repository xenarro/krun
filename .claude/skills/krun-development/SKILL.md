---
name: krun-development
description: Use when starting any krun task or session. Routes to the krun-* skill for the PLAN phase and restates the agent protocol.
---

# krun development (router)

krun runs HTTP-triggered functions as one-off Kubernetes Jobs: a Fastify
gateway, a leader-elected scheduler, Postgres or embedded SQLite, a `Function`
CRD, a Helm chart, Node.js and Python SDKs and a CLI (SPEC.md section 2).
Load this skill first in every session. It tells you the read order, the
protocol, which focused `krun-*` skill to load for the task you pick, and which
generic skills supply technique without overriding SPEC.

## When to use

Any work in the krun repository: picking the next PLAN task, implementing it,
reviewing a task branch, or answering a question about krun's design.

## Read order and session loop

1. Read completely, in order: `CLAUDE.md`, `docs/PROBLEM.md`, `SPEC.md`,
   `PLAN.md`, `docs/OPERATIONS.md` (CLAUDE.md:3, PLAN.md:9-11). Then PLAN
   section 6 (progress log) and `git log --oneline -20`; a task marked `[x]`
   must have a commit, a commit without `[x]` means the log is behind: fix
   the log first (docs/AGENT-KICKOFF.md:67-71).
2. Pick the first unchecked task in the lowest unfinished phase. Tasks run in
   order unless marked "parallel" (PLAN.md:9-11).
3. Restate the task's acceptance criterion in one line before coding; the
   acceptance test is written first (docs/AGENT-KICKOFF.md:33-34, 49).
4. Load the `krun-*` skill(s) from the routing table below.
5. Implement, run the task's acceptance command and `make check`, mark `[x]`,
   append one progress-log line `YYYY-MM-DD P1.3 <sha> note`, commit the plan
   change with the code (PLAN.md:16-19).
6. Stop after a phase gate or after six tasks (docs/AGENT-KICKOFF.md:54).
   Final message: tasks done with short SHAs, gate status, BLOCKED items,
   Decisions rows added, next task id (docs/AGENT-KICKOFF.md:56-57).

## Protocol (non-negotiable)

- SPEC.md is the only source of truth. Code that contradicts it needs a new
  row in SPEC.md section 15 first (PLAN.md:22-23, SPEC.md:3-5).
- Owner decisions never get an agent-written Decisions row: published package
  names beyond the P0.9 fallbacks, the public API shape, SPEC section 9
  policy, non-goals. Write `BLOCKED <task>: <need>` in the progress log and
  take the next independent task (PLAN.md:23-27).
- Dependencies: only PLAN.md section 2. A new one needs a Decisions row with a
  one-line reason (PLAN.md:28-29). Token bucket, glob-to-regex, SSE on
  `reply.raw`, Lease election and the API limiter are written in house
  (PLAN.md:69-73).
- Build nothing in SPEC.md section 1 non-goals; add no options, flags or
  abstractions no task asks for (SPEC.md:19-24, PLAN.md:30-31). Flags are
  unsupported except `--help` (SPEC.md:1160).
- Branch named after the task id (`p1-3-claim`), Conventional Commits with the
  package as scope (`feat(store): ...`), PR to main merged when CI is green,
  never push main, only the owner tags `v*` (PLAN.md:12-21).
- Never add a `Co-Authored-By` trailer or any Claude attribution (CLAUDE.md:7,
  PLAN.md:15).
- Never commit secrets; tests generate their own keys (PLAN.md:32). Never log
  input, results, tokens or API keys (SPEC.md:1070-1072, 1132-1137).
- TypeScript on Node.js 24, ESM, pnpm workspace; tests run with `node --test`
  on the `.ts` sources through type stripping, so only erasable syntax: no
  `enum`, no parameter properties, no value namespaces; `.ts` extensions in
  relative imports; `import type` for types (PLAN.md:37-40, CLAUDE.md:8).
- Tool checks at phase start; a missing tool is BLOCKED
  (docs/AGENT-KICKOFF.md:40-45).

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
| Review prompt (docs/AGENT-KICKOFF.md:79-95) | the skill of the task under review, plus the review checklist below |

Tasks that call into another component load that component's skill too (for
example P3.3 reads `krun-store` for `countQueued` and `krun-webhooks-objstore`
for the callback address check).

## Repository layout

Files land exactly where PLAN.md section 3 (PLAN.md:77-113) and the SPEC
paths say: `packages/shared/src/{config,store,functions,k8s,auth,health,
objstore,webhook}`, `packages/sdk-node`, `packages/cli`, `sdk/python`,
`apps/gateway`, `apps/scheduler`, `deploy/crds`, `deploy/helm/krun`,
`scripts`, `docs/api`, `test/{e2e,fake-kube,sdk-conformance}`. Tests sit next
to the code as `*.test.ts` (PLAN.md:115).

## Generic skills: technique only, SPEC wins

Installed project-level under `.agents/skills/` (third party, vetted):

| Skill | Use it for | Do not let it |
|---|---|---|
| `fastify-best-practices` | plugin encapsulation, hooks, schema compilation, logging, testing with `inject` | change the error envelope (SPEC.md:189-204) or add plugins outside PLAN section 2 |
| `node` | `node:test`, streams, AbortSignal, ESM, `unref`, performance | introduce CJS or a different test runner |
| `pnpm` | workspace, catalogs, `workspace:` protocol, `onlyBuiltDependencies` for `better-sqlite3` | add tooling PLAN does not list |
| `kysely` | query builder, `sql` tag, Migrator, dialects | replace the raw-SQL migrations or the literal-predicate rule (SPEC.md:547-549) |
| `kubernetes-skill` | Job/Pod semantics, RBAC verbs, NetworkPolicy, PSA, probes | relax the jobs-namespace policy (SPEC.md:981-1043) |
| `kubernetes-operator` | reconcile and status-condition concepts (it is Go/controller-runtime) | make you add controller-runtime-style abstractions; krun uses `@kubernetes/client-node` informers and hand-written loops (SPEC.md:836-841) |
| `helm-chart-scaffolding` | chart hygiene, helpers, lint | render a Secret, ConfigMap or Function, or move the CRD to `crds/` (SPEC.md:1348-1361, D22) |

Also useful from the user-level skill set: `test-driven-development`,
`testing-strategies`, `github-actions-advanced`, `dockerfile-optimise`,
`observability-and-instrumentation`, `api-security-best-practices`,
`security-and-hardening`, `pytest-advanced`. Do not load
`backend-dev-guidelines` (Express/Prisma/Zod conflicts with Fastify/TypeBox/
Kysely). Any conflict between a generic skill and a cited SPEC or PLAN line is
resolved in favour of SPEC/PLAN.

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
this order (docs/AGENT-KICKOFF.md:85-92):

1. The task's acceptance criteria are proven by a test.
2. Behaviour matches SPEC.md section by section for what the task touches.
3. No SPEC section 1 non-goal was built.
4. No dependency outside PLAN section 2.
5. No secret, input, result, token or key reaches logs or manifests.
6. `make check` passes.
7. A behaviour change without a new Decisions row is a blocker.

## Ten invariants most often violated

1. Every state change is compare-and-set on `state = $from`; zero rows means a
   stale event, log at debug (SPEC.md:367-369).
2. A terminal transition inserts the `deliveries` row in the same transaction
   when `callback_url` is set, on every path: `transition`, `expireQueued`,
   heartbeat, `job_create_failed` (SPEC.md:374-377, D29).
3. `countByState`/`listByState` use the `runs_active_idx` predicate as literal
   SQL from one shared fragment, never bound parameters (SPEC.md:547-549).
4. Lease expiry is judged on the candidate's own clock from the last observed
   change of `holderIdentity`/`renewTime`, never `renewTime` vs now
   (SPEC.md:778-780).
5. `@kubernetes/client-node` informers have no resync and stop on error: the
   5-minute leader reconcile timer and error handlers that restart the watch
   with backoff are mandatory (SPEC.md:836-841, D33).
6. Heartbeat and `job_lost` start only after both informers' initial list and
   defer to the informer path when the cached Job is terminal
   (SPEC.md:769-771, 892-894, D33).
7. Terminal order: object-store check, CAS with final `jobStatus`,
   `failureReason`, `error`, `logTail`, then delete Secret, then delete Job
   (background); `pods/log` always before any delete (SPEC.md:852-863,
   885-887).
8. Per-run token hash stored before the Job exists; Secret immutable with no
   owner reference; `AlreadyExists` reads the existing token; `markScheduled`
   false deletes Job and Secret (SPEC.md:581-586, 810-814, D27).
9. Kubernetes error classification: 403 quota, 429, 5xx, network are
   transient (release lease, `2^n` backoff capped 60 s, honour `Retry-After`);
   any other 4xx is permanent `job_create_failed`; 404 on delete is success
   (SPEC.md:784-789, 817-825, D23).
10. Logs never contain input, result, runtimeStatus, error.details, tokens,
    keys, bodies, Job manifests or env lists (SPEC.md:1132-1137).

## Limitations

This skill routes and restates; the component rules live in the `krun-*`
skills and the authoritative text is SPEC.md. Line numbers were taken from
SPEC.md and PLAN.md as of 2026-10-22; re-verify a citation before relying on
it if those files have changed.
