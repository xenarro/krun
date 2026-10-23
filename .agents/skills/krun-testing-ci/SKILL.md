---
name: krun-testing-ci
description: Use when writing krun tests, e2e, Docker or CI workflows. node --test on TS, fake-kube, testcontainers, kind registry, release.yml.
---

# krun testing, e2e, Docker, CI and release

Owns the test harness of krun: `node --test` over TypeScript sources, the
test doubles (`test/fake-kube`, stubbed `@kubernetes/client-node` APIs, fake
clocks, local HTTP receivers), testcontainers, the phase gates, the kind e2e
recipe and scenario catalogue, the Dockerfile, `ci.yml` and `release.yml`.
Serves PLAN tasks P0.1-P0.4, P0.9, P4.12, P4.13, P5.4, P6.3, P7.6, P8.6,
P9.1-P9.6 and the test half of every other task. Behaviour under test is
owned by the sibling skill of that task; this skill says how to prove it.

## When to use

- Any task id above, or the words e2e, kind, Dockerfile, ci.yml,
  release.yml, testcontainers, fake-kube, phase gate, benchmark.
- Writing the acceptance test of any other task (test-first,
  docs/AGENT-KICKOFF.md:32-33): load this skill plus the task's app skill
  (`krun-development` routing table).
- A phase end: run the gate from `references/phase-gates.md`.

## Read first

- PLAN.md:7-34 agent protocol; PLAN.md:36-74 toolchain and the only allowed
  dependencies (`testcontainers`, `@testcontainers/postgresql` are test-only,
  PLAN.md:67); PLAN.md:76-123 layout, `*.test.ts` next to code, make targets.
- Phase gates: PLAN.md:129, 205-208, 296-298, 346-348, 449-461, 598-603,
  633-635, 654-658, 760-762, 829-830 (verbatim in `references/phase-gates.md`).
- Tasks: P0.1-P0.4 PLAN.md:131-159; P0.9 PLAN.md:192-201; P4.12-P4.13
  PLAN.md:580-594; P5.4 PLAN.md:626-629; P6.3 PLAN.md:648-650; P7.6
  PLAN.md:738-751; P8.6 PLAN.md:810-817; P9.1-P9.6 PLAN.md:832-877.
- SPEC.md:19-24 non-goals; SPEC.md:54-60 one image, four entrypoints;
  SPEC.md:1087-1089 and 1149-1154 what logs never contain; SPEC.md:1094-1096
  and 1413-1417 signing and release; SPEC.md:1421-1436 limits and the
  NetworkPolicy-CNI requirement; docs/PROBLEM.md:76-86 success criteria.
- docs/INTERNAL-API.md:326-371: the shell function every Phase 4 scenario
  image is shaped like.

## Rules

1. Write the acceptance test before the code; a task without a passing
   test is not done (docs/AGENT-KICKOFF.md:32-33, PLAN.md:17-18).
2. Tests run as `node --test "<glob>"` on `.ts` sources with no loader and
   no `--experimental-strip-types`; only erasable syntax (no `enum`, no
   parameter properties, no value `namespace`), `.ts` extensions on every
   relative import, `import type` for types (PLAN.md:38-41;
   node-stack-facts.md:64-96) because Node 24 strips, it does not transform.
3. Tests sit next to the code as `*.test.ts`; cross-package fixtures live
   under `test/` (PLAN.md:108-116) so each package's glob stays local.
4. Tests generate their own keys, tokens and secrets at runtime; never
   commit one (PLAN.md:33, docs/AGENT-KICKOFF.md:34-35).
5. No dependency outside PLAN.md:48-67; a test helper package (sinon,
   nock, msw, jest) is not allowed without a Decisions row (PLAN.md:29-30).
   `node:test` `mock`, `mock.timers`, `http.createServer` and `test/fake-kube`
   cover every case the plan names.
6. Inject `now()` and timers into every loop and fake them in tests; enable
   `Date` in `mock.timers.enable({ apis })` or lease expiry (SPEC.md:788-790)
   and the timers disagree (node-stack-facts.md:164-173).
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
    uniquely named Function and cleanup in `after` (knative-serving.md:384-386).
