# Failure matrix (SPEC.md section 5 rules and section 8 "Failure detection")

Serves PLAN P4.4 (PLAN.md:523-542), P4.8 (PLAN.md:562-575), P4.9
(PLAN.md:576-587). Sources: SPEC.md:367-381 (error and `failureReason`
precedence), SPEC.md:847-860 (`jobStatus` fields), SPEC.md:877-919 (failure
detection), SPEC.md:1136-1140 (metrics). Line numbers verified against the
working tree on 2026-10-23; re-check before citing.

## Kubernetes signal -> run fields

`jobStatus` is derived on every Job or Pod event from the cached Job and
pod (SPEC.md:852-858). `failureReason`, `error.source` and `logTail` are
fixed at the terminal transition. One row per signal; when several rows
apply, the precedence sections below decide.

| Kubernetes signal | `jobStatus` (`phase`, `reason`, `message`, `exitCode`) | run `state` | `failureReason` | `error.source` | `logTail` | Metric |
|---|---|---|---|---|---|---|
| pod condition `PodScheduled=False` reason `Unschedulable` | `Pending`, `Unschedulable`, condition message, - | stays `scheduled` | none yet; `deadline_exceeded` when the Job later fails with `DeadlineExceeded` | `kubernetes` at the end unless the function reported | null (container never ran) | `krun_runs_failed_total{reason="deadline_exceeded"}` at the end |
| `function` container `waiting` reason `ImagePullBackOff` / `ErrImagePull` / `CreateContainerConfigError` | `Pending`, that reason, waiting message, - | stays `scheduled` (PLAN.md:536-537) | `deadline_exceeded` once the Job condition `Failed` reason `DeadlineExceeded` arrives | `kubernetes` | null | `krun_runs_failed_total{reason="deadline_exceeded"}` |
| pod phase `Running` | `Running`, -, -, - | `scheduled -> running` (SPEC.md:861) | - | - | - | `krun_cold_start_seconds{function}` scheduled -> running (SPEC.md:1138) |
| `function` container `terminated` exit 0, then Job condition `Complete=True` | `Succeeded`, -, -, `0` | `running -> succeeded`, or `scheduled -> succeeded` when `running` was never observed (SPEC.md:861-863) | - | - | never fetched (SPEC.md:894) | `krun_run_duration_seconds{function,state="succeeded"}` |
| `function` container `terminated` exit N != 0, reason `Error` | `Failed`, `Error`, terminated message, `N` | `-> failed` on Job condition `Failed=True` | `exit_code` | `function` if it called `PUT error`, else `kubernetes` (`Error` + message) | fetched on the first pod event showing exit N (SPEC.md:890-893) | `krun_runs_failed_total{reason="exit_code"}`, `krun_terminal_detect_seconds{function}` from `terminated.finishedAt` to the CAS (SPEC.md:887-889) |
| `function` container `terminated` reason `OOMKilled` (exit 137) | `Failed`, `OOMKilled`, message, `137` | `-> failed` | `oom_killed` | `function` if reported, else `kubernetes` (`OOMKilled`) | fetched on the first `OOMKilled` pod event | `krun_runs_failed_total{reason="oom_killed"}`, `krun_terminal_detect_seconds` |
| Job condition `Failed=True` reason `DeadlineExceeded` (`activeDeadlineSeconds` hit) | from the pod if any; `reason` `DeadlineExceeded` from the Job condition | `-> failed` from `scheduled` or `running` | `deadline_exceeded` (beats `exit_code`; the kubelet kills the pod with SIGTERM, exit 143) | `function` if reported, else `kubernetes` (`DeadlineExceeded` + condition message) | fetched when the pod carries `deletionTimestamp` or a non-zero exit; null when the pod is already gone | `krun_runs_failed_total{reason="deadline_exceeded"}` |
| pod `status.reason` `Evicted` (node pressure, ephemeral-storage limit SPEC.md:1030-1031) | `Failed`, `Evicted`, pod `status.message`, exit if present | `-> failed` once the Job condition `Failed=True` arrives | `evicted` | `kubernetes` (`Evicted` + message) unless reported | fetched on `deletionTimestamp` or non-zero exit; often null | `krun_runs_failed_total{reason="evicted"}` |
| pod condition `DisruptionTarget=True` (preemption, node drain, taint eviction after the 60 s toleration; K8s >= 1.29 SPEC.md:1433-1434) | phase as seen, `DisruptionTarget` reason from the condition (`PreemptionByScheduler`, `DeletionByTaintManager`, `EvictionByEvictionAPI`, `TerminationByKubelet`), condition message | `-> failed` on Job `Failed=True` | `disrupted` | `kubernetes` unless reported | fetched on `deletionTimestamp` (SPEC.md:891-892); null when the node is gone | `krun_runs_failed_total{reason="disrupted"}` |
| Job `Failed=True` and the `function` container has no `terminated` state (pod vanished, node lost) | last known pod fields or just `Failed` | `-> failed` | `disrupted` (SPEC.md:885-887) | `kubernetes` (Job condition reason and message) unless reported | null (SPEC.md:895) | `krun_runs_failed_total{reason="disrupted"}` |
| heartbeat stale (`listStale` returns the run, cached Job not terminal, cached pod `Running`) | unchanged | `running -> failed` after a foreground Job delete (SPEC.md:906-911) | `heartbeat_timeout` | `function` if reported (store `coalesce`), else `krun` `"no status for <timeout>, last at <time>"` | fetched before the Job delete, always | `krun_runs_failed_total{reason="heartbeat_timeout"}` |
| Job absent from the informer cache for 2 minutes (SPEC.md:838-845, grace SPEC.md:1123) | last known | `scheduled`/`running -> failed`, `result` kept | `job_lost` | `function` if reported, else `krun` | null unless captured earlier | `krun_runs_failed_total{reason="job_lost"}`; alert `KrunJobLost` (docs/OPERATIONS.md:73) |
| permanent 4xx on Secret or Job create (SPEC.md:831-835) | null (no Job) | `queued -> failed` | `job_create_failed` | `krun`, `message` = API Status message, `details { code, reason }` | null | `krun_job_create_errors_total{function,code}`, `krun_runs_failed_total{reason="job_create_failed"}` |
| queued longer than `queueTimeout` (`expireQueued`, SPEC.md:808-814) | null | `queued -> failed` | `queue_timeout` | `krun` | null | `krun_runs_failed_total{reason="queue_timeout"}` |
| `cancelling` run (SPEC.md:836-837) | last known | `cancelling -> cancelled` after Job (foreground) and Secret delete | none (not `failed`) | unchanged | not fetched | `krun_runs_transitions_total{to="cancelled"}` |

