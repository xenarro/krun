# Phase gates (PLAN.md section 4, verbatim)

Run the gate at the end of the phase, after every task is `[x]` and
`make check` is green (PLAN.md:17-18). Each gate below quotes PLAN.md and
adds the command and the "green" definition. Line numbers are against the
working tree on 2026-10-23; re-check before citing.

## Phase 0: scaffold (PLAN.md:129)

> Gate: `make check` green in CI on an empty but wired repository.

- [ ] `make check` passes locally (`make lint` = `biome check` + `tsc --noEmit`
      per package; `make test` = `pnpm -r test` + `uv run --directory sdk/python pytest`).
- [ ] The first pull request shows a green `ci.yml` run (`gh run watch`,
      PLAN.md:158-159).
- [ ] `make helm-lint` passes on the stub chart (PLAN.md:143-146).
- [ ] `make docker` builds and `docker run <image> gateway` prints `gateway`
      (PLAN.md:151-152).
- [ ] `release.yml` dry-run job passes on the pull request, or the progress
      log carries `BLOCKED P0.9: <owner precondition>` (PLAN.md:192-201).

## Phase 1: store (PLAN.md:205-208)

> Gate: `node --test 'packages/shared/src/store/**/*.test.ts'` runs the
> contract suite against SQLite on a temp-file database (`fs.mkdtemp` under
> `os.tmpdir()`, removed in `after`) and against Postgres via testcontainers,
> both green.

- [ ] The same contract suite file list runs against both dialects (one
      `describe` per dialect importing the shared suite, `krun-store`).
- [ ] The Postgres run needs Docker; without it the suite must fail, not
      skip silently (rule 8 in SKILL.md).
- [ ] The `explain` test names `runs_active_idx` on both dialects
      (SPEC.md:547-549, `krun-store`).

## Phase 2: webhooks, functions and auth (PLAN.md:296-298)

> Gate: `node --test 'packages/shared/src/webhook/**/*.test.ts'
> 'packages/shared/src/functions/**/*.test.ts'
> 'packages/shared/src/auth/**/*.test.ts'` green, no cluster needed.

- [ ] No test in these globs opens a socket to anything but `127.0.0.1`
      listeners it started itself; DNS is stubbed.
- [ ] `docker run -v "$PWD/fixtures:/f:ro" <image> validate /f/tag-image.yaml`
      prints one line and exits 1 (P2.5, PLAN.md:340-342).

## Phase 3: gateway (PLAN.md:346-348)

> Gate: `node --test 'apps/gateway/src/**/*.test.ts'` green against SQLite in
> memory, plus one route test that POSTs then GETs a run against
> testcontainers Postgres.

- [ ] P3.7 process test against `test/fake-kube` passes (PLAN.md:415-421):
      `/readyz` 200 on the admin port, `/v1/*` 404 there, drain answers 200
      after `/readyz` turned 503, exit 0 within 5 s of SIGTERM.
- [ ] `make generate` leaves no diff for `docs/api/openapi-public.json` and
      `docs/api/openapi-internal.json` (PLAN.md:364-369, 435-441).

## Phase 4: scheduler core (PLAN.md:449-461)

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

- [ ] `make kind-up` created the cluster, the registry and passed the
      enforcement probe (P4.12, `references/kind-recipe.md`).
- [ ] The five scenarios in `references/e2e-scenarios.md` "Phase 4" are
      green locally and in the `ci.yml` kind job (P4.13).
- [ ] `make kind-down` removes the cluster and `kind-registry`.

## Phase 5: wait, SSE, webhooks (PLAN.md:598-603)

> Gate: e2e adds a `?wait=30s` scenario on `CreateRun` returning 201 with
> `state: SUCCEEDED` and the inline `result`, then a `POST ...:wait` on the
> same run returning 200 with the same terminal run, and an in-cluster webhook
> receiver pod, reachable through
> `KRUN_WEBHOOK_ALLOWED_CIDRS` set to the kind pod and Service CIDRs, that
> records one signed delivery and verifies the timestamped signature.

- [ ] Receiver pod deployed from `test/e2e/receiver.yaml`; its CIDRs come
      from `kubectl cluster-info dump | grep -m1 cluster-cidr` and the
      Service CIDR of the kind config, not hard-coded defaults.
- [ ] P5.4 scenarios green (`references/e2e-scenarios.md` "Phase 5").

## Phase 6: object storage (PLAN.md:633-635)

> Gate: e2e with MinIO in kind: a function uploads a 1 MB result, the run
> shows `resultUri`, `GetRunResult` returns 307 to a URL that
> serves the object.

- [ ] MinIO deployed from `test/e2e/minio.yaml` with the raw egress
      NetworkPolicy in the jobs namespace manifests (P6.3, PLAN.md:648-650).
- [ ] P6.1 unit test ran against a MinIO testcontainer, not against kind.

## Phase 7: Helm chart (PLAN.md:654-658)

> Gate: `make helm-lint` green; `helm template` renders both modes; e2e
> switches to installing the chart instead of raw manifests, in embedded
> mode and in postgres mode with a plain Postgres Deployment from
> `test/e2e/postgres.yaml`, each into a fresh krun namespace labelled
> `pod-security.kubernetes.io/enforce=restricted`.

- [ ] Raw jobs-namespace manifests deleted from the e2e flow; only the CRD
      is still applied with `kubectl` when `crds.install=false` is tested.
- [ ] P7.6 matrix green in both modes (`references/e2e-scenarios.md`
      "Phase 7"), including the two-scheduler leader check and the
      upgrade/rollback scenario.
- [ ] `promtool check rules` passes on the rendered PrometheusRule (P7.7).

## Phase 8: SDKs and CLI (PLAN.md:760-762)

> Gate: `krun init` for both languages yields a project whose tests pass and
> whose image builds against vendored packed SDKs; e2e runs one SDK-built
> function per language on kind.

- [ ] P8.4 and P8.5 acceptance commands run verbatim in a temp dir
      (PLAN.md:802-803, 807-808).
- [ ] P8.6 pushes both template images to `localhost:5001/<name>` and
      references them by the `digest:` line of the push output.
- [ ] `test/sdk-conformance` passes in both suites; reordering one SDK's
      calls fails its suite (PLAN.md:797-798).

## Phase 9: hardening, benchmarks, README, release (PLAN.md:829-830)

> Gate: all e2e scenarios green; README states measured numbers and the
> "when not to use krun" section; `release.yml` dry-run green.

- [ ] P9.1 backpressure, P9.2 security, P9.4 quickstart (both modes,
      1800 s each), P9.6 drill green.
- [ ] P9.3 numbers in README and docs/OPERATIONS.md with the measurement
      conditions (kind, runner size, image cached).
- [ ] The alert-name check script passes (P9.6, PLAN.md:873-877).
- [ ] Release pull request prepared; the owner tags (PLAN.md:22, 865-872).

## Definition of done for v1 (PLAN.md:879-884)

- Every task in Phases 0 to 9 is checked.
- `make check` and `make e2e` are green on CI.
- README quick start works on a fresh kind cluster in both database modes.
- No row in SPEC.md section 15 is contradicted by the code.
