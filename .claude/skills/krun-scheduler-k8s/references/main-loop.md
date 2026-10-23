# Scheduler main loop (SPEC.md section 8)

Serves PLAN P4.3b (PLAN.md:485-499), P4.3c (PLAN.md:500-502), P4.5
(PLAN.md:523-531). Line numbers verified against the working tree on
2026-10-23; re-check before citing.

## Triggers and deadline (SPEC.md:801-806, verbatim)

> Main loop, every 1 second and on each notify of kind `state`; `status` and
> `job_status` notifies are ignored by it. Iterations never overlap: a
> `state` notify during an iteration marks exactly one more. Each iteration
> carries a 10 second deadline checked between steps and between runs in
> step 4; past it, the leases of unprocessed claimed runs are released and
> the iteration ends.

Implementation shape (hand-written, no workqueue; PLAN.md:69-74):

```
let running = false, pending = false;
async function tick() {
  if (running) { pending = true; return; }     // coalesce: exactly one more
  running = true;
  try { await iteration(deadline = now + 10_000); }
  finally { running = false; if (pending) { pending = false; queueMicrotask(tick); } }
}
setInterval(tick, 1000);                        // plus store.subscribe(signal) -> kind === 'state' ? tick() : ignore
```

Two notifies during one iteration yield one extra iteration, not two
(acceptance in PLAN.md:498-499). Readiness of the loop: it runs only on the
leader and stops on Lease loss or SIGTERM (SPEC.md:776-779).

## Steps 1-6 (SPEC.md:808-845, verbatim)

> 1. Read `countByState`. For every function name with queued runs call
>    `expireQueued(fn, now - queueTimeout)`, using the cached Function's
>    `queueTimeout` when it is in the informer map (Ready or not) and parses,
>    else the CRD default 1h. Each expired run gets its `run_events` row,
>    notify and delivery; an expired run with `jobTokenHash` set also gets
>    its Job (foreground) and Secret deleted, as after a false
>    `markScheduled`.
> 2. Free slots per function are `maxConcurrency - (scheduled + running)`,
>    and globally `KRUN_MAX_RUNNING - sum(scheduled + running)`. Publish
>    `krun_runs_current` from the same `countByState` result.
> 3. For each Ready function with free slots, claim up to the smaller of the
>    two, lease 30 seconds.
> 4. For each claimed run, in this order: create the Secret with a fresh
>    token (`AlreadyExists`: read the existing token); `setJobToken` with the
>    Job name and the token hash; create the Job (`AlreadyExists` counts as
>    success); `markScheduled`; when it returns false, delete the Job with
>    foreground propagation and the Secret; when it returns true, run the
>    informer handler once on the cached Job and pod for that run (informer
>    cache, no API call), so a `Complete` that arrived first is not missed.
>    Errors from the API server are classified by status: 403 quota, 429,
>    5xx and network errors are transient: release the lease, back off that
>    function for `2^n` seconds capped at 60, count
>    `krun_job_create_errors_total{function,code}`,
>    `krun_quota_rejections_total` for quota. Any other 4xx (400, 403 RBAC,
>    404, 422 admission) is permanent: delete the Secret if created,
>    transition `queued` to `failed` with `job_create_failed` and `error`
>    `{ source: krun, message: <API server Status message>, details: { code:
>    <HTTP status>, reason: <Status reason> } }`.
> 5. For each run in `cancelling`: delete the Job with foreground propagation,
>    delete the Secret, transition to `cancelled`.
> 6. Lost Jobs, active only after the Job informer's initial list: for each
>    run from `listByState(['scheduled','running'], KRUN_MAX_RUNNING)` whose
>    Job is absent from the informer cache, record the first-absent time in a
>    leader-local map (reset on leader change); past the 2 minute grace,
>    transition to `failed` with `job_lost` and a `krun`-sourced error
>    unless the function reported one, keep any `result` already written,
>    then delete the Secret; drop the entry when the Job reappears.

## Step 4 per run, as a checklist