Never derive `state` from `status.active`, `status.succeeded` or
`status.failed` counters; only conditions `Complete=True` and `Failed=True`
are terminal (keda `pkg/scaling/executor/scale_jobs.go:231-238,438-445`).
Kubernetes >= 1.31 also emits `SuccessCriteriaMet` and `FailureTarget`;
ignore them (keda.md section 1.3).

## `failureReason` precedence (SPEC.md:379-381)

`oom_killed` > `deadline_exceeded` > `evicted` > `disrupted` > `exit_code`.
Evaluate in that order over the cached Job and pod and take the first match:

1. `function` container `terminated.reason === 'OOMKilled'` -> `oom_killed`.
2. Job condition `Failed=True` with `reason === 'DeadlineExceeded'` ->
   `deadline_exceeded`.
3. pod `status.reason === 'Evicted'` -> `evicted`.
4. pod condition `DisruptionTarget=True`, or Job `Failed=True` with no
   `terminated` state on the `function` container -> `disrupted`.
5. otherwise -> `exit_code` (the `terminated.exitCode` goes to
   `jobStatus.exitCode`).

Knative orders failure evidence unschedulable > terminated exit code >
waiting reason, and treats a waiting reason as final only after a deadline
(serving `pkg/reconciler/revision/reconcile_resources.go:103-131,285-298`).
krun does the same: `ImagePullBackOff` is only ever a `jobStatus.reason`
while `scheduled`; the Job's `activeDeadlineSeconds` is the deadline that
turns it into `deadline_exceeded`. There is no krun-side image-pull grace.

## `error` precedence (SPEC.md:367-373)

