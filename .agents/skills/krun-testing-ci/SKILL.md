---
name: krun-testing-ci
description: Use when writing krun tests, e2e, Docker or CI workflows. Vitest + @effect/vitest, TestClock, fake Kube layer, testcontainers, kind, release.yml.
---

# krun testing, e2e, Docker, CI and release

Serves P0.1-P0.4, P0.7, P0.9, P4.11-P4.13, P5.4, P6.3, P7.6, P8.6,
P9.1-P9.6 and the test half of every other task. The task's app skill
owns the behaviour; this skill says how to prove it. Conflicts resolve in
favour of SPEC.md, then docs/STACK.md.

## When to use

-  Any task id above, or: vitest, TestClock, e2e, kind, Dockerfile, ci.yml,
  release.yml, testcontainers, fake-kube, phase gate, benchmark.
-  Acceptance test of any other task (test first,
  docs/AGENT-KICKOFF.md:33-34): load this skill plus the task's app skill
  (`krun-development` routing table).
-  Phase end: run the gate in `references/phase-gates.md`.

## Load alongside (do not restate them here)

-  Project skill `vitest` (`.agents/skills/vitest`, Vitest 5): config, CLI,
  projects, hooks, `vi` mocks, filtering. Runner only: Effect code still needs
  `it.effect` and `TestClock`.
-  User skills `effect-testing` (Effect 3: `it.scoped`, `it.scopedLive`,
  `import { TestClock } from "effect"` are v3 names; see "Effect 4 test
  idioms"), `test-driven-development`, `testing-strategies`, `pytest-advanced`
  (docs/STACK.md section 5 "Tests" row); `building-ci-pipelines`,
  `github-actions-advanced`, `dockerfile-optimise` ("Build and CI" row).
-  Effect's own docs beat any skill (CLAUDE.md rule 7):
  `node_modules/@effect/vitest/README.md`, `node_modules/effect/AGENTS.md`,
  Effect `MIGRATION.md`, `migration/v3-to-v4.md`.

## Read first

Line numbers drift; search by heading.

| Topic | Source |
|---|---|
| agent protocol | PLAN.md:7-34 |
| toolchain, allowlist | PLAN.md:36-90; tests PLAN.md:49-51; dev dependencies PLAN.md:76-78; Python tools PLAN.md:55; CI tools PLAN.md:56-57 |
| layout | PLAN.md:92-140; make targets PLAN.md:135-140 |
| docs/STACK.md | section 3 dev dependencies, tsconfig (STACK.md:154-187); 2.6 OpenTelemetry (STACK.md:99-113); 4 process shape, errors, SPEC-to-Effect map, time (STACK.md:189-260); 6 upgrade policy (STACK.md:293-300) |
| decisions | SPEC D15 (TypeScript 7 on Node.js 26), D35 (Vitest with `@effect/vitest`), D36 (`node:sqlite`, OpenTelemetry, Kubernetes 1.33, Postgres 16 floor, CI on 18), SPEC.md section 15; section 14 supported versions (krun Node 26, Node SDK Node 22 or newer); CLAUDE.md rules 6-8 |
| phase gates | PLAN.md section 4, quoted per phase in `references/phase-gates.md` |
| tasks | P0.1-P0.4 PLAN.md:148-178; P0.7 PLAN.md:191-197; P0.9 PLAN.md:213-222; P4.11-P4.13 PLAN.md:592-614; P5.4 PLAN.md:646-649; P6.3 PLAN.md:668-670; P7.6 PLAN.md:758-771; P8.6 PLAN.md:830-837; P9.1-P9.6 PLAN.md:852-897 |
| SPEC | SPEC.md:19-24 non-goals; SPEC.md:54-55 one image, four entrypoints; SPEC.md:1087-1089 and 1149-1154 what logs never contain; SPEC.md:1161-1174 health, SIGTERM order; SPEC.md:1091-1096 and 1410-1417 signing, release; SPEC.md:1419-1436 limits, NetworkPolicy-CNI requirement; docs/PROBLEM.md:74-86 success criteria |

## Rules

1.  Write the acceptance test before the code. A task without a passing test
   is not done (docs/AGENT-KICKOFF.md:33-34, PLAN.md:17-18).
2.  Every krun TypeScript package tests with Vitest 5. Test Effect code with
   `@effect/vitest` (`it.effect`, `layer(...)`). Never use `Effect.runPromise`
   in a plain `it` when `TestClock` or another test service matters: it runs
   on the live clock, so a 10 s timeout really waits, or Vitest's 5 s test
   timeout fires first (STACK.md section 3, SPEC D35). Only exception: the
   generated Node template's own test runs with `node --test`; it belongs to
   the function author's project (`krun-sdk-cli`,
   `references/properties-and-sdk.md`).