11. The NetworkPolicy enforcement probe is part of every `make e2e`; without
    it the isolation claims in SPEC.md section 9 are unproven
    (SPEC.md:1434-1435, PLAN.md:585-586).
12. e2e asserts what logs and manifests must not contain (input, tokens,
    presigned URLs) as a positive grep-for-absence test (SPEC.md:1087-1089,
    docs/PROBLEM.md:82).
13. Scheduler downtime in upgrade and drill scenarios stays below
    `KRUN_TTL_AFTER_FINISHED` (SPEC.md:1416-1417) or completed Jobs vanish
    before their terminal transition is recorded.
14. Owner preconditions of P0.9 (npm scope, PyPI name, GHCR owner, OIDC
    publishing) are never resolved by the agent: write BLOCKED
    (PLAN.md:23-28, 192-196).
15. Never add a `Co-Authored-By` trailer (CLAUDE.md:7, PLAN.md:16); CI runs
    on branch pull requests, never on a direct push to main (PLAN.md:21-22).

## Test layout and runner

| Scope | Command | Notes |
|---|---|---|
| one package | `node --test "packages/shared/src/**/*.test.ts"` | quote the glob (node-stack-facts.md:127-129) |
| all TS | `pnpm -r test` from `make test` | each package's `test` script holds its glob (PLAN.md:118-121) |
| Python SDK | `uv run --directory sdk/python pytest` | part of `make test` (PLAN.md:121) |
| lint | `biome check` + `tsc --noEmit` per package | `make lint` (PLAN.md:141-142) |

- Default `--test-isolation=process`: one child per file, so env and global
  mocks do not leak; keep it (node-stack-facts.md:130-133).
- `--test-force-exit` only as a diagnosed last resort for a leaked handle;
  the fix is deterministic teardown in `after` (see the `node` skill,
  rules/stuck-processes-and-tests.md).
