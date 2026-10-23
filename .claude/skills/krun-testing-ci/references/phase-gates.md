# Phase gates (PLAN.md section 4, verbatim)

Run the gate at the end of the phase, after every task is `[x]` and
`make check` is green (PLAN.md:17-18). Each gate quotes PLAN.md exactly
(re-read against the working tree on 2026-10-23; re-check the line numbers
before citing) and adds the command and the "green" definition.

## Phase 0: scaffold (PLAN.md:146)

> Gate: `make check` green in CI on an empty but wired repository.

- [ ] `make check` passes locally: `make lint` = `biome check` and
      `tsc --noEmit` (TypeScript 7) in every package (P0.2, PLAN.md:161-162);
      `make test` = `pnpm -r exec vitest run` plus
      `uv run --directory sdk/python pytest` (PLAN.md:51, 137-138).
- [ ] Every package has a `vitest.config.ts` and the `@effect/vitest` smoke
      test passes; `pnpm -r build && node bin/krun.js gateway` prints
      `gateway` (P0.1, PLAN.md:155-158).
- [ ] The first pull request shows a green `ci.yml` run (`gh run watch`,
      P0.4, PLAN.md:176-178); `actionlint` passes.
- [ ] `make helm-lint` passes on the stub chart (P0.2, PLAN.md:162-165).
- [ ] `make docker` builds and `docker run <image> gateway` prints `gateway`
      (P0.3, PLAN.md:170-171).
- [ ] P0.7: `@effect/vitest` test with Fastify `inject` and `TestClock`,
      including a stalled database check (PLAN.md:196-197).
- [ ] P0.8: `make generate` twice leaves no diff (PLAN.md:209-212).
- [ ] `release.yml` dry-run job passes on the pull request, or the progress
      log carries `BLOCKED P0.9: <owner precondition>` (PLAN.md:213-222).

## Phase 1: store (PLAN.md:226-229)

> Gate: `pnpm exec vitest run packages/shared/src/store` runs the
> contract suite against SQLite on a temp-file database (`fs.mkdtemp` under
> `os.tmpdir()`, removed in `after`) and against Postgres via testcontainers,
> both green.

- [ ] One shared contract suite runs against both dialects (one `describe`
      or `layer(...)` block per dialect providing the `Store` layer;
      `krun-store`). "Removed in `after`" is Vitest `afterAll` or the
      layer's `Effect.acquireRelease` finalizer.
- [ ] The Postgres run needs Docker; without it the suite fails, not skips
      (SKILL.md rule 13).
- [ ] The `explain` tests name `runs_active_idx` (P1.4, PLAN.md:259-262) and
      `runs_created_idx` (P1.6, PLAN.md:282-283).
- [ ] Lease and staleness tests move time with `TestClock`, not sleeps.

## Phase 2: webhooks, functions and auth (PLAN.md:317)

> Gate: `pnpm exec vitest run packages/shared/src/webhook packages/shared/src/functions packages/shared/src/auth` green, no cluster needed.

- [ ] No test in these paths opens a socket to anything but `127.0.0.1`
      listeners it started itself; DNS is stubbed.
