---
name: krun-testing-ci
description: Use when writing krun tests, e2e, Docker or CI workflows. Vitest + @effect/vitest, TestClock, fake Kube layer, testcontainers, kind, release.yml.
---

# krun testing, e2e, Docker, CI and release

Owns the test harness of krun: Vitest 5 with `@effect/vitest` over the
TypeScript packages, `pytest` plus `mypy --strict` over `sdk/python`, the
test doubles (a fake `Kube` service layer, in-memory `Store` layer,
`test/fake-kube`, local HTTP receivers), `TestClock`, fast-check property
tests, testcontainers, the phase gates, the kind e2e recipe and scenario
catalogue, the Dockerfile, `ci.yml` and `release.yml`. Serves PLAN tasks
P0.1-P0.4, P0.7, P0.9, P4.11-P4.13, P5.4, P6.3, P7.6, P8.6, P9.1-P9.6 and
the test half of every other task. Behaviour under test is owned by the
sibling skill of that task; this skill says how to prove it.

## When to use

- Any task id above, or the words vitest, TestClock, e2e, kind, Dockerfile,
  ci.yml, release.yml, testcontainers, fake-kube, phase gate, benchmark.
- Writing the acceptance test of any other task (test first,
  docs/AGENT-KICKOFF.md:33-34): load this skill plus the task's app skill
  (`krun-development` routing table).
- A phase end: run the gate from `references/phase-gates.md`.

## Load alongside (do not restate them here)

- Project skill `vitest` (`.agents/skills/vitest`, Vitest 5): config,
  CLI, projects, hooks, `vi` mocks, filtering. Use it for the runner; it
  does not replace `it.effect` and `TestClock` for Effect code.
- User skills `effect-testing` (written for Effect 3: `it.scoped`,
  `it.scopedLive` and `import { TestClock } from "effect"` are v3 names; see
  "Effect 4 test idioms" below) and `test-driven-development`; plus
  `testing-strategies`, `pytest-advanced` (docs/STACK.md section 5 "Tests"
  row) and `building-ci-pipelines`, `github-actions-advanced`,
  `dockerfile-optimise` ("Build and CI" row).
- Effect's own docs win over any skill (CLAUDE.md rule 7):
  `node_modules/@effect/vitest/README.md`, `node_modules/effect/AGENTS.md`,
  Effect `MIGRATION.md` and `migration/v3-to-v4.md`.

## Read first

- PLAN.md:7-34 agent protocol; PLAN.md:36-90 toolchain and the allowlist
  (tests line PLAN.md:49-51, dev dependencies PLAN.md:76-78, Python tools
  PLAN.md:55, CI tools PLAN.md:56-57); PLAN.md:92-140 layout, `*.test.ts`
  next to code (PLAN.md:133), make targets (PLAN.md:135-140).
- docs/STACK.md section 3 (dev dependencies and tsconfig, STACK.md:102-132),
  section 4 (process shape, errors, SPEC-to-Effect map, time,
  STACK.md:134-199), section 6 (upgrade policy, STACK.md:231-238).
- SPEC.md:1476 D35 (Vitest with `@effect/vitest`, TypeScript 7, `node:test`
  dropped); CLAUDE.md rules 6-8.
- Phase gates: PLAN.md:146, 226-229, 317, 365-367, 469-481, 618-623,
  653-655, 674-678, 780-782, 849-850; definition of done PLAN.md:899-904
  (verbatim in `references/phase-gates.md`).
- Tasks: P0.1-P0.4 PLAN.md:148-178; P0.7 PLAN.md:191-197; P0.9
  PLAN.md:213-222; P4.11-P4.13 PLAN.md:592-614; P5.4 PLAN.md:646-649; P6.3
  PLAN.md:668-670; P7.6 PLAN.md:758-771; P8.6 PLAN.md:830-837; P9.1-P9.6
  PLAN.md:852-897.