- `tsconfig.base.json`: `module: nodenext`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` for packages
  that emit `dist/` (node-stack-facts.md:107-116). Node refuses to strip TS
  under `node_modules`, so cross-package imports in tests go through
  `workspace:` links; whether pnpm's symlink realpath escapes that rule is
  UNVERIFIED (node-stack-facts.md:99-104): test it in P0.1 and fall back to
  importing `dist/` after `pnpm -r build`.
- `t.mock.method(obj, 'fn', impl)` for per-test stubs restored at test end;
  `mock.module` needs a flag and is not needed.
- Table tests: one `for (const row of rows) test(row.name, ...)` per rule;
  canonical first rows for any reconciler-style loop: bad id, row missing,
  already terminal, happy path, then one row per induced failure asserting
  which actions still happened (knative-serving.md:366-368).

## Test doubles

| Double | Where | Used by | Shape |
|---|---|---|---|
| `test/fake-kube` | `test/fake-kube/` | P3.7, P4.6, P4.11 acceptance (PLAN.md:416-417, 535-536, 576-579) | `http.createServer` over in-memory objects, kubeconfig file written per test; design in `references/fake-kube.md` |
| stubbed API classes | per test file | P4.2 `CoordinationV1Api`, P4.3b `BatchV1Api`/`CoreV1Api`, P4.7 `CustomObjectsApi`, P4.8 `pods/log`, P4.10 `CoreV1Api` (PLAN.md:474-476, 492-499, 539-541, 550-555, 571) | object with the few methods the code calls, recording `[verb, resource, name]`; returns `ApiException`-shaped errors `{code, body, headers}` (node-stack-facts.md:305-312) |
| stubbed informer | P2.3, P4.4, P4.5, P4.9 | `on/off/start/stop/get/list` emitter driven by the test; feed `add/update/delete/error` in order (PLAN.md:323-326, 515-522) |
| fake store | P3.x handler tests, P5.1 | in-memory `Store` implementing the interface in `krun-store`; a stalled method (never-resolving promise) for the 503 `NOT_READY` tests (PLAN.md:432, 438-439) |
| fake object store | P3.6, P6.2 | `{exists, presignPut, presignGet}` recording calls (PLAN.md:412, 645) |
| fake clock | every loop | `{now(), setTimeout, setInterval}` injected, or `mock.timers` with `Date` (rule 6) |
| local HTTP receiver | P5.3 webhook, P8.1/P8.2 internal API fake, P8.3 conformance | `http.createServer` on port 0; scripted responses (500 then 200, 302, 429, hang) (PLAN.md:622-625, 773-783) |

- SQLite tests: `fs.mkdtemp` under `os.tmpdir()`, removed in `after`
  (PLAN.md:205-208); in-memory for gateway handler tests (PLAN.md:346-347).
- Postgres and MinIO: `testcontainers` in `before()` with a generous
  `timeout`; `PostgreSqlContainer('postgres:17-alpine')`,
  `GenericContainer('minio/minio')` with `Wait.forHttp('/minio/health/live',
  9000)` (node-stack-facts.md:778-787). Pin image tags or digests in one
  constant file so Renovate can bump them.
- CI without a privileged Ryuk: `TESTCONTAINERS_RYUK_DISABLED=true` and
  clean containers with a `docker rm` step (node-stack-facts.md:785-786).
- The SDK conformance table (`test/sdk-conformance`, PLAN.md:791-798) is one
  JSON scenario list both suites read; the Node suite is `node --test`, the
  Python suite `pytest`; reordering one SDK's calls must fail its suite.

## Phase gates, kind, scenarios, CI, release

- `references/phase-gates.md`: every gate verbatim as a checklist with the
  command to run and what "green" means.
- `references/kind-recipe.md`: `make kind-up` with the local registry on
  `localhost:5001`, the enforcement probe, raw jobs-namespace manifests
  until P7.6, the MinIO egress policy, the P7.6 chart switch, wait helpers.
- `references/e2e-scenarios.md`: scenario catalogue per phase with the
  assertion each must make, file names, timeouts.
- `references/fake-kube.md`: endpoints, watch streaming, Lease semantics,
  how each consumer (P3.7, P4.6, P4.11) drives it.
- `references/ci-release.md`: Dockerfile rules, `ci.yml` jobs, Trivy and
  audit flags, `renovate.json`, `release.yml` stamping, cosign, syft, OIDC,
  owner preconditions, benchmarks.

## Library facts

- Type stripping is on by default and stable in Node 24; the opt-out is
  `--no-strip-types`; `--experimental-strip-types` no longer exists in the
  docs, do not put it in scripts. VERIFIED (node-stack-facts.md:64-77).
- `node --test` default discovery already includes `*.test.ts`; pass explicit
  quoted globs anyway so `node_modules` is never scanned. VERIFIED
  (node-stack-facts.md:121-129).
- `mock.timers.enable({ apis: ['setTimeout','setInterval','setImmediate',
  'Date'], now })`, `tick(ms)`, `runAll()`, `setTime()`. VERIFIED
  (node-stack-facts.md:164-169).
- `after()` is guaranteed to run; `t.after()` is per-test teardown; `t.waitFor`
  and `t.plan` exist. VERIFIED (node-stack-facts.md:152-155, 174-176).
- `@kubernetes/client-node` 2.x: `ApiException {code, body, headers}` for
  non-2xx; network, `TimeoutError` and `AbortError` are not `ApiException`
  (VERIFIED, node-stack-facts.md:305-312). An `http:` server in a kubeconfig
  throws unless `insecure-skip-tls-verify: true` is set (VERIFIED,
  node-stack-facts.md:227-228): `test/fake-kube` must write that flag.
- A watch is torn down after 30 s of inactivity and re-established; the
  informer stops for good on any other error and must be restarted by krun
  (VERIFIED, node-stack-facts.md:350-360, 387-397): fake-kube tests of
  informer restart must emit a non-timeout error.
- `@kubernetes/client-node` depends on `@types/node ^26` while krun pins 24;
  expect duplicate global types and fix via pnpm `overrides` (dependency
  VERIFIED, consequence UNVERIFIED, node-stack-facts.md:420-424).
- pnpm 10: list `better-sqlite3` in `onlyBuiltDependencies` or its native
  binary is never built. UNVERIFIED but high-risk (node-stack-facts.md:805-809,
  916-917); confirm against the `pnpm` skill before P0.1.
- better-sqlite3 13.x Node 24 (ABI 137) prebuilt availability UNVERIFIED
  (node-stack-facts.md:670-675); if absent the Docker build stage needs
  python3 and build tools, which the Dockerfile must then add (P0.3).
- biome 2 uses `files.includes` with negations, not `ignore`. UNVERIFIED
  (node-stack-facts.md:789-798).

## Lessons from KEDA, Knative and Dapr

- Ordered want-lists with induced failures: each table row declares initial
  objects, the key, and the exact `wantCreates/wantDeletes/wantPatches`;
  `induceFailure('create','jobs')` returns a deterministic message the
  assertion embeds verbatim (knative-serving `vendor/knative.dev/pkg/reconciler/testing/table.go:44-113`, `pkg/reconciler/revision/table_test.go:62-135`).
- A fixed, injected clock: "we don't care about the value, but that it does
  not change, since it leads to flakes" (knative-serving `table_test.go:130-133`).
- Tri-state polling predicate `(done, err)`: `Ready=False` with the current
  generation fails immediately with reason and message (knative-serving
  `test/v1/revision.go:33-86`).
- HA test: scale to 2, delete the Lease holder pod, assert a queued run still
  gets exactly one Job within lease + retry (knative-serving
  `test/ha/controller_test.go:48-76`); krun does this in P7.6.
- Deadline propagation is asserted on the fake: the recorded call carries
  `now + timeout` within 10 ms (keda `pkg/scaling/executor/scale_jobs_test.go:479-534`);
  do the same for the 10 s `AbortSignal.timeout` in P4.3a.
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
  `daprd.go:256-307`); this is the P3.7 and P4.11 shape.
- A fake kube-apiserver streams one chunked watch response per watcher; the
  "one event per connection" design cost seconds per event via reflector
  backoff (dapr `tests/integration/framework/process/kubernetes/informer/informer.go:34-70`).
- Fake clocks: wait for the timer to be registered before stepping
  (dapr `pkg/apphealth/health_test.go:135-145`); with `mock.timers` enable the
  mock before the loop is constructed.

## Pitfalls

- A `.ts` test importing a workspace package by name may hit Node's
  no-stripping-under-`node_modules` rule; see Library facts.
- `mock.timers` without `Date` leaves `Date.now()` real: lease and heartbeat
  tests pass locally and flake in CI.
- `KRUN_WEBHOOK_ALLOWED_CIDRS` must list the kind pod and Service CIDRs or
  the in-cluster receiver is rejected `CALLBACK_NOT_ALLOWED` (PLAN.md:600-603,
  SPEC.md:1472 D31).
- A fake-kube kubeconfig with `http://` and no `insecure-skip-tls-verify`
  throws before the first request.
- `pnpm audit --prod --audit-level=critical` fails the build on a transitive
  critical with no fix; do not suppress, open a Decisions row or pin
  (PLAN.md:155-156).
- Trivy with `--ignore-unfixed` still fails on fixable criticals in the
  distroless base: bump the digest, never widen `--severity` (PLAN.md:156).
- `helm/kind-action` and the local `kind` must be the same version
  (PLAN.md:46-47, 589-590) or the enforcement probe passes locally and fails
  in CI.
- `docker push` output's `digest:` line is the only source of the image
  digest for P8.6 (PLAN.md:810-813); never compute it from the local image id.
- The P9.4 quickstart timeout is 1800 s per mode (PLAN.md:860-864); budget
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
- kind recipe details (containerd `hosts.toml`, registry ConfigMap) follow
  kind's documented recipe and are UNVERIFIED against kind 0.24+ here;
  re-read kind's "Local Registry" page when writing P4.12.
- Benchmark numbers (P9.3) are measured on kind on the CI runner; the README
  must say so.