- [ ] fast-check properties for the address check (P2.1) pass.
- [ ] `docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
      prints its line and exits 1 (P2.5, PLAN.md:359-361).

## Phase 3: gateway (PLAN.md:365-367)

> Gate: `pnpm exec vitest run apps/gateway/src` green against SQLite in
> memory, plus one route test that POSTs then GETs a run against
> testcontainers Postgres.

- [ ] P3.7 process test (spawned `bin/krun.js gateway`, `KUBECONFIG` at
      `test/fake-kube`) passes (PLAN.md:432-441): `/readyz` 200 on the
      admin port, `/v1/*` 404 there, a `/v1` request after `/readyz` turned
      503 still answers 200 with `KRUN_SHUTDOWN_DELAY=2s`, exit 0 within
      5 s of SIGTERM.
- [ ] `make generate` leaves no diff for `docs/api/openapi-public.json`
      (P3.1c, PLAN.md:383-388) and `docs/api/openapi-internal.json` (P3.8,
      PLAN.md:459-461).

## Phase 4: scheduler core (PLAN.md:469-481)

> Gate: `make e2e` on kind in embedded mode: submit a run for a
> `curlimages/curl` function shaped like docs/INTERNAL-API.md section 9
> (`set -e`, `--fail-with-body`, retries) that fetches its input, posts one
> status and PUTs the input back as its result, observe `succeeded` with the result and
> `runtimeStatus`; a function that exits 1 ends `failed` within 10 seconds
> with `failureReason` `exit_code` and `logTail` set; a function with an
> unpullable image and a 60 second deadline shows `jobStatus.reason`
> `ImagePullBackOff` while `scheduled`, then ends `failed` with
> `deadline_exceeded`; a function that posts two statuses then exits 3 ends
> `failed` with `exit_code`, `jobStatus.exitCode` 3 and `logTail` within 10
> seconds; a function with `heartbeatTimeout: 30s` that posts one status then
> sleeps ends `failed` with `heartbeat_timeout` within 60 seconds, `logTail`
> set, Job gone.

- [ ] P4.1-P4.10 unit tests run on the fake `Kube` layer with `TestClock`
      (`references/fake-kube.md` part 1); P4.6 and P4.11 process tests on
      `test/fake-kube` (part 2).
- [ ] `make kind-up` created the cluster and the registry and passed the
      enforcement probe (P4.12, PLAN.md:600-612, `references/kind-recipe.md`).
- [ ] The five scenarios in `references/e2e-scenarios.md` "Phase 4" are
      green locally and in the `ci.yml` kind job (P4.13, PLAN.md:613-614).
- [ ] `make kind-down` removes the cluster and `kind-registry`.

## Phase 5: wait, SSE, webhooks (PLAN.md:618-623)

> Gate: e2e adds a `?wait=30s` scenario on `CreateRun` returning 201 with
> `state: SUCCEEDED` and the inline `result`, then a `POST ...:wait` on the
> same run returning 200 with the same terminal run, and an in-cluster webhook
> receiver pod, reachable through
> `KRUN_WEBHOOK_ALLOWED_CIDRS` set to the kind pod and Service CIDRs, that
> records one signed delivery and verifies the timestamped signature.

- [ ] Receiver pod deployed from `test/e2e/receiver.yaml`; its CIDRs are
      read from the cluster (`kubeadm-config` `podSubnet`, `serviceSubnet`),
      not hard-coded.
- [ ] P5.4 scenarios green (`references/e2e-scenarios.md` "Phase 5",
      PLAN.md:646-649).

## Phase 6: object storage (PLAN.md:653-655)

> Gate: e2e with MinIO in kind: a function uploads a 1 MB result, the run
> shows `resultUri`, `GetRunResult` returns 307 to a URL that
> serves the object.

- [ ] MinIO deployed from `test/e2e/minio.yaml` with the raw egress
      NetworkPolicy in the jobs namespace manifests (P6.3, PLAN.md:668-670).
- [ ] P6.1 unit test ran against an `@testcontainers/minio` container, not
      against kind (PLAN.md:657-661).

## Phase 7: Helm chart (PLAN.md:674-678)

> Gate: `make helm-lint` green; `helm template` renders both modes; e2e
> switches to installing the chart instead of raw manifests, in embedded
> mode and in postgres mode with a plain Postgres Deployment from
> `test/e2e/postgres.yaml`, each into a fresh krun namespace labelled
> `pod-security.kubernetes.io/enforce=restricted`.

- [ ] Raw jobs-namespace and krun manifests deleted from the e2e flow; the
      CRD is applied with `kubectl` only in the `crds.install=false` case.
- [ ] Chart render assertions (Vitest over `helm template` output, owned by
      `krun-helm-chart`) pass under the Helm 4 version pinned in CI.
- [ ] P7.6 matrix green in both modes (`references/e2e-scenarios.md`
      "Phase 7", PLAN.md:758-771), including the two-scheduler leader check
      and the upgrade/rollback scenario.
- [ ] `promtool check rules` passes on the rendered PrometheusRule (P7.7,
      PLAN.md:772-776).

## Phase 8: SDKs and CLI (PLAN.md:780-782)

> Gate: `krun init` for both languages yields a project whose tests pass and
> whose image builds against vendored packed SDKs; e2e runs one SDK-built
> function per language on kind.

- [ ] P8.4 and P8.5 acceptance commands run verbatim in a temp dir
      (PLAN.md:822-829). The Node template's `npm test` is the function
      author's own dependency-free test (it may use `node --test`); it is
      not a krun test and does not run under Vitest.
- [ ] `sdk/python` passes `pytest`, `ruff check` and `mypy --strict`
      (STACK.md:127-128); `packages/sdk-node` `package.json` lists no
      `dependencies` (PLAN.md:803-805).
- [ ] `test/sdk-conformance` passes in both suites (Node SDK under Vitest,
      Python under pytest); reordering one SDK's calls fails its suite
      (P8.3, PLAN.md:811-818).
- [ ] P8.6 pushes both template images to `localhost:5001/<name>` and
      references them by the `digest:` line of the push output
      (PLAN.md:830-837).

## Phase 9: hardening, benchmarks, README, release (PLAN.md:849-850)

> Gate: all e2e scenarios green; README states measured numbers and the
> "when not to use krun" section; `release.yml` dry-run green.

- [ ] P9.1 backpressure, P9.2 security, P9.4 quickstart (both modes,
      1800 s each), P9.6 drill green (PLAN.md:852-897).
- [ ] P9.3 numbers in README and docs/OPERATIONS.md with the measurement
      conditions (kind, runner size, image cached; PLAN.md:867-870).
- [ ] The alert-name check script passes (P9.6, PLAN.md:893-897).
- [ ] Release pull request prepared; the owner tags (PLAN.md:22, 885-892).

## Definition of done for v1 (PLAN.md:899-904)

> - Every task in Phases 0 to 9 is checked.
> - `make check` and `make e2e` are green on CI.
> - README quick start works on a fresh kind cluster in both database modes.
> - No row in SPEC.md section 15 is contradicted by the code.