- SPEC.md:19-24 non-goals; SPEC.md:54-55 one image, four entrypoints;
  SPEC.md:1087-1089 and 1149-1154 what logs never contain;
  SPEC.md:1161-1174 health and SIGTERM order; SPEC.md:1091-1096 and
  1410-1417 signing and release; SPEC.md:1419-1436 limits and the
  NetworkPolicy-CNI requirement; docs/PROBLEM.md:74-86 success criteria.
- docs/INTERNAL-API.md:326-371: the shell function every Phase 4 scenario
  image is shaped like.

## Rules

1. Write the acceptance test before the code; a task without a passing
   test is not done (docs/AGENT-KICKOFF.md:33-34, PLAN.md:17-18).
2. Every krun TypeScript package tests with Vitest 5; Effect code is
   tested with `@effect/vitest` (`it.effect`, `layer(...)`), never with
   `Effect.runPromise` in a plain `it` when a test service such as
   `TestClock` matters (STACK.md:107-108, SPEC.md:1476). `node:test` and
   `node --test` are gone for krun's own code (STACK.md:100).
3. No test sleeps (STACK.md:199). Time moves only through
   `TestClock.adjust` / `TestClock.setTime`, never `vi.useFakeTimers` on
   Effect code; real waiting is allowed only against a real external
   system (process tests, testcontainers, kind) and then through a bounded
   tri-state poll, never a fixed sleep.
4. Application code never calls `Date.now()` or `new Date()` (CLAUDE.md
   rule 8): `TestClock` does not move `Date.now()`, so one stray call makes
   lease and heartbeat tests pass locally and flake in CI.
5. Tests sit next to the code as `*.test.ts` (PLAN.md:133); cross-package
   fixtures live under `test/` (PLAN.md:125-127). e2e files are
   `test/e2e/*.e2e.ts`, outside Vitest's default include.
6. Tests generate their own keys, tokens and secrets at runtime; never
   commit one (PLAN.md:33, docs/AGENT-KICKOFF.md:35-36).
7. No dependency outside PLAN.md:58-78; sinon, nock, msw, jest, supertest
   need a Decisions row (PLAN.md:29-30). Effect test layers, Vitest `vi`,
   Fastify `inject`, `http.createServer` and `test/fake-kube` cover every
   case the plan names.
8. Swap services, not modules: every boundary (`Kube`, `Database`/`Store`,
   `ObjectStore`, `Config`, metrics) is a `Context.Service`, so a test
   provides a test `Layer` (STACK.md:10-14). `vi.mock` of an application
   module is a smell; `vi.fn` inside a test layer is fine.
9. Assert on exact strings and ordered call lists, not on "called at least
   once": scheduler tests record `[verb, resource, name]` actions in the
   fake `Kube` layer and compare the ordered list, because SPEC fixes the
   order (SPEC.md:863-875 terminal, 906-911 heartbeat).
10. Assert typed failures as values: `Effect.flip` / `Effect.exit` and
    compare the `_tag` (`QueueFull`, `KubeApiError` with `status`), never a
    message substring (STACK.md:162-173).
11. A read error inside a wait helper is remembered, never treated as "zero
    objects"; every "wait until none" is guarded by a positive precondition
    so a broken API server cannot pass a test.
12. Polling predicates are tri-state: keep waiting, done, or fail now with
    the last observed object; never burn the timeout on a state that is
    already wrong.
13. A test that needs Docker (testcontainers) fails when Docker is absent;
    it never skips silently.
14. One e2e file per failure mode krun classifies, each with its own
    uniquely named Function and its own cleanup.
15. The NetworkPolicy enforcement probe is part of every `make e2e`;
    without it the isolation claims in SPEC.md section 9 are unproven
    (SPEC.md:1434-1435, PLAN.md:605-606).
16. e2e asserts what logs and manifests must not contain (input, tokens,
    presigned URLs) as a positive grep-for-absence test (SPEC.md:1087-1089,
    1149-1154; docs/PROBLEM.md:82).