3.  No test sleeps (STACK.md:199). Time moves only through `TestClock.adjust`
   / `TestClock.setTime`. Never use `vi.useFakeTimers` on Effect code: it does
   not move `TestClock`. Real waiting is allowed only against a real external
   system (process tests, testcontainers, kind), and only through a bounded
   tri-state poll, never a fixed sleep.
4.  Application code never calls `Date.now()` or `new Date()` (CLAUDE.md rule
   8). `TestClock` does not move `Date`: one stray call makes lease and
   heartbeat tests pass locally and flake in CI.
5.  Tests sit next to the code as `*.test.ts` (PLAN.md:133). Cross-package
   fixtures live under `test/` (PLAN.md:125-127). e2e files are
   `test/e2e/*.e2e.ts`, outside Vitest's default include.
6.  Tests generate their own keys, tokens and secrets at runtime. Never commit
   one (PLAN.md:33, docs/AGENT-KICKOFF.md:35-36).
7.  No dependency outside PLAN.md:58-78. sinon, nock, msw, jest, supertest
   need a Decisions row (PLAN.md:29-30). Effect test layers, Vitest `vi`,
   Fastify `inject`, `http.createServer` and `test/fake-kube` cover every case
   the plan names.
8.  Swap services, not modules. Every boundary (`Kube`, `Database`/`Store`,
   `ObjectStore`, `Config`, metrics) is a `Context.Service`; a test provides a
   test `Layer` (STACK.md:10-14). `vi.mock` of an application module is a
   smell; `vi.fn` inside a test layer is fine.
9.  Assert exact strings and ordered call lists, not "called at least once".
   Scheduler tests record `[verb, resource, name]` actions in the fake `Kube`
   layer and compare the ordered list; SPEC fixes the order (SPEC.md:863-875
   terminal, 906-911 heartbeat).
10.  Assert typed failures as values: `Effect.flip` / `Effect.exit`, then
    compare the `_tag` (`QueueFull`, `KubeApiError` with `status`). Never
    match a message substring (STACK.md:162-173).
11.  A wait helper remembers a read error; it never treats one as "zero
    objects". Guard every "wait until none" with a positive precondition, so a
    broken API server cannot pass a test.
12.  Polling predicates are tri-state: keep waiting, done, or fail now with
    the last observed object. Never burn the timeout on a state that is
    already wrong.
13.  A test that needs Docker (testcontainers) fails when Docker is absent. It
    never skips silently.
14.  One e2e file per failure mode krun classifies. Each file has its own
    uniquely named Function and its own cleanup.
15.  Every `make e2e` runs the NetworkPolicy enforcement probe. Without it the
    isolation claims in SPEC.md section 9 are unproven (SPEC.md:1434-1435,
    PLAN.md:605-606).
16.  e2e asserts what logs and manifests must not contain (input, tokens,
    presigned URLs) as a positive grep-for-absence test (SPEC.md:1087-1089,
    1149-1154; docs/PROBLEM.md:82). Never assert on a log line containing
    input, results, tokens or keys: the test would then carry a value SPEC
    says must never appear.
17.  Scheduler downtime in upgrade and drill scenarios stays below
    `KRUN_TTL_AFTER_FINISHED` (SPEC.md:914-919, 1416-1417).
18.  The agent never resolves P0.9 owner preconditions (npm scope, PyPI name,
    GHCR owner, OIDC publishing): write BLOCKED (PLAN.md:23-28, 213-217).
19.  Never add a `Co-Authored-By` trailer (CLAUDE.md rule 5, PLAN.md:16).
    Never push main directly (PLAN.md:21-22).

## Runner and type checking

