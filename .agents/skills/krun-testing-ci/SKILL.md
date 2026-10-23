---
name: krun-testing-ci
description: Use when writing krun tests, e2e, Docker or CI workflows. Vitest 5 with @effect/vitest and TestClock, fast-check, testcontainers, fake-kube, kind registry, release.yml.
---

# krun testing, e2e, Docker, CI and release

Owns the test harness of krun: Vitest 5 with `@effect/vitest` for every
TypeScript package, the test doubles (`test/fake-kube`, test `Layer`s for
the `Kube`, `Database` and store services, `TestClock`, local HTTP
receivers), fast-check property tests, testcontainers, the phase gates,
the kind e2e recipe and scenario catalogue, the Dockerfile, `ci.yml` and
`release.yml`. Serves PLAN tasks P0.1-P0.4, P0.7, P0.9, P4.11-P4.13, P5.4,
P6.3, P7.6, P8.6, P9.1-P9.6 and the test half of every other task.
Behaviour under test is owned by the sibling skill of that task; this
skill says how to prove it.

## When to use

- Any task id above, or the words Vitest, `@effect/vitest`, TestClock,
  e2e, kind, Dockerfile, ci.yml, release.yml, testcontainers, fake-kube,
  phase gate, benchmark.
- Writing the acceptance test of any other task (test-first,
  docs/AGENT-KICKOFF.md:32-33): load this skill plus the task's app skill
  (`krun-development` routing table) and the vendored `vitest` skill for
  runner details.
- A phase end: run the gate from `references/phase-gates.md`.

## Read first

- docs/STACK.md section 3 (dev dependencies and ranges: `vitest` ^5.0,
  `@effect/vitest` ~4.0.6, `fast-check` ^4.10, `testcontainers`,
  `@testcontainers/postgresql`, `@testcontainers/minio` ^12.2), section 4.3
  (SPEC rules mapped to Effect constructs) and 4.4 (time, `TestClock`);
  SPEC.md D35 (SPEC.md:1476); CLAUDE.md rules 6 to 8.
- PLAN.md:7-34 agent protocol; PLAN.md:36-90 toolchain and the only allowed
  dependencies (test libraries are dev dependencies, PLAN.md:76-78);
  PLAN.md:92-140 layout, `*.test.ts` next to code, make targets.
- Phase gates: PLAN.md:146, 226-229, 317, 365-367, 469-481, 618-623,
  653-655, 674-678, 780-782, 849-850 (verbatim in `references/phase-gates.md`).
- Tasks: P0.1-P0.4 PLAN.md:148-178; P0.7 PLAN.md:191-197; P0.9
  PLAN.md:213-222; P4.11-P4.13 PLAN.md:592-614; P5.4 PLAN.md:646-649; P6.3
  PLAN.md:668-670; P7.6 PLAN.md:758-771; P8.6 PLAN.md:830-837; P9.1-P9.6
  PLAN.md:852-897.
- SPEC.md:19-24 non-goals; SPEC.md:54-60 one image, four entrypoints;
  SPEC.md:1087-1089 and 1149-1154 what logs never contain;
  SPEC.md:1161-1174 health and SIGTERM order; SPEC.md:1094-1096 and
  1413-1417 signing and release; SPEC.md:1421-1436 limits and the
  NetworkPolicy-CNI requirement; docs/PROBLEM.md:76-86 success criteria.
- docs/INTERNAL-API.md:326-371: the shell function every Phase 4 scenario
  image is shaped like.

## Rules

1. Write the acceptance test before the code; a task without a passing
   test is not done (docs/AGENT-KICKOFF.md:32-33, PLAN.md:17-18).
2. Every krun TypeScript package tests with Vitest 5 (`vitest run`, one
   `vitest.config.ts` per package); every test of Effect code uses
   `@effect/vitest` (`it.effect` (already scoped), `layer(...)`). `node:test`,
   `node --test` and running tests through Node's own TypeScript handling
   are gone (docs/STACK.md section 2.6, SPEC.md D35).