17. Scheduler downtime in upgrade and drill scenarios stays below
    `KRUN_TTL_AFTER_FINISHED` (SPEC.md:914-919, 1416-1417).
18. Owner preconditions of P0.9 (npm scope, PyPI name, GHCR owner, OIDC
    publishing) are never resolved by the agent: write BLOCKED
    (PLAN.md:23-28, 213-217).
19. Never add a `Co-Authored-By` trailer (CLAUDE.md rule 5, PLAN.md:16);
    never push main directly (PLAN.md:21-22).

## Runner and type checking

| Scope | Command | Notes |
|---|---|---|
| all TS | `pnpm -r exec vitest run` from `make test` | PLAN.md:51; each package has its own `vitest.config.ts` (P0.1, PLAN.md:155) |
| a phase gate path | `pnpm exec vitest run packages/shared/src/store` | PLAN.md:226; run from the root, so the root `vitest.config.ts` lists the package configs in `test.projects` (`.agents/skills/vitest/references/advanced-projects.md`); confirm in P0.1 that per-package settings apply (UNVERIFIED) |
| one package | `pnpm --filter <pkg> exec vitest run` | |
| Python SDK | `uv run --directory sdk/python pytest` | part of `make test` (PLAN.md:137-138) |
| lint | `biome check` + `tsc --noEmit` per package | `make lint` (PLAN.md:161-162) |
| Python lint | `ruff check` and `mypy --strict` under `uv run --directory sdk/python` | STACK.md:127-128; wire into `make lint` in P0.1, enforce from P8.2 |
| e2e | `pnpm exec vitest run --config test/e2e/vitest.config.ts` from `make e2e` | real time, `references/kind-recipe.md` "Harness" |

- Vitest 5 defaults (verified in the 5.0.5 tarball,
  `dist/chunks/defaults.*.js`, `index.*.js`): include
  `**/*.{test,spec}.?(c|m)[jt]s?(x)`, `pool: "forks"`, `isolate: true`,
  `clearMocks: true`, `testTimeout` 5000 ms, `hookTimeout` 10000 ms. Keep
  forks and isolation. Set `include: ["src/**/*.test.ts"]` per package so
  `dist/` is never collected.
- `pnpm -r exec` does not run in the workspace root by default, so tests
  under `scripts/` or `test/fake-kube` need a root project that `make test`
  runs explicitly (never `test/e2e`, which has its own config).
- Vitest transforms TypeScript itself and does not type-check: `tsc
  --noEmit` in `make lint` is the type gate. TypeScript 7 is the native
  `tsc` (npm `typescript` 7.0.2 ships a `tsc` bin that resolves a
  per-platform `@typescript/typescript-<os>-<arch>` optional dependency;
  never install with `--no-optional`). tsconfig flags are STACK.md:120-125
  (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `nodenext`, `es2024`, erasable syntax only).
- A test importing another workspace package by name resolves through the
  `workspace:` link to that package's `exports`; if those point at `dist/`,
  `make test` must build first or the test runs stale code. Decide in P0.1.