| # | Call | On failure |
|---|---|---|
| a | `secrets.create(krun-<id>, immutable, token)` | `409 AlreadyExists`: `secrets.read` and use its `token`; transient (403 quota/429/5xx/network): `releaseLease`, back off function `2^n` s ≤ 60; permanent 4xx: `queued -> failed job_create_failed` (SPEC.md:827-835) |
| b | `store.setJobToken(id, 'krun-<id>', sha256(token))` | idempotent (SPEC.md:504); must precede the Job (SPEC.md:568-570, D27 SPEC.md:1468) |
| c | `jobs.create(buildJob(run, fn))` | `409 AlreadyExists` = success; transient: release lease, back off; permanent: delete the Secret, `queued -> failed job_create_failed` with `error.details { code, reason }` |
| d | `store.markScheduled(id)` | `false`: delete Job (`propagationPolicy: Foreground`) and Secret, 404 = success (SPEC.md:798-799); `true`: replay the Job/Pod handler on `jobInformer.get(name)` and the cached pod, no API call |

Between runs: check the 10 s deadline; past it, `releaseLease` for every
claimed run not yet at step d and end the iteration (SPEC.md:804-806). A 429
anywhere in the loop also releases the leases of claimed-but-unscheduled
runs, pauses the loop for `Retry-After` (default 1 s, cap 60 s) and logs at
warn (SPEC.md:796-798).

Never log the token, the Job manifest or the env list: `KRUN_RESULT_UPLOAD_URL`
is a presigned URL (SPEC.md:1149-1154).

## Step 5 cancelling (SPEC.md:836-837, SPEC.md:336-337)

Order: Job delete `Foreground` (404 ok) -> Secret delete (404 ok) ->
`transition(id, 'cancelling', 'cancelled', null, {})`. The gateway writes
`cancelling` from `queued`, `scheduled` or `running`; a `cancelling` run
whose Job never existed still ends `cancelled` (PLAN.md:500-502 tests both
Job absent and present).

## Step 6 job_lost (SPEC.md:838-845, SPEC.md:914-919, D28 SPEC.md:1469)

- Gate: only after the Job informer's initial list; nothing fires before it
  (PLAN.md:523-531). `firstAbsent: Map<runId, number>` lives on the leader
  instance and is discarded on leader change.
- `absent` means `jobInformer.get('krun-<id>', jobsNamespace)` is undefined.
  Drop the map entry when the Job reappears.
- Past 2 minutes (SPEC.md:1123): `transition(id, state, 'failed', 'job_lost',
  { error: { source: 'krun', message: ... }, jobStatus?: last known })` for
  `state` in `scheduled`, `running`; the store's `coalesce(error, patch.error)`
  keeps a function-reported error (SPEC.md:367-373); the patch never clears
  `result`; then delete the Secret. No Job delete (there is none).
- After sync, log at info the count of `scheduled`/`running` runs with no
  Job (SPEC.md:916-917). Downtime longer than `KRUN_TTL_AFTER_FINISHED`
  turns finished runs into `job_lost` (SPEC.md:917-919, docs/OPERATIONS.md:37-38).

## Acceptance cases to write first (PLAN.md:492-499, PLAN.md:500-502, PLAN.md:528-531)

- `AlreadyExists` on Secret (token read back) and on Job (success).
- 403 quota -> lease released, `krun_quota_rejections_total` incremented.
- 422 -> run `failed`, `failureReason` `job_create_failed`, `error.source`
  `krun`, `error.details.code` 422, Secret deleted.
- 503 -> lease released, function backed off, run still `queued`.
- `markScheduled` false -> Job (foreground) and Secret deleted.
- `Complete` cached before `markScheduled` -> replay ends the run
  `succeeded`.
- Queued run of a deleted Function expires after 1h; with a token its Job
  (foreground) and Secret are deleted.
- Deadline hit mid step 4 -> remaining claims released.
- Two `state` notifies during an iteration -> exactly one more iteration.
- Cancelling with the Job absent and present -> `cancelled` both times.
- `job_lost`: running run with no Job fails after 2 min, result kept, a
  reported error kept, Job reappearing clears the entry, nothing before the
  initial list.