3. Tests sit next to the code as `*.test.ts`; cross-package fixtures live
   under `test/` (PLAN.md:124-128) so each package's `include` stays local.
4. Tests generate their own keys, tokens and secrets at runtime; never
   commit one (PLAN.md:33, docs/AGENT-KICKOFF.md:34-35).
5. No dependency outside PLAN.md:58-78; a test helper package (sinon,
   nock, msw, jest, supertest) is not allowed without a Decisions row
   (PLAN.md:29-30). Test `Layer`s, `vi.fn`, Fastify `inject`,
   `http.createServer` and `test/fake-kube` cover every case the plan names.
6. Time comes from Effect `Clock`, `DateTime` and `Duration`; application
   code never calls `Date.now()` or `new Date()` (CLAUDE.md rule 8,
   docs/STACK.md 4.4). Tests move time with `TestClock.adjust` (and
   `TestClock.setTime` for a realistic start), never with a real sleep and
   never with `vi.useFakeTimers` on Effect code: lease expiry
   (SPEC.md:788-790), heartbeat staleness and every `Schedule` follow the
   one clock.
7. Assert on exact strings and ordered call lists, not on "called at least
   once": every scheduler test records `[verb, resource, name]` actions and
   compares the ordered list (knative-serving.md:362-368) because SPEC fixes
   the order (SPEC.md:852-863 terminal, 885-898 heartbeat).
8. A read error inside a wait helper is remembered, never treated as "zero
   objects"; every "wait until none" is guarded by a positive precondition
   (keda.md:288-290) so a broken API server cannot pass a test.
9. Polling predicates are tri-state: keep waiting, done, or fail now with the
   last observed object (knative-serving.md:380-382); never burn the timeout
   on a state that is already wrong.
10. One e2e file per failure mode krun classifies, each with its own
    uniquely named Function and cleanup in `afterAll` (knative-serving.md:384-386).
11. The NetworkPolicy enforcement probe is part of every `make e2e`; without
    it the isolation claims in SPEC.md section 9 are unproven
    (SPEC.md:1434-1435, PLAN.md:605-606).
12. e2e asserts what logs and manifests must not contain (input, tokens,
    presigned URLs) as a positive grep-for-absence test (SPEC.md:1087-1089,
    docs/PROBLEM.md:82).
13. Scheduler downtime in upgrade and drill scenarios stays below
    `KRUN_TTL_AFTER_FINISHED` (SPEC.md:1416-1417) or completed Jobs vanish
    before their terminal transition is recorded.
14. Owner preconditions of P0.9 (npm scope, PyPI name, GHCR owner, OIDC
    publishing) are never resolved by the agent: write BLOCKED
    (PLAN.md:23-28, 213-217).
15. Never add a `Co-Authored-By` trailer (CLAUDE.md rule 5, PLAN.md:16); CI
    runs on branch pull requests, never on a direct push to main
    (PLAN.md:21-22).

## Test layout and runner

| Scope | Command | Notes |
|---|---|---|
| one directory (gate form) | `pnpm exec vitest run packages/shared/src/store` | the phase gates use this form (PLAN.md:226, 317, 365) |
| one package | `pnpm --filter <pkg> exec vitest run` | uses that package's `vitest.config.ts` |
| all TS | `pnpm -r exec vitest run` from `make test` | PLAN.md:50-51, 135-140 |
| Python SDK | `uv run --directory sdk/python pytest` | part of `make test` (PLAN.md:138) |
| lint | `biome check` + `tsc --noEmit` per package | `make lint` (PLAN.md:160-161) |
| e2e | `pnpm exec vitest run --config test/e2e/vitest.config.ts` from `make e2e` | real cluster, real time; `references/kind-recipe.md` |

- `vitest.config.ts` per package with `include: ['src/**/*.test.ts']`, so
  `dist/` is never collected. Keep the defaults `pool: 'forks'` and
  `isolate: true`: each file gets its own module graph, env and mocks do
  not leak (vitest skill `references/core-config.md`).
