# e2e scenario catalogue

- One file per scenario under `test/e2e/`, named after the failure mode or
  feature it proves (knative-serving `test/e2e/` layout).
- Per-file Function, cleanup and runner config: `kind-recipe.md`
  "Harness".
- All timing bounds come from PLAN.md. The assertion column is the minimum
  a reviewer checks for (docs/AGENT-KICKOFF.md:89-98).
- Function images follow the `curlimages/curl` shape from
  docs/INTERNAL-API.md:326-371 until Phase 8; pin by digest (SPEC.md:1091).
- Wire names: `state` values are UPPER_SNAKE on the API (`SUCCEEDED`,
  `FAILED`); `failureReason` values are lower snake (`exit_code`), per
  docs/API.md. Lowercase store names below quote PLAN.md and mean the API
  form.

## Phase 4 gate (PLAN.md:469-481, P4.13)

| File | Function | Assertion |
|---|---|---|
| `success.e2e.ts` | fetches input, posts one status, PUTs the input back as result | `SUCCEEDED`; `result` deep-equals the input; `runtimeStatus` carries the posted message and `reportTime` |
| `exit_code.e2e.ts` | `exit 1` | `FAILED` within 10 s of the pod ending; `failureReason: exit_code`; `logTail` non-empty |
| `image_pull_backoff.e2e.ts` | unpullable digest, `activeDeadlineSeconds` 60 | while `SCHEDULED`, `jobStatus.reason === 'ImagePullBackOff'`; then `FAILED` with `deadline_exceeded` |
| `exit_code_status.e2e.ts` | posts two statuses, `exit 3` | `FAILED` with `exit_code`, `jobStatus.exitCode === 3`, `logTail` set, within 10 s |
| `heartbeat_timeout.e2e.ts` | `heartbeatTimeout: 30s`, posts one status, sleeps | `FAILED` with `heartbeat_timeout` within 60 s; `logTail` set; the Job is deleted (`kubectl get job` 404) |

`enforcement_probe` runs inside `make kind-up`; it is not a scenario file
(PLAN.md:605-606). For "`make e2e` with zero scenarios" (PLAN.md:611-612)
make it `probe.e2e.ts` or set `passWithNoTests`.

## Phase 5 (PLAN.md:618-623, P5.4)

| File | Assertion |
|---|---|
| `wait.e2e.ts` | `POST .../runs?wait=30s` returns 201 with `state: SUCCEEDED` and the inline `result`; `POST .../runs/{run}:wait` on the same run returns 200 with the identical terminal run |
| `webhook.e2e.ts` | receiver records one delivery whose `X-Krun-Signature` verifies with `t=` and `v1=` (SPEC.md:1075-1084); a receiver configured to answer 500 once then 200 sees the same `X-Krun-Delivery` on both attempts (PLAN.md:646-648); with two secrets configured the header carries two `v1=` entries (PLAN.md:647-648) |

Preconditions: `KRUN_WEBHOOK_ALLOWED_CIDRS` holds the kind pod and Service
CIDRs (PLAN.md:621-623). The receiver verifies; the test reads its verdict.

## Phase 6 (PLAN.md:653-655, P6.3)

| File | Assertion |
|---|---|
| `large_result.e2e.ts` | function uploads a 1 MB result through `KRUN_RESULT_UPLOAD_URL`; the run shows `resultUri`; `GET ...:getResult` returns 307 with `Cache-Control: no-store`; fetching the `Location` serves 1 MB with the expected checksum |

Precondition: the raw `allow-minio` egress policy in the jobs namespace
(PLAN.md:668-670). After P7.6 the chart's `objectStorage.egress` replaces
it.

## Phase 7 (PLAN.md:674-678, 758-771, P7.6)

Run the matrix in both modes, each in a fresh namespace with PSA
`restricted`.

| File | Assertion |
|---|---|
| `chart_install.e2e.ts` | `helm install` succeeds; every pod Ready; `success.e2e.ts` body passes under the chart |
| `netpol_internal.e2e.ts` | a job pod reaches `krun-gateway-internal:8081` and cannot reach the public port 8080 (PLAN.md:760-761); in embedded mode the StatefulSet pod matches the 8081 policy (PLAN.md:761-762) |
| `netpol_metrics.e2e.ts` | admin ports 9090 (and 9091 in embedded mode) reachable from a pod in the `monitoring` namespace only when `networkPolicy.metricsFrom` selects it (PLAN.md:762-763, SPEC.md:1049-1057) |
| `leader_election.e2e.ts` | postgres mode, `scheduler.replicas=2`: exactly one pod reports leader on `/readyz`, `krun_scheduler_leader` is 1 on one pod; delete the holder pod; a queued run still gets exactly one Job within 15 s + 2 s and `holderIdentity` moved (PLAN.md:763-764; knative-serving `test/ha/controller_test.go:48-76`) |
| `upgrade_rollback.e2e.ts` | `helm upgrade --set config.logLevel=debug` then `helm rollback <release> 1`; after each: pods Ready, a run succeeds; postgres mode: the migrate hook Job ran; a run submitted during the rollout succeeds; `holderIdentity` and `krun_scheduler_leader` moved to the new pod; embedded mode: a run created before the upgrade is readable after it (PLAN.md:764-771); scheduler gap < `KRUN_TTL_AFTER_FINISHED` (SPEC.md:1416-1417) |
| `crds_install_false.e2e.ts` | with `crds.install=false` and the plain manifest applied first, the install succeeds and a Function becomes Ready |
| `admission_policy.e2e.ts` (P7.4d) | with `jobsNamespace.admissionPolicy` on, `kubectl create` of a Job whose image is a tag without `@sha256:` in the jobs namespace is rejected by the ValidatingAdmissionPolicy (assert the denial message names the policy); a digest-pinned Job is admitted (PLAN.md:766-771; needs a kind node image 1.33 or newer) |