| Scope | Command | Notes |
|---|---|---|
| all TS | `pnpm -r exec vitest run` from `make test` | PLAN.md:51; each package has its own `vitest.config.ts` (P0.1, PLAN.md:155) |
| a phase gate path | `pnpm exec vitest run packages/shared/src/store` | PLAN.md:226; runs from the root, so the root `vitest.config.ts` lists the package configs in `test.projects` (`.agents/skills/vitest/references/advanced-projects.md`); confirm in P0.1 that per-package settings apply (UNVERIFIED) |
| one package | `pnpm --filter <pkg> exec vitest run` | |
| Python SDK | `uv run --directory sdk/python pytest` | part of `make test` (PLAN.md:137-138); runs the `hypothesis` properties (`references/properties-and-sdk.md`) |
| lint | `biome check` + `tsc --noEmit` per package | `make lint` (PLAN.md:161-162) |
| unused code | `pnpm exec knip` | in `make check` from P0.4 (PLAN.md:176-178, STACK.md section 3); list test files, `scripts/`, `test/fake-kube` and `test/e2e` as entry points in `knip.json`, or knip reports them unused |
| Python lint | `ruff check` and `mypy --strict` under `uv run --directory sdk/python` | STACK.md section 3; wire into `make lint` in P0.1, enforce from P8.2 |
| e2e | `pnpm exec vitest run --config test/e2e/vitest.config.ts` from `make e2e` | real time; `references/kind-recipe.md` "Harness" |

-  Vitest 5 defaults (verified in the 5.0.5 tarball,
  `dist/chunks/defaults.*.js`, `index.*.js`): include
  `**/*.{test,spec}.?(c|m)[jt]s?(x)`, `pool: "forks"`, `isolate: true`,
  `clearMocks: true`, `testTimeout` 5000 ms, `hookTimeout` 10000 ms. Keep
  forks and isolation. Set `include: ["src/**/*.test.ts"]` per package so
  `dist/` is never collected.
-  `pnpm -r exec` skips the workspace root. Tests under `scripts/` or
  `test/fake-kube` need a root project that `make test` runs explicitly (never
  `test/e2e`, which has its own config).
-  Vitest does not type-check: `tsc --noEmit` in `make lint` is the type gate.
  tsconfig flags: STACK.md:120-125 (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `nodenext`, `es2025`,
  erasable syntax only).
-  A test importing another workspace package by name resolves through the
  `workspace:` link to that package's `exports`. If those point at `dist/`,
  `make test` must build first, or the test runs stale code. Decide in P0.1.
-  `vitest run` with no matching files exits non-zero ("No test files found");
  one such package fails the whole `make test`. Set `passWithNoTests: true`
  until a package's first test exists. P4.12's "`make e2e` with zero
  scenarios" needs the same, or the enforcement probe as the first e2e file.
-  Vitest 5 has no `test.sequential`. Use `{ concurrent: false }` on suites
  sharing state (`@effect/vitest` README "Migrating to Vitest 5").

## Effect 4 test idioms

Verified against the `@effect/vitest` 4.0.6 and `effect` 4.0.6 tarballs.

| Need | Write | Why |
|---|---|---|
| unit test of an Effect | `it.effect("name", () => Effect.gen(function*() { ... }))` | provides `TestClock` + `TestConsole` and a fresh `Scope` closed after the test |
| resource in a test | `yield* Effect.acquireRelease(...)` inside `it.effect` | no `it.scoped` in 4.0.6; the test already has a scope; do not wrap in `Effect.scoped` (README "Resource Safety and Scope") |
| real clock | `it.live` | process tests, real `pg` timeouts |
| shared service for a block | `layer(SomeLayer)("block", (it) => { it.effect(...) })` | built once, closed in `afterAll`; state persists between tests in the block, so a seeded fake leaks into the next test: use `Effect.provide(FakeKube.layer(row.seed))` per table row |
| slow layer (container) | `layer(PgLayer, { timeout: "2 minutes" })` | the option is the hook timeout for build and close |
| time | `import { TestClock } from "effect/testing"`; `yield* TestClock.adjust("10 seconds")` | TestClock starts at 0; `TestClock.setTime(ms)` for a fixed epoch |
| fork then step | `const f = yield* Effect.forkChild(loop)`, then `TestClock.adjust`, then `Fiber.join` or inspect | v4 name is `forkChild`; adjusting before the fork fires nothing and the test "passes" on initial state |
| typed failure | `const e = yield* Effect.flip(program)`; `expect(e._tag).toBe("QueueFull")` | rule 10 |
| Effect hooks | `beforeAll`/`beforeEach` from `@effect/vitest` accept an Effect with its own scope | |