- The gate commands run from the repository root. Give the root a
  `vitest.config.ts` whose `test.projects` lists the package configs plus
  one root project for `scripts/` and `test/fake-kube` (never `test/e2e`
  or `test/helm`, which have their own configs), so a root-level path
  filter still uses each package's settings. `pnpm -r exec` skips the
  workspace root, so `make test` runs that root project too. Check in
  P0.1 that `pnpm exec vitest run packages/shared/src/store` picks up the
  package config (UNVERIFIED).
- Vitest compiles TypeScript itself; tests import sources with the same
  specifiers `tsc` accepts under `module: nodenext`. A test importing
  another workspace package by name resolves through the `workspace:` link
  to that package's `exports`; if those point at `dist/`, `make test` must
  build first or the test runs against stale code. Decide in P0.1.
- Effect tests: `it.effect('name', () => Effect.gen(function* () { ... }))`
  with services from test layers (`Effect.provide(TestLayer)` or
  `layer(TestLayer)((it) => { ... })` to share one layer across a block);
  `it.effect` also for tests that acquire scoped resources (it is scoped;
  4.x has no `it.scoped`). `it.live` only for
  tests that must see wall-clock time against real I/O; none of the unit
  tests do.
- Plain functions (parsers, globs, signing): `it` from `@effect/vitest` or
  `vitest`, `expect` assertions. Property tests with fast-check 4
  (`fc.assert(fc.property(...))`) for the request fingerprint, filter
  parser, duration grammar and address checks (docs/STACK.md section 3).
- Per-test stubs: a service is replaced by a test `Layer`
  (`Layer.succeed(Kube, stub)`), a plain function by `vi.fn`; set
  `restoreMocks: true` in the config. `vi.mock` of modules is not needed.
- Table tests: one `for (const row of rows) it.effect(row.name, ...)` per
  rule; canonical first rows for any reconciler-style loop: bad id, row
  missing, already terminal, happy path, then one row per induced failure
  asserting which actions still happened (knative-serving.md:366-368).

## Test doubles

| Double | Where | Used by | Shape |
|---|---|---|---|
| `test/fake-kube` | `test/fake-kube/` | P3.7, P4.6, P4.11 acceptance (PLAN.md:436-437, 555-556, 596-599) | `http.createServer` over in-memory objects, kubeconfig file written per test; design in `references/fake-kube.md` |
| stubbed Kubernetes APIs | per test file, behind a test `Layer` of the `Kube` service | P4.2 `CoordinationV1Api`, P4.3b `BatchV1Api`/`CoreV1Api`, P4.7 `CustomObjectsApi`, P4.8 `pods/log`, P4.10 `CoreV1Api` (PLAN.md:494-496, 512-519, 559-561, 570-575, 591) | object with the few methods the code calls, recording `[verb, resource, name]`; returns `ApiException`-shaped errors `{code, body, headers}` (docs/research/node-stack-facts.md:305-312) so the real `KubeApiError` mapping runs |
| stubbed informer | P2.3, P4.4, P4.5, P4.9 | `on/off/start/stop/get/list` emitter driven by the test, behind the `Stream` adapter; feed `add/update/delete/error` in order (PLAN.md:342-345, 535-542) |
| fake store | P3.x handler tests, P5.1 | in-memory `Store` layer implementing the interface in `krun-store`; a stalled method (`Effect.never`) for the 503 `NOT_READY` tests (PLAN.md:452, 458-459) |
| fake object store | P3.6, P6.2 | `ObjectStore` layer `{exists, presignPut, presignGet}` recording calls (PLAN.md:431, 665) |
| clock | every loop, every lease, deadline and timeout | `TestClock` provided by `it.effect`; the test forks the loop, then `TestClock.adjust('10 seconds')` (rule 6) |
| local HTTP receiver | P5.3 webhook, P8.1/P8.2 internal API fake, P8.3 conformance | `http.createServer` on port 0; scripted responses (500 then 200, 302, 429, hang) (PLAN.md:642-645, 793-803) |