## Phase 8 (PLAN.md:780-782, 830-837, P8.6)

Build both vendored template projects from `krun init`, `docker push` to
`localhost:5001/<name>`, reference `@sha256:` from the push output.

| File | Assertion |
|---|---|
| `sdk_node.e2e.ts` / `sdk_python.e2e.ts` | success: result equals the handler's return; thrown error: `FAILED`, `failureReason: exit_code`, `error.source: function`, `logTail` present; slow handler outliving `heartbeatTimeout` while the SDK pings: stays `RUNNING`, then `SUCCEEDED` (PLAN.md:833-836) |
| `deploy_update.e2e.ts` (P8.7) | `krun deploy --registry localhost:5001` ends `Ready=True` and prints the three commands; edit the handler, deploy again, a new run returns the new output and `function.yaml`'s digest changed (knative-func `e2e/e2e_core_test.go:164-206`); `--no-apply` leaves the cluster untouched (PLAN.md:838-845) |

## Phase 9 (PLAN.md:849-897)

| File | Task | Assertion |
|---|---|---|
| `backpressure.e2e.ts` | P9.1 | 3000 submissions against `maxQueued` 1000, `maxConcurrency` 5: 429 `QUEUE_FULL` after the cap; never more than 5 active Jobs (sample `kubectl get jobs` every second, assert the max); quota rejections leave runs `QUEUED`; a key with `maxQueued` 10 gets 429 on the 11th (PLAN.md:852-856) |
| `security.e2e.ts` | P9.2 | `kubectl get pod -o yaml` of a job pod contains neither the input nor the token (grep-for-absence of a random marker placed in the input); the job pod cannot reach the public port, the admin ports or the database (connect attempts time out); a run's token is 401 for another run id; a tag-only image is rejected at apply by the CRD (`kubectl apply` fails, `causes[].field`); a non-compiling `inputSchema` gives `Ready=False` and a POST 404 whose envelope carries no validation reason; a forbidden service account gives `ServiceAccountNotAllowed`; another key's run is 404 `RUN_NOT_FOUND`; a webhook to an unlisted `10.0.0.1` is 400 `CALLBACK_NOT_ALLOWED` (PLAN.md:857-866) |
| `scripts/bench.ts` | P9.3 | not a scenario file: `ci-release.md` "Benchmarks" (PLAN.md:867-870) |
| `quickstart.e2e.ts` | P9.4 | `scripts/quickstart.sh` on a fresh kind cluster in both modes with `KRUN_CHART` (local path), `KRUN_IMAGE`, `KRUN_CLI` (workspace), `KRUN_SDK_VENDOR`, `KRUN_REGISTRY`; each exits 0 within 1800 s; durations recorded in README (PLAN.md:871-884, docs/PROBLEM.md:78) |
| `restore_drill.e2e.ts` | P9.6 | embedded mode with Litestream: create a run; scale the StatefulSet to 0; delete `krun.db*` from the PVC via a throwaway pod; scale to 1; the run is readable after the restore (docs/OPERATIONS.md:94-105, PLAN.md:893-897) |
| `scripts/check-alert-names.ts` | P9.6 | every rule name in the docs/OPERATIONS.md alerts table exists in the rendered PrometheusRule (PLAN.md:893-894) |

## Failure modes without a dedicated file yet

- krun classifies `oom_killed`, `evicted`, `disrupted` (SPEC.md:381,
  882-887, `../../krun-scheduler-k8s/references/failure-matrix.md`).
  P4.8 unit tests on the fake `Kube` layer prove them (PLAN.md:562-575).
- No PLAN task asks for e2e files for them. `oom_killed.e2e.ts` (a
  function allocating past its memory limit under the LimitRange) is cheap
  but unlisted scope: ask in the task's pull request; do not add it
  silently (PLAN.md:31-32).
