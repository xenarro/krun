# Scheduler main loop (SPEC.md section 8)

Serves PLAN P4.3b (PLAN.md:505-519), P4.3c (PLAN.md:520-522), P4.5
(PLAN.md:543-551). Line numbers verified on 2026-10-23; re-check before
citing.

## Triggers and deadline (SPEC.md:801-806, verbatim)

> Main loop, every 1 second and on each notify of kind `state`; `status` and
> `job_status` notifies are ignored by it. Iterations never overlap: a
> `state` notify during an iteration marks exactly one more. Each iteration
> carries a 10 second deadline checked between steps and between runs in
> step 4; past it, the leases of unprocessed claimed runs are released and
> the iteration ends.

Shape: Effect fibers in the leader scope, no workqueue (docs/STACK.md 4.3,
PLAN.md:82-87). Constructor names are Effect 3 spelling; check Effect's
`MIGRATION.md` for the Effect 4 names (`Effect.forkIn`, `Queue.sliding`,
`Effect.catchAll`, the `Stream` runners):

```ts
const wake = yield* Queue.sliding<void>(1)              // capacity 1: coalesces
yield* Queue.offer(wake, undefined).pipe(               // 1 s ticker
  Effect.repeat(Schedule.spaced("1 second")), Effect.forkIn(leaderScope))
yield* store.subscribe.pipe(                            // notifies, kind state only
  Stream.filter((n) => n.kind === "state"),
  Stream.runForEach(() => Queue.offer(wake, undefined)), Effect.forkIn(leaderScope))
yield* Queue.take(wake).pipe(                           // the one loop fiber
  Effect.zipRight(iteration.pipe(
    Effect.withSpan("scheduler.iteration"),             // one span per iteration (SPEC section 11)
    Effect.timeout("10 seconds"),                       // iteration deadline
    Effect.ensuring(releaseUnprocessedClaims),          // leases of claimed, not yet scheduled runs
    Effect.catchAll(logIterationFailure))),             // a failed iteration never ends the loop
  Effect.forever, Effect.forkIn(leaderScope))
```

- Spans: the iteration span parents the step spans and every `Kube` and
  store call inside it. Step 4 gets a child span per run
  (`scheduler.schedule_run`, attributes `krun.run_id`, `krun.function`), so
  one run's Secret and Job creates group together. Attributes never carry
  token, env or manifest (SPEC section 11).
- Two notifies during one iteration yield one extra iteration, not two
  (PLAN.md:518-519): the sliding queue holds at most one wake.
- The claimed-but-unscheduled set is a `Ref`: step 3 fills it; each
  `markScheduled` or permanent failure removes the run. The `ensuring`
  finalizer releases what is left, whether the iteration ended, timed out
  or was interrupted by leader loss or SIGTERM. The finalizer runs
  uninterruptibly: bound its store calls.
- An interruption between Job create and `markScheduled` is safe: the lease
  is released, the next claim finds Secret and Job by name
  (`AlreadyExists`) and continues.
- The loop runs only on the leader and stops when the leader scope closes
  (SPEC.md:776-779).
- A failed `subscribe` stream is retried with a `Schedule`
  (`Stream.retry`); the 1 s ticker keeps the loop running meanwhile.

## Steps 1-6 (SPEC.md:808-845)

SPEC text is normative; this is the checklist form.

| Step | Do |
|---|---|
| 1 | Read `countByState`. For each function with queued runs: `expireQueued(fn, now - queueTimeout)`. `queueTimeout` from the cached Function when it is in the informer map (Ready or not) and parses, else the CRD default 1h. Each expired run gets its `run_events` row, notify and delivery. Expired run with `jobTokenHash` set: delete its Job (foreground) and Secret, as after a false `markScheduled` |
| 2 | Free slots: per function `maxConcurrency - (scheduled + running)`; global `KRUN_MAX_RUNNING - sum(scheduled + running)`. Publish `krun_runs_current` from the same `countByState` result |
| 3 | Each Ready function with free slots: claim up to the smaller of the two; lease 30 seconds |
| 4 | Per claimed run, in order: Secret with fresh token, `setJobToken`, Job, `markScheduled` (table below). Transient (403 quota, 429, 5xx, network): release lease, back off the function `2^n` s capped 60, count `krun_job_create_errors_total{function,code}`; quota also `krun_quota_rejections_total`. Any other 4xx (400, 403 RBAC, 404, 422 admission) is permanent: delete the Secret if created; `queued` to `failed` with `job_create_failed` and `error` `{ source: krun, message: <API server Status message>, details: { code: <HTTP status>, reason: <Status reason> } }` |
| 5 | Each `cancelling` run: delete Job (foreground), delete Secret, transition to `cancelled` |
| 6 | Lost Jobs, only after the Job informer's initial list. Each run from `listByState(['scheduled','running'], KRUN_MAX_RUNNING)` with its Job absent from the cache: record first-absent time in a leader-local map (reset on leader change). Past the 2 minute grace: `failed` with `job_lost` and a `krun`-sourced error unless the function reported one; keep any `result`; delete the Secret. Drop the entry when the Job reappears |