-  `Effect.timeout` fires on `TestClock.adjust`. That tests the 10 s
  Kubernetes call bound, the 5 s store bound and the 2 s readiness check
  without waiting (STACK.md:180; P0.7 PLAN.md:196-197).
-  `TestClock` gotcha (`TestClock.d.ts`): sleeps registered after several
  scheduler hops run in order only for fibers under `TestClock.layer()`, which
  `it.effect` installs. A clock built by hand with `TestClock.make` does not.
  Let the loop reach its first sleep (`Effect.yieldNow`) before the first
  `adjust` (dapr `pkg/apphealth/health_test.go:135-145`).
-  UUIDv7 ids come from `v7({ msecs })` with `Clock` (STACK.md:82). Under
  `TestClock` ids are deterministic, so golden files may contain them.
-  Do not use `it.prop` / `it.effect.prop`: they take Effect `Schema` or
  `effect/Arbitrary` (unstable); krun has one schema language (Zod,
  STACK.md:15-20). Property tests use fast-check directly (STACK.md:109).
-  `@effect/vitest` 4.0.6 peers `vitest >=5.0.0 <6.0.0`, `effect ^4.0.6`.
  Exports `it`, `effect`, `live`, `layer`, `flakyTest`, `prop`, `makeMethods`,
  Effect-aware `beforeAll`/`beforeEach`, re-exported Vitest; no
  `scoped`/`scopedLive` (VERIFIED, `dist/index.d.ts`). All are
  `@stability unstable`; STACK.md section 3 pins `~4.0.6` with `effect` in
  lockstep (STACK.md:233-234).
-  `NodeRuntime.runMain` turns SIGTERM into interruption and runs the
  finalizers (STACK.md:43). Exit code 0 for an interrupt-only exit is
  UNVERIFIED for 4.0.6 (`@effect/platform-node-shared` not inspected): P3.7
  asserts it.

## Test doubles