1. The function's own `PUT error` report (`source: function`); the store
   writes `error = coalesce(error, patch.error)`, so a report accepted
   before the terminal statement survives every path (informer, heartbeat,
   deadline, `job_lost`).
2. Kubernetes reason and message (`source: kubernetes`): the pod condition
   or container state that produced `jobStatus.reason`/`message`, else the
   Job `Failed` condition's reason and message.
3. krun's own reason (`source: krun`): `heartbeat_timeout`, `job_lost`,
   `job_create_failed`, `queue_timeout` messages.

`failureReason` still says why krun ended the run even when `error.source`
is `function`. A function that reports an error and exits 0 still succeeds:
the exit code is the truth (SPEC.md:375-376). Never log `error.details`
(SPEC.md:1151-1153).

## `logTail` capture (SPEC.md:890-899, PLAN.md:562-565)

| Trigger (first Pod event showing it) | Fetch |
|---|---|
| `function` container `terminated.exitCode !== 0` | yes |
| `function` container `terminated.reason === 'OOMKilled'` | yes |
| pod `metadata.deletionTimestamp` set | yes |
| `terminated.exitCode === 0` | never |
| terminal Job event arrives before any of the above | fetch then, once |
| pod already gone (not in the cache) | `logTail` stays null |

Call `coreV1.readNamespacedPodLog({ name, namespace, container: 'function',
tailLines: 100, limitBytes: 16384 })` once per run, keep the string in a
leader-local `Ref<Map<runId, string | null>>` (created in the leader
scope) until the terminal CAS, then drop it. The call goes through the
`Kube` service, so it is bounded by its 10 s `Effect.timeout` and the
request is aborted on timeout; on the timeout or any `KubeApiError` leave
`logTail` null and continue (`Effect.orElseSucceed(() => null)` or the
Effect 4 equivalent; SPEC.md:896-897). A hanging stub in the test is
released with `TestClock.adjust("10 seconds")`. `limitBytes` may
cut the first line mid-way; that is acceptable. Fetch before any delete,
always: terminal path and heartbeat path both read the log before the Job
or Secret goes (SPEC.md:898-899, SPEC.md:906-908). `logTail` is FULL-view
only (SPEC.md:241) and is separate from `error` (PLAN.md:567-568).

## Metrics on this path (SPEC.md:1134-1140)

| Metric | When | Labels |
|---|---|---|
| `krun_runs_transitions_total` | every successful CAS | `function`, `to` |
| `krun_runs_failed_total` | terminal `failed` | `function`, `reason` = `failureReason` |
| `krun_cold_start_seconds` | `scheduled -> running` | `function`; `scheduleTime` to `startTime` |
| `krun_run_duration_seconds` | `running -> terminal` | `function`, `state`; `startTime` to `endTime` |
| `krun_terminal_detect_seconds` | terminal CAS after a container exit | `function`; `terminated.finishedAt` (parsed into a `DateTime`) to the CAS time from `Clock`; target 10 s (SPEC.md:887-889, docs/PROBLEM.md) |

Keep histogram label sets to `function` only; KEDA made high-cardinality
histogram labels opt-in after they exploded (keda
`pkg/metricscollector/prommetrics.go:272-278`). Only the leader publishes
these (SPEC.md:1134-1140); flip `krun_scheduler_leader` to 0 and stop
publishing on loss.

## Acceptance cases (PLAN.md:569-575, PLAN.md:535-542)

- Exit 3: `failed`, `exit_code`, `jobStatus.exitCode` 3, `logTail` fetched
  on the pod event before the Job `Failed` event.
- Reported error survives as `error.source: function`; `failureReason`
  still set.
- `OOMKilled` -> `oom_killed`; `DisruptionTarget` -> `disrupted`.
- Hanging `pods/log` -> timeout, `logTail` null, run still ends `failed`.
- Pod gone before any fetch -> `error.source: kubernetes` with the Job
  condition reason, `logTail` null.
- `ImagePullBackOff` pod -> run stays `scheduled`, `jobStatus.reason`
  `ImagePullBackOff`, one `run_events` row with reason `job_status`.
- `Complete` on a `scheduled` run -> `succeeded`, `startTime` from
  `terminated.startedAt`, else the Job `status.startTime` (SPEC.md:359-362).