- SQLite tests: `fs.mkdtemp` under `os.tmpdir()`, removed in `afterAll`
  (the gate's "removed in `after`", PLAN.md:226-229) or by a scoped
  `Effect.acquireRelease`; in-memory for gateway handler tests
  (PLAN.md:365-366).
- Postgres and MinIO: testcontainers 12, `new PostgreSqlContainer(image)`
  from `@testcontainers/postgresql` and `new MinioContainer(image)` from
  `@testcontainers/minio`, started in `beforeAll` with an explicit hook
  timeout (`beforeAll(fn, 120_000)`) or acquired in a scoped layer shared
  through `layer(...)`, stopped in `afterAll` or by the layer's finalizer.
  Pin image tags or digests in one constant file so Renovate can bump
  them.
- CI without a privileged Ryuk: `TESTCONTAINERS_RYUK_DISABLED=true` and
  clean containers with a `docker rm` step (docs/research/node-stack-facts.md:785-786).
- The SDK conformance table (`test/sdk-conformance`, PLAN.md:811-818) is one
  JSON scenario list both suites read; the Node SDK suite runs under Vitest
  (a dev dependency of `packages/sdk-node`; the SDK keeps zero runtime
  dependencies and no Effect), the Python suite under `pytest`; reordering
  one SDK's calls must fail its suite. The SDK is not an Effect program,
  so its timer tests (1 s status gate, heartbeat interval) use
  `vi.useFakeTimers()` or an injected clock; this is the one place
  Vitest fake timers are right.
- Function project templates from `krun init` (`packages/cli/templates/`)
  are the function author's project, not krun: they stay dependency-free
  and may keep `node --test` in the template's own `package.json` test
  script; the P8.4 acceptance runs it with `npm test` (PLAN.md:819-825).

## Phase gates, kind, scenarios, CI, release

- `references/phase-gates.md`: every gate verbatim as a checklist with the
  command to run and what "green" means.
- `references/kind-recipe.md`: `make kind-up` with the local registry on
  `localhost:5001`, the enforcement probe, raw jobs-namespace manifests
  until P7.6, the MinIO egress policy, the P7.6 chart switch, wait helpers,
  the e2e Vitest config.
- `references/e2e-scenarios.md`: scenario catalogue per phase with the
  assertion each must make, file names, timeouts.
- `references/fake-kube.md`: endpoints, watch streaming, Lease semantics,
  how each consumer (P3.7, P4.6, P4.11) drives it.
- `references/ci-release.md`: Dockerfile rules, `ci.yml` jobs, Trivy and
  audit flags, `renovate.json`, `release.yml` stamping, cosign, syft, OIDC,
  owner preconditions, benchmarks.

## Library facts

- Vitest 5 requires Node 22.12 or newer (krun runs 24); default pool
  `forks` with `isolate: true`; `poolOptions` and `workspace` are gone in
  favour of top-level `maxWorkers` and `test.projects`. VERIFIED (vitest
  skill `references/core-config.md`:152-154).
- `@effect/vitest` must carry the same version as `effect` (both `~4.0.6`,
  moved together by Renovate, docs/STACK.md section 6). `it.effect`
  provides the test services, so `Clock` is a `TestClock` starting at
  epoch 0 that moves only on `TestClock.adjust` or `setTime`. Import paths
  for `TestClock` follow the installed Effect 4; Effect's `MIGRATION.md`
  wins over skill text written for Effect 3. UNVERIFIED in detail: confirm
  with the P0.1 smoke test.
- A sleeping fiber under `TestClock` waits forever unless the test adjusts
  the clock: fork the loop (Effect 4 renamed the fork combinators; see
  `MIGRATION.md`), then adjust. Awaiting the loop directly deadlocks the
  test until Vitest's timeout.
- `Effect.timeout` under `TestClock` fires on `TestClock.adjust`, which is
  how the 10 s Kubernetes call bound, the 5 s store bound and the 2 s
  readiness check are tested without waiting (docs/STACK.md 4.3; P0.7
  acceptance PLAN.md:196-197).
- `NodeRuntime.runMain` turns SIGTERM into interruption, runs the scope
  finalizers and sets the exit code (docs/STACK.md 2.1); process tests
  assert exit 0 after SIGTERM (PLAN.md:440-441, 597-599). Exit 0 on an
  interrupt-only cause is UNVERIFIED for Effect 4: confirm in P3.7.
- `@kubernetes/client-node` 2.x: `ApiException {code, body, headers}` for
  non-2xx; network, `TimeoutError` and `AbortError` are not `ApiException`
  (VERIFIED, docs/research/node-stack-facts.md:305-312). An `http:` server in a kubeconfig
  throws unless `insecure-skip-tls-verify: true` is set (VERIFIED,
  docs/research/node-stack-facts.md:227-228): `test/fake-kube` must write that flag.
- A watch is torn down after 30 s of inactivity and re-established; the
  informer stops for good on any other error and must be restarted by krun
  (VERIFIED, docs/research/node-stack-facts.md:350-360, 387-397): fake-kube tests of
  informer restart must emit a non-timeout error.
- `@kubernetes/client-node` depends on `@types/node ^26` while krun pins 24;
  expect duplicate global types and fix via pnpm `overrides` (dependency
  VERIFIED, consequence UNVERIFIED, docs/research/node-stack-facts.md:420-424).
- pnpm 10: list `better-sqlite3` in `onlyBuiltDependencies` or its native
  binary is never built. UNVERIFIED but high-risk (docs/research/node-stack-facts.md:805-809,
  916-917); confirm against the `pnpm` skill before P0.1.
- better-sqlite3 13.x Node 24 (ABI 137) prebuilt availability UNVERIFIED
  (docs/research/node-stack-facts.md:670-675); if absent the Docker build stage needs
  python3 and build tools, which the Dockerfile must then add (P0.3).
- Biome 2.6 uses `files.includes` with negations, not `ignore`. UNVERIFIED
  (docs/research/node-stack-facts.md:789-798).

## Lessons from KEDA, Knative and Dapr

- Ordered want-lists with induced failures: each table row declares initial
  objects, the key, and the exact `wantCreates/wantDeletes/wantPatches`;
  `induceFailure('create','jobs')` returns a deterministic message the
  assertion embeds verbatim (knative-serving `vendor/knative.dev/pkg/reconciler/testing/table.go:44-113`, `pkg/reconciler/revision/table_test.go:62-135`).
- A fixed, injected clock: "we don't care about the value, but that it does
  not change, since it leads to flakes" (knative-serving `table_test.go:130-133`).
  `TestClock` gives krun this for free; set it once with `setTime`.
- Tri-state polling predicate `(done, err)`: `Ready=False` with the current
  generation fails immediately with reason and message (knative-serving
  `test/v1/revision.go:33-86`).
- HA test: scale to 2, delete the Lease holder pod, assert a queued run still
  gets exactly one Job within lease + retry (knative-serving
  `test/ha/controller_test.go:48-76`); krun does this in P7.6.
- Deadline propagation is asserted on the fake: the recorded call carries
  `now + timeout` within 10 ms (keda `pkg/scaling/executor/scale_jobs_test.go:479-534`);
  in krun, a stubbed call that never answers plus `TestClock.adjust('10 seconds')`
  proves the per-call `Effect.timeout` of P4.3a.
- `eventually` remembers a thrown read and keeps polling; the final error
  shows the last throw; `WaitForAllJobsSuccess` requires `len > 0`
  (keda `tests/helper/helper.go:304-386,1348-1423`).
- One namespace per e2e file labelled for a global sweep, bounded retries
  with retry counts recorded, krun logs dumped on failure (keda
  `tests/run-all.go:28-34,302-330`).
- CLI tests run the real command with injected deps from a scrubbed temp dir:
  clear `KRUN_*` from a copied env, pass `env` explicitly, read
  `function.yaml` back from disk (knative-func `pkg/testing/testing.go:332-385`,
  `cmd/deploy_test.go:1287-1333`).
- e2e drives the real binary with `child_process.spawn`, echoes each command,
  polls 5 s up to 2 min, warns after 30 s at most every 10 s, stops on 5xx;
  an update test proves the digest changed (knative-func
  `e2e/e2e_test.go:592-619,803-863`, `e2e/e2e_core_test.go:164-206`).
- Process-level integration: start the real process, poll TCP then `/healthz`,
  assert log lines and the exit code on SIGTERM, drain pipes before asserting
  (dapr `tests/integration/framework/process/exec/exec.go:159-236`,
  `daprd.go:256-307`); this is the P3.7 and P4.11 shape: spawn
  `bin/krun.js` with `KUBECONFIG` pointing at `test/fake-kube`.
- A fake kube-apiserver streams one chunked watch response per watcher; the
  "one event per connection" design cost seconds per event via reflector
  backoff (dapr `tests/integration/framework/process/kubernetes/informer/informer.go:34-70`).
- Fake clocks: wait for the timer to be registered before stepping
  (dapr `pkg/apphealth/health_test.go:135-145`); with `TestClock`, fork the
  loop and let it reach its first sleep before the first `adjust`.

## Pitfalls

- A test of Effect code written with plain `it` instead of `it.effect`
  runs on the live clock: timers really wait and the test is slow or
  flaky. Everything that touches `Clock`, `Schedule` or `Effect.timeout`
  uses `it.effect`.
- `TestClock` does not move `Date.now()`, and `vi.useFakeTimers` does not
  move `TestClock`. A stray `Date.now()` in application code (forbidden by
  CLAUDE.md rule 8) makes lease and heartbeat tests pass locally and flake
  in CI; grep for it in review.
- Process tests and e2e run `bin/krun.js`, which dispatches to the built
  `dist/` entrypoints: build before running them, or they test old code.
- `KRUN_WEBHOOK_ALLOWED_CIDRS` must list the kind pod and Service CIDRs or
  the in-cluster receiver is rejected `CALLBACK_NOT_ALLOWED` (PLAN.md:620-623,
  SPEC.md:1472 D31).
- A fake-kube kubeconfig with `http://` and no `insecure-skip-tls-verify`
  throws before the first request.
- `pnpm audit --prod --audit-level=critical` fails the build on a transitive
  critical with no fix; do not suppress, open a Decisions row or pin
  (PLAN.md:174-175).
- Trivy with `--ignore-unfixed` still fails on fixable criticals in the
  distroless base: bump the digest, never widen `--severity` (PLAN.md:175).
- `helm/kind-action` and the local `kind` must be the same version
  (PLAN.md:56-57, 609-610) or the enforcement probe passes locally and fails
  in CI.
- `docker push` output's `digest:` line is the only source of the image
  digest for P8.6 (PLAN.md:830-833); never compute it from the local image id.
- The P9.4 quickstart timeout is 1800 s per mode (PLAN.md:880-884); budget
  the CI job accordingly.
- Never assert on log lines containing input, results, tokens or keys; the
  test itself would then carry a value SPEC says must never appear.

## Before marking a task done

- Run the task's acceptance command from PLAN.md, then `make check`
  (PLAN.md:17-18); for e2e tasks `make e2e` green locally and in CI.
- At a phase end run the gate in `references/phase-gates.md`.
- Append `YYYY-MM-DD <task> <sha> note` to PLAN.md section 6 and commit it
  with the code (PLAN.md:19-20).
- Branch `p<phase>-<n>-<slug>`, Conventional Commit with package scope, pull
  request to main, merge when CI is green; no `Co-Authored-By`
  (PLAN.md:13-16, 21-22).

## Limitations

- This skill does not define behaviour; the app skill of the task under
  test does. Conflicts resolve in favour of SPEC.md.
- `@effect/vitest` API details for Effect 4 (layer sharing, `TestClock`
  import path) are taken from docs/STACK.md and marked UNVERIFIED above;
  the P0.1 smoke test settles them.
- kind recipe details (containerd `hosts.toml`, registry ConfigMap) follow
  kind's documented recipe and are UNVERIFIED against kind 0.24+ here;
  re-read kind's "Local Registry" page when writing P4.12.
- Benchmark numbers (P9.3) are measured on kind on the CI runner; the README
  must say so.