## Step 4 per run, as a checklist

| # | Call | On failure |
|---|---|---|
| a | `secrets.create(krun-<id>, immutable, token)` | `409 AlreadyExists`: `secrets.read` and use its `token`; transient (403 quota/429/5xx/network): `releaseLease`, back off function `2^n` s ≤ 60; permanent 4xx: `queued -> failed job_create_failed` (SPEC.md:827-835) |
| b | `store.setJobToken(id, 'krun-<id>', sha256(token))` | idempotent (SPEC.md:504); must precede the Job (SPEC.md:568-570, D27 SPEC.md:1468) |
| c | `jobs.create(buildJob(run, fn))` | `409 AlreadyExists` = success; transient: release lease, back off; permanent: delete the Secret, `queued -> failed job_create_failed` with `error.details { code, reason }` |
| d | `store.markScheduled(id)` | `false`: delete Job (`propagationPolicy: Foreground`) and Secret, 404 = success (SPEC.md:798-799); `true`: replay the Job/Pod handler on `jobInformer.get(name)` and the cached pod, no API call |

- The 10 s deadline (SPEC.md:804-806) is `Effect.timeout` on the whole
  iteration. When it fires, the iteration fiber is interrupted wherever it
  is. The `ensuring` finalizer calls `releaseLease` for every claimed run
  not yet past step d.
- Process claimed runs sequentially (no `concurrency` option on the
  per-run `Effect.forEach`), so "unprocessed" is well defined.
- A 429 anywhere in the loop releases leases of claimed-but-unscheduled
  runs, pauses the loop fiber for `Retry-After` (default 1 s, cap 60 s,
  `Effect.sleep` so `TestClock` controls it) and logs at warn
  (SPEC.md:796-798).
- Never log the token, the Job manifest or the env list:
  `KRUN_RESULT_UPLOAD_URL` is a presigned URL (SPEC.md:1149-1154).

## Step 5 cancelling (SPEC.md:836-837, SPEC.md:336-337)

Order: Job delete `Foreground` (404 ok), Secret delete (404 ok),
`transition(id, 'cancelling', 'cancelled', null, {})`. The gateway writes
`cancelling` from `queued`, `scheduled` or `running`. A `cancelling` run
whose Job never existed still ends `cancelled` (PLAN.md:520-522 tests Job
absent and present).

## Step 6 job_lost (SPEC.md:838-845, SPEC.md:914-919, D28 SPEC.md:1469)

- Gate: only after both Job and Pod informers' initial list. Step 6 names
  the Job informer; SPEC section 8 intro's "both" is the stricter gate.
  Nothing fires before it (PLAN.md:543-551).
- `firstAbsent:
  Ref<Map<runId, DateTime.Utc>>` lives in the leader scope, so leader
  change discards it. First-absent times come from `DateTime.now`, never
  `Date.now()`.
- `absent` means `jobInformer.get('krun-<id>', jobsNamespace)` is undefined. Drop
  the map entry when the Job reappears.
- Past 2 minutes (SPEC.md:1123): `transition(id, state, 'failed', 'job_lost',
  { error: { source: 'krun', message: ... }, jobStatus?: last known })` for
  `state` in `scheduled`, `running`. The store's `coalesce(error, patch.error)`
  keeps a function-reported error (SPEC.md:367-373). The patch never clears
  `result`. Then delete the Secret. No Job delete (there is none).
- After sync, log at info the count of `scheduled`/`running` runs with no
  Job (SPEC.md:916-917). Downtime longer than `KRUN_TTL_AFTER_FINISHED`
  turns finished runs into `job_lost` (SPEC.md:917-919,
  docs/OPERATIONS.md:37-38).

## Acceptance cases to write first (PLAN.md:512-519, PLAN.md:520-522, PLAN.md:548-551)

- `AlreadyExists` on Secret (token read back) and on Job (success).
- 403 quota: lease released, `krun_quota_rejections_total` incremented.
- 422: run `failed`, `failureReason` `job_create_failed`, `error.source`
  `krun`, `error.details.code` 422, Secret deleted.
- 503: lease released, function backed off, run still `queued`.
- `markScheduled` false: Job (foreground) and Secret deleted.
- `Complete` cached before `markScheduled`: replay ends the run
  `succeeded`.
- Queued run of a deleted Function expires after 1h; with a token, its Job
  (foreground) and Secret are deleted.
- Deadline hit mid step 4: remaining claims released.
- Two `state` notifies during an iteration: exactly one more iteration.
- Cancelling with the Job absent and present: `cancelled` both times.
- `job_lost`: running run with no Job fails after `TestClock.adjust("2
  minutes")`; result kept; a reported error kept; Job reappearing clears
  the entry; nothing before the initial list.

Write them as `@effect/vitest` `it.effect` tests with `Kube` and Store
stubs as layers. Drive the 1 s ticker, 10 s deadline, `2^n` backoff and 2
minute grace with `TestClock.adjust`, never with real sleeps.
