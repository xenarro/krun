---
title: Troubleshooting
description: Diagnose failed and stuck runs from failureReason, error and logTail, decode API and CLI errors, and inspect a run's Job.
sidebar:
  order: 8
---

Start every investigation with the run itself. The full Run view carries everything
krun knows:

```sh title="Terminal"
curl -s -H "Authorization: Bearer $KRUN_API_KEY" \
  "$KRUN_API_URL/v1/functions/-/runs/<id>" \
  | jq '{state, failureReason, error, jobStatus, logTail}'
```

- `state` and `failureReason` say what happened. Branch on them, never on
  `error.message`.
- `error.source` says who reported the error: `FUNCTION` (the function called the
  error endpoint), `KUBERNETES` (a pod or Job reason such as `ImagePullBackOff`) or
  `KRUN` (krun ended the run itself). A function's own report always wins.
- `jobStatus` is the scheduler's view of the Job and pod: `podName`, `phase`,
  `reason`, `message` and `exitCode`, taken from Kubernetes alone.
- `logTail` holds the last 100 log lines (at most 16 KB) of a failed run whose
  container ran. It is the only log krun keeps after the Job is deleted.

## Failure reasons

Every `FAILED` run carries exactly one `failureReason`.

| `failureReason` | What happened | What to check |
|---|---|---|
| `EXIT_CODE` | The container exited with a nonzero code. | `error` (the function's own report, if any) and `logTail`. A result that could not be written is reported as `ResultWriteError`. |
| `OOM_KILLED` | The container exceeded its memory limit. | Raise `resources.limits.memory` in the Function, within the jobs namespace LimitRange `max` (8Gi by default). |
| `DEADLINE_EXCEEDED` | The Job ran past `activeDeadlineSeconds`. | Whether the work needs a longer deadline (up to `KRUN_MAX_ACTIVE_DEADLINE`), whether it hung, or whether the pod never started; see `jobStatus.reason`. |
| `EVICTED` | The kubelet evicted the pod, for example for exceeding its ephemeral-storage limit. | `/tmp` usage plus logs against the ephemeral-storage limit (2Gi by default); node pressure. |
| `DISRUPTED` | The pod was disrupted (for example preempted or drained), or the Job failed without the container terminating. | Node events, preemption and drains. Submit a new run; there are no automatic retries. |
| `HEARTBEAT_TIMEOUT` | The function set `heartbeatTimeout` and reported no status for that long while running. The Job is deleted. | `error.message` (`no status for <timeout>, last at <time>`), `logTail`, CPU-bound code that starves heartbeats, and whether the window is too short. |
| `JOB_CREATE_FAILED` | The Kubernetes API permanently rejected the Secret or Job (400, 403 RBAC, 404 or 422, including admission policies). | `error.message` and `error.details.code` / `error.details.reason`; admission policies on the jobs namespace; scheduler RBAC. |
| `JOB_LOST` | The Job disappeared for more than 2 minutes while the run was scheduled or running. | Someone deleting Jobs in the jobs namespace; node loss; scheduler downtime longer than `config.ttlAfterFinished`. |
| `QUEUE_TIMEOUT` | The run stayed `QUEUED` longer than the Function's `queueTimeout`. | Capacity: see [runs stuck in QUEUED](#runs-stuck-in-queued). |

When several container outcomes apply, the precedence is `OOM_KILLED`,
`DEADLINE_EXCEEDED`, `EVICTED`, `DISRUPTED`, then `EXIT_CODE`.

:::note[A reported error does not fail a run]
The exit code is the truth. A function that reports an error and then exits 0 still
`SUCCEEDED`. To fail, report the error and exit nonzero.
:::

## Runs stuck in QUEUED

A queued run waits for a free slot. Check, in order:

1. **Is the Function Ready?** `kubectl get kfn <name> -n krun`. The scheduler claims
   nothing for a Function that is not Ready.
2. **Is there a scheduler leader?**
   `kubectl get lease krun-scheduler -n krun -o jsonpath='{.spec.holderIdentity}'`.
   Without a leader the gateway still accepts runs, but nothing is scheduled
   (`KrunNoLeader`).
3. **Are slots free?** Each function runs at most `maxConcurrency` scheduled plus
   running runs, and the whole installation at most `KRUN_MAX_RUNNING`. Look at
   `krun_runs_current`.
4. **Is the quota refusing Jobs?** Only a 403 "exceeded quota" answer to krun's own
   Secret or Job create is transient (for example an object-count quota such as
   `count/jobs.batch`): the run stays queued and `krun_quota_rejections_total` grows
   (`KrunQuotaRejections`). Any other admission rejection of the Secret or Job,
   including a 403 that is not about quota, fails the run with `JOB_CREATE_FAILED`.
   Run `kubectl describe quota -n krun-jobs`.

A run that waits longer than `queueTimeout` (default `1h`) fails with
`QUEUE_TIMEOUT`.

## Runs stuck in SCHEDULED

The Job exists but the pod is not running. `jobStatus.reason` usually names the cause,
for example `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError` or
`Unschedulable`. krun does not fail fast on pods stuck before start: such a run ends at
`activeDeadlineSeconds` as `DEADLINE_EXCEEDED`. Check that the digest exists in the
registry, that `imagePullSecrets` are right, and that every `secretRefs` Secret exists
in the jobs namespace.

## Function not found

`404 FUNCTION_NOT_FOUND` has three indistinguishable causes: the Function does not
exist, it is not Ready, or it is outside your key's function globs. The message is
deliberately generic. Check the `Ready` condition with
`kubectl describe kfn <name> -n krun`; the reasons are listed in
[Writing a function](/krun/guides/writing-a-function/#validation-and-the-ready-condition).
Run `krun validate function.yaml` with the installation's ceilings exported to
reproduce the decision locally.

## API errors

| Status and reason | Cause | Fix |
|---|---|---|
| `401 KEY_MISSING`, `401 KEY_INVALID` | No bearer key, or an unknown one. | Send `Authorization: Bearer <key>`; after a rotation, wait for the 30-second reload. |
| `403 SCOPE_MISSING` | The key lacks the method's scope, or `runs:priority` for `priority` above 0. `metadata.scope` names it. | Ask the platform team for the scope. |
| `404 RUN_NOT_FOUND` | The run does not exist, or another key created it. | Use the key that created the run, or an `admin` key. |
| `400 INPUT_SCHEMA_VIOLATION` | `input` fails the Function's `inputSchema`. | Read `BadRequest.fieldViolations` in the error details. |
| `400 REQUEST_INVALID` | Malformed JSON, `null`, an unknown field or query parameter, a bad page token or duration, or `priority` out of range. | Fix the request; unknown fields are rejected on purpose. |
| `400 CALLBACK_NOT_ALLOWED` | The callback host is not allowed, or resolves to a disallowed address. | Ask the platform team to allow the host, or its CIDR for in-cluster receivers. |
| `400 RUN_TERMINAL` | CancelRun on a `SUCCEEDED` or `FAILED` run. | Nothing to cancel. |
| `400 RUN_NOT_TERMINAL` | GetRunResult before the run finished. | Wait first. |
| `404 RESULT_MISSING` | The run finished without a result. | Check `state` and `error`. |
| `409 IDEMPOTENCY_CONFLICT` | A `requestId` was reused with a different body. | Use a new `requestId` for a different request. |
| `413 INPUT_TOO_LARGE` | The body exceeds `maxInputBytes`. | Send a reference to the data instead of the data. |
| `415 CONTENT_TYPE_UNSUPPORTED` | The body is not `application/json`. | Set `Content-Type: application/json`. |
| `429 RATE_LIMITED` | The key's token bucket is empty. | Honor `Retry-After: 1`. |
| `429 QUEUE_FULL` | The function's or the key's `maxQueued` is reached; `metadata.limit` says which. | Honor `Retry-After`, slow down, or raise the limit. |
| `503 NOT_READY` | The database or Function informer is not ready yet. | Honor `Retry-After`; check gateway readiness. |

## CLI errors

`krun init` and `krun deploy` print a message and a `Try this:` hint on stderr, then
exit 1 (130 when the `init` language prompt is cancelled).

| Message | Meaning |
|---|---|
| `A registry is required.` | Pass `--registry` or set `KRUN_REGISTRY`. |
| `Invalid registry, namespace or API URL.` | The registry includes a scheme, credentials or tag; a namespace is not a DNS label; or the API URL has credentials, a query or a fragment. |
| `function.yaml must contain exactly one valid krun Function with metadata.name and spec.image.` | Fix `function.yaml`, or start with `krun init`. |
| `Docker push failed.` | Run `docker login` for your registry. |
| `Successful push did not identify a digest for this repository.` | Inspect the push output and the image's `RepoDigests`. |
| `Pinned function.yaml failed krun validate; nothing was applied.` | The pinned manifest violates a ceiling; the validation lines above the message say which. |
| `Function CRD is not installed.` | Install the platform chart with `crds.install=true`. |
| `Kubectl has no usable kubeconfig/context.` | Select the context your platform team approved. |
| `Function rejected: <reason>.` | The Function became `Ready=False`; run `kubectl describe kfn <name>`. |
| `Function was not Ready after 120 seconds: ...` | Usually no scheduler leader; the message shows the last status seen. |
| `Missing --lang on a non-interactive terminal.` | Pass `--lang node` or `--lang python`. |
| `Target contains "<file>".` | `krun init` needs an empty or absent directory. |

## Startup failures

A gateway or scheduler that exits at start logs one JSON line naming the first
invalid configuration variable, for example
`{"level":50,"msg":"Gateway startup or shutdown failed","variable":"KRUN_DB_DSN"}`.
Values are never logged. See [Configuration](/krun/guides/configuration/) for the
rules each variable must satisfy. A scheduler without `KRUN_POD_NAME` refuses to
serve, because the pod name is its Lease identity.

## Inspect a run's Job

While a run is `SCHEDULED` or `RUNNING`, its Job `krun-<run id>` and pod exist in the
jobs namespace with the labels `krun.io/run-id`, `krun.io/function` and
`krun.io/created-by`:

```sh title="Terminal"
kubectl get jobs,pods -n krun-jobs -l krun.io/function=reports-demo
kubectl get pod -n krun-jobs -l krun.io/run-id=<id> -o yaml
kubectl logs -f -n krun-jobs job/krun-<id>
```

The `krun-job-viewer` role allows reading pods, pod logs and Jobs in the jobs
namespace; it grants no Secret reads and no exec. Once the run is terminal the
scheduler deletes the Job and its Secret, so use `logTail` or your cluster's log
aggregation instead.

## Webhooks not arriving

- The callback host must match `webhooks.allowedHosts`; otherwise CreateRun fails with
  `CALLBACK_NOT_ALLOWED`.
- The resolved address must be public unicast, or inside `webhooks.allowedCIDRs`. The
  scheduler checks again at delivery time.
- Redirects are not followed, and only a `2xx` response acknowledges.
- After six failed attempts over about 15 hours the delivery is marked dead and
  `KrunDeliveriesDead` fires.
- Receivers must accept the signature within 300 seconds of its timestamp; check
  clock skew.