| Double | Used by | Shape |
|---|---|---|
| fake `Kube` layer | P2.3, P4.2, P4.3a-c, P4.4, P4.5, P4.7-P4.10 (PLAN's "stubbed `CoordinationV1Api`/`BatchV1Api`/`CoreV1Api`/`pods/log`") | `Layer` over a `Ref` of objects plus an ordered action log; scripted failures as `KubeApiError` with `status`; informers as `Stream`s the test feeds; table-driven rows, `references/fake-kube.md` part 1 |
| in-memory `Store` layer | P3.x handler tests, P5.1 | implements the `Store` service from `krun-store`; a stalled method is `Effect.never`, then `TestClock.adjust("5 seconds")` for 503 `NOT_READY` (PLAN.md:452, 458-459) |
| fake object store layer | P3.6, P4.4, P6.2 | `{ exists, presignPut, presignGet }` recording calls; scripted `ObjectStoreError` |
| `test/fake-kube` | P3.7, P4.6, P4.11 process tests (PLAN.md:436-441, 558-566, 596-599) | `http.createServer` Kubernetes API over in-memory objects, kubeconfig per test (`references/fake-kube.md` part 2) |
| in-memory span exporter | P4.6 (PLAN.md:558-566), P0.7 | `InMemorySpanExporter` in a test `Telemetry` layer; span and `/metrics` assertions in `references/fake-kube.md` part 3 |
| local HTTP receiver | P5.3, P8.1-P8.3 | `http.createServer` on port 0 with scripted responses (500 then 200, 302, 429, hang) (PLAN.md:642-645, 793-803) |
| Fastify `inject` | P0.7, P3.x, P5.x | the listener layer builds the app; tests call `app.inject` inside `it.effect` via `Effect.promise` |

-  Unit tests touching Kubernetes use the fake `Kube` layer (in-process, under
  `TestClock`), never `test/fake-kube` (process tests only; build first:
  `bin/krun.js` dispatches to `dist/`).
-  SQLite tests: `fs.mkdtemp` under `os.tmpdir()`, removed after the suite
  (PLAN.md:227-228) or by an `Effect.acquireRelease` finalizer. In memory for
  gateway handler tests (PLAN.md:365-366).
-  Postgres and MinIO run through testcontainers 12 as scoped layers:
  `PostgreSqlContainer` from `@testcontainers/postgresql`, `MinioContainer`
  from `@testcontainers/minio` (built-in wait on `/minio/health/live` port
  9000, `getConnectionUrl()`, default user and password `minioadmin`,
  `withUsername`/`withPassword`; verified in the 12.2.1 tarballs). Acquire
  with
  `Effect.acquireRelease(Effect.promise(() => new PostgreSqlContainer(IMAGES.postgres).start()), (c) => Effect.promise(() => c.stop()))`
  inside `Layer.effect` (scoped in Effect 4; there is no `Layer.scoped`);
  share it with `layer(...)`. Pin image tags or digests in one constants file
  for Renovate. `IMAGES.postgres` is `postgres:18` by digest (PLAN Phase 1
  gate); 16 is only the supported floor (SPEC.md section 14), not run in CI.
  Ryuk in CI: `references/ci-release.md`.

## References

| File | Holds |
|---|---|
| `references/phase-gates.md` | every gate verbatim from PLAN.md, with the command and what "green" means |
| `references/fake-kube.md` | fake `Kube` layer, table-driven reconciler tests; `test/fake-kube` HTTP server; span exporter and `/metrics` assertions; `@kubernetes/client-node` 2.0.1 facts (`ApiException`, the `http:` kubeconfig rule, informer stop-on-error, per-call signal) |
| `references/kind-recipe.md` | `make kind-up` with the local registry on `localhost:5001`, enforcement probe, raw jobs-namespace manifests until P7.6, MinIO egress, chart switch, e2e harness, wait helpers |
| `references/e2e-scenarios.md` | scenario catalogue per phase with the assertion each must make |
| `references/ci-release.md` | build facts (`vitest`, `typescript`, testcontainers engines; no native addons, D36; pnpm `allowBuilds`), Dockerfile, `ci.yml` jobs, Trivy and audit flags, `renovate.json`, `release.yml`, cosign, syft, OIDC, owner preconditions, benchmarks |
| `references/lessons.md` | KEDA, Knative and Dapr test patterns with source citations and their krun form |
| `references/properties-and-sdk.md` | fast-check properties; Effect-free SDK and template suites (Vitest fake timers for `packages/sdk-node`, `pytest` + `mypy --strict` for `sdk/python`, `test/sdk-conformance`) |

## Pitfalls

-  `KRUN_WEBHOOK_ALLOWED_CIDRS` must list the kind pod and Service CIDRs, or
  the in-cluster receiver is rejected `CALLBACK_NOT_ALLOWED` (PLAN.md:
  621-623, SPEC.md:1472 D31).
-  `pnpm audit` and Trivy failures: fix, never suppress
  (`references/ci-release.md` "`ci.yml`").
-  `kindest/node` older than 1.33 fails P7.4d and Litestream scenarios like a
  krun bug (PLAN.md:55). `helm/kind-action` and local `kind` must match
  (PLAN.md:56-57). Both: `references/kind-recipe.md`.
-  CI covers `node:sqlite` on Node 26 only if every job reads `.node-version`,
  never a hard-coded `node-version`. Only exception: the `sdk-node` matrix job
  (Node 22 and 26, `references/ci-release.md`).
-  The `digest:` line of `docker push` output is the only source of an image
  digest (P8.6, PLAN.md:830-832); never the local image id.
-  P9.4 quickstart timeout: 1800 s per mode (PLAN.md:880-884). P9.3 benchmark
  numbers come from kind on the CI runner; the README must say so.

## Before marking a task done

-  Run the task's acceptance command from PLAN.md, then `make check`
  (PLAN.md:17-18). e2e tasks: `make e2e` green locally and in CI.
-  Phase end: run the gate in `references/phase-gates.md`.
-  Append `YYYY-MM-DD <task> <sha> note` to PLAN.md section 6; commit it with
  the code (PLAN.md:19-20). Branch, commit and pull request protocol:
  PLAN.md:13-16, 21-22.