- `vitest run` with no matching files exits non-zero ("No test files
  found"). Until a package has its first test, set `passWithNoTests: true`
  in its config; P4.12's "`make e2e` with zero scenarios" needs the same,
  or the enforcement probe as the first e2e file.
- Vitest 5 removed `test.sequential`; use `{ concurrent: false }` on
  suites sharing state (`@effect/vitest` README "Migrating to Vitest 5").

## Effect 4 test idioms

Verified against the `@effect/vitest` 4.0.6 and `effect` 4.0.6 tarballs.

| Need | Write | Why |
|---|---|---|
| unit test of an Effect | `it.effect("name", () => Effect.gen(function*() { ... }))` | provides `TestClock` + `TestConsole` and a fresh `Scope` closed after the test |
| resource in a test | `yield* Effect.acquireRelease(...)` inside `it.effect` | there is no `it.scoped` in 4.0.6; the test already has a scope; do not wrap in `Effect.scoped` (README "Resource Safety and Scope") |
| real clock | `it.live` | process tests, real `pg` timeouts |
| shared service for a block | `layer(SomeLayer)("block", (it) => { it.effect(...) })` | built once, closed in `afterAll`; state persists between tests in the block |
| slow layer (container) | `layer(PgLayer, { timeout: "2 minutes" })` | the option is the hook timeout for build and close |
| time | `import { TestClock } from "effect/testing"`; `yield* TestClock.adjust("10 seconds")` | TestClock starts at 0; `TestClock.setTime(ms)` for a fixed epoch |
| fork then step | `const f = yield* Effect.forkChild(loop)`, then `TestClock.adjust`, then `Fiber.join` or inspect | v4 name is `forkChild`; adjusting before the fork moves nothing |
| typed failure | `const e = yield* Effect.flip(program)`; `expect(e._tag).toBe("QueueFull")` | rule 10 |
| Effect hooks | `beforeAll`/`beforeEach` from `@effect/vitest` accept an Effect with its own scope | |

- `Effect.timeout` fires on `TestClock.adjust`: that is how the 10 s
  Kubernetes call bound, the 5 s store bound and the 2 s readiness check
  are tested without waiting (STACK.md:180; P0.7 PLAN.md:196-197).
- `TestClock` gotcha (`TestClock.d.ts`): sleeps registered after several
  scheduler hops run in order only for fibers under `TestClock.layer()`,
  which `it.effect` installs; a clock built by hand with `TestClock.make`
  does not. Let the loop reach its first sleep (`Effect.yieldNow`) before
  the first `adjust` (dapr `pkg/apphealth/health_test.go:135-145`).
- UUIDv7 ids come from `v7({ msecs })` with `Clock` (STACK.md:82): under
  `TestClock` ids are deterministic, so golden files may contain them.
- `it.prop` / `it.effect.prop` take Effect `Schema` or `effect/Arbitrary`
  (unstable): do not use them; krun has one schema language (Zod,
  STACK.md:15-20). Property tests use fast-check directly.
- All `@effect/vitest` exports are `@stability unstable`; STACK.md:108 pins
  `~4.0.6` with `effect` in lockstep (STACK.md:233-234).
- `NodeRuntime.runMain` turns SIGTERM into interruption and runs the
  finalizers (STACK.md:43); that an interrupt-only exit yields code 0 is
  UNVERIFIED for 4.0.6 (`@effect/platform-node-shared` not inspected):
  P3.7 asserts it.

### Property tests and SDK suites

fast-check targets (request fingerprint, filter parser, duration grammar,
address checks, STACK.md:109) and the Effect-free SDK and template suites
(Vitest fake timers for `packages/sdk-node`, `pytest` + `mypy --strict`
for `sdk/python`, `test/sdk-conformance`): `references/properties-and-sdk.md`.

## Test doubles

| Double | Used by | Shape |
|---|---|---|
| fake `Kube` layer | P2.3, P4.2, P4.3a-c, P4.4, P4.5, P4.7-P4.10 (PLAN's "stubbed `CoordinationV1Api`/`BatchV1Api`/`CoreV1Api`/`pods/log`") | `Layer` over a `Ref` of objects plus an ordered action log; scripted failures as `KubeApiError` with `status`; informers as `Stream`s the test feeds; table-driven rows, `references/fake-kube.md` part 1 |
| in-memory `Store` layer | P3.x handler tests, P5.1 | implements the `Store` service from `krun-store`; a stalled method is `Effect.never`, then `TestClock.adjust("5 seconds")` for 503 `NOT_READY` (PLAN.md:452, 458-459) |
| fake object store layer | P3.6, P4.4, P6.2 | `{ exists, presignPut, presignGet }` recording calls; scripted `ObjectStoreError` |
| `test/fake-kube` | P3.7, P4.6, P4.11 process tests (PLAN.md:436-441, 555-556, 596-599) | `http.createServer` Kubernetes API over in-memory objects, kubeconfig per test (`references/fake-kube.md` part 2) |
| local HTTP receiver | P5.3, P8.1-P8.3 | `http.createServer` on port 0 with scripted responses (500 then 200, 302, 429, hang) (PLAN.md:642-645, 793-803) |
| Fastify `inject` | P0.7, P3.x, P5.x | the listener layer builds the app; tests call `app.inject` inside `it.effect` via `Effect.promise` |

- Unit tests that touch Kubernetes go through the fake `Kube` layer, never
  through `test/fake-kube`: the layer is in-process under `TestClock`; the
  HTTP fake is for process tests that start `bin/krun.js` (build first:
  `bin/krun.js` dispatches to `dist/`).
- SQLite tests: `fs.mkdtemp` under `os.tmpdir()`, removed after the suite
  (PLAN.md:227-228) or by an `Effect.acquireRelease` finalizer; in memory
  for gateway handler tests (PLAN.md:365-366).
- Postgres and MinIO through testcontainers 12 as scoped layers:
  `PostgreSqlContainer` from `@testcontainers/postgresql`,
  `MinioContainer` from `@testcontainers/minio` (built-in wait on
  `/minio/health/live` port 9000, `getConnectionUrl()`, default user and
  password `minioadmin`, `withUsername`/`withPassword`; verified in the
  12.2.1 tarballs). Acquire with `Effect.acquireRelease(Effect.promise(()
  => new PostgreSqlContainer(IMAGES.postgres).start()), (c) =>
  Effect.promise(() => c.stop()))` inside `Layer.effect` (v4 renamed
  `Layer.scoped` to `Layer.effect`) and share it with `layer(...)`. Pin
  image tags or digests in one constants file so Renovate can bump them.
  testcontainers 12 needs Node >= 22.22.
- CI without a privileged Ryuk: `TESTCONTAINERS_RYUK_DISABLED=true` (the
  variable exists in testcontainers 12.2.1) plus a `docker rm` cleanup step.

## Phase gates, kind, scenarios, CI, release

- `references/phase-gates.md`: every gate verbatim from PLAN.md with the
  command and what "green" means.
- `references/fake-kube.md`: the fake `Kube` layer and table-driven
  reconciler tests; the `test/fake-kube` HTTP server; client-node facts.
- `references/kind-recipe.md`: `make kind-up` with the local registry on
  `localhost:5001`, the enforcement probe, raw jobs-namespace manifests
  until P7.6, MinIO egress, the chart switch, the e2e harness, wait
  helpers.
- `references/e2e-scenarios.md`: scenario catalogue per phase with the
  assertion each must make.
- `references/ci-release.md`: build facts, Dockerfile, `ci.yml` jobs,
  Trivy and audit flags, `renovate.json`, `release.yml`, cosign, syft,
  OIDC, owner preconditions, benchmarks.
- `references/lessons.md`: KEDA, Knative and Dapr test patterns with
  source citations and their krun form.
- `references/properties-and-sdk.md`: fast-check properties, SDK and
  template suites.

## Library facts

- `@effect/vitest` 4.0.6: peers `vitest >=5.0.0 <6.0.0`, `effect ^4.0.6`;
  exports `it`, `effect`, `live`, `layer`, `flakyTest`, `prop`,
  `makeMethods`, Effect-aware `beforeAll`/`beforeEach`, and re-exports
  Vitest. No `scoped`/`scopedLive`. VERIFIED (`dist/index.d.ts`).
- `vitest` 5.0.5: engines Node `^22.12.0 || ^24.0.0 || >=26.0.0`; `vite`
  `^6.4.0 || ^7.0.0 || ^8.0.0` is a non-optional peer. VERIFIED
  (`package.json`). pnpm's `autoInstallPeers` installs it; listing `vite`
  explicitly would need a Decisions row (PLAN.md:29-30).
- `fast-check` 4.10.2: one runtime dependency (`pure-rand`); `fc.assert`,
  `fc.property`, `fc.asyncProperty`, `fc.ipV4`, `fc.ipV6`,
  `fc.stringMatching`, `fc.jsonValue` exist. VERIFIED (`lib/fast-check.d.ts`).
- `typescript` 7.0.2: `bin.tsc`, per-platform optional dependencies, root
  export is only a version file; the compiler API is under `./unstable/*`.
  VERIFIED.
- `@kubernetes/client-node` 2.0.1 facts (`ApiException`, the `http:`
  kubeconfig rule, informer stop-on-error, per-call signal):
  `references/fake-kube.md` "client-node facts". better-sqlite3 prebuilds
  and pnpm `allowBuilds`: `references/ci-release.md` "Build facts".

## Lessons from KEDA, Knative and Dapr

Source-cited patterns (table-driven want-lists, fixed clock, tri-state
polls, HA leader test, deadline propagation, process-level integration,
streaming fake apiserver) and their krun form: `references/lessons.md`.

## Pitfalls

- `TestClock.adjust` before the loop fiber is forked: nothing fires and the
  test "passes" on initial state. Fork, then adjust, then assert.
- A `layer(...)` block shares state across its tests: a seeded fake from
  test 1 leaks into test 2. Use `Effect.provide(FakeKube.layer(row.seed))`
  per table row.
- `Effect.runPromise` in a plain `it` runs on the live clock: a 10 s
  timeout really waits 10 s, or Vitest's 5 s test timeout fires first.
- `vi.useFakeTimers` does not move `TestClock`, and `TestClock` does not
  move `Date`.
- `pnpm -r exec vitest run` in a package with no test file fails the whole
  `make test`; see `passWithNoTests` above.
- `KRUN_WEBHOOK_ALLOWED_CIDRS` must list the kind pod and Service CIDRs or
  the in-cluster receiver is rejected `CALLBACK_NOT_ALLOWED` (PLAN.md:
  621-623, SPEC.md:1472 D31).
- `pnpm audit --prod --audit-level=critical` fails on a transitive critical
  with no fix; do not suppress, open a Decisions row or pin (PLAN.md:174).
- Trivy with `--ignore-unfixed` still fails on fixable criticals in the
  distroless base: bump the digest, never widen `--severity` (PLAN.md:175).
- `helm/kind-action` and the local `kind` must be the same version
  (PLAN.md:56-57, 609-610) or the enforcement probe passes locally and
  fails in CI.
- `docker push` output's `digest:` line is the only source of the image
  digest for P8.6 (PLAN.md:830-832); never compute it from the local image
  id.
- The P9.4 quickstart timeout is 1800 s per mode (PLAN.md:880-884).
- Never assert on log lines containing input, results, tokens or keys; the
  test itself would then carry a value SPEC says must never appear.

## Before marking a task done

- Run the task's acceptance command from PLAN.md, then `make check`
  (PLAN.md:17-18); for e2e tasks `make e2e` green locally and in CI.
- At a phase end run the gate in `references/phase-gates.md`.
- Append `YYYY-MM-DD <task> <sha> note` to PLAN.md section 6 and commit it
  with the code (PLAN.md:19-20).
- Branch named after the task id, Conventional Commit with package scope,
  pull request to main, merge when CI is green; no `Co-Authored-By`
  (PLAN.md:13-16, 21-22).

## Limitations

- This skill does not define behaviour; the app skill of the task under
  test does. Conflicts resolve in favour of SPEC.md, then docs/STACK.md.
- docs/STACK.md:108 lists `it.scoped`, which `@effect/vitest` 4.0.6 does
  not export; `it.effect` covers it. PLAN.md:497-504 (P4.3a) and
  SPEC.md:795-796 still say `AbortSignal.timeout`; STACK.md:180 maps it to
  `Effect.timeout` with the signal threaded to client-node.
- Benchmark numbers (P9.3) are measured on kind on the CI runner; the
  README must say so.
