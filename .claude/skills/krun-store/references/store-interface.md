# Store interface (SPEC.md:489-520) with the PLAN task per method

Copied from the working tree on the day this skill was written. Re-verify
against the current SPEC.md before relying on a line number; SPEC.md is the
source of truth (SPEC.md:3-5) and the interface changes only with a
Decisions row.

Module: `packages/shared/src/store` (SPEC.md:489, PLAN.md:97). Implemented
for both dialects, verified by one shared contract suite in
`packages/shared/src/store/contract/` (SPEC.md:489-490, PLAN.md:102).

## Interface verbatim (SPEC.md:492-520)

```ts
interface Store {
  createRun(run: NewRun): Promise<{ run: Run; created: boolean }>;        // dedupe on idempotency key; when created, appends the queued run_events row (payload.actor = created_by) and notifies
  getRun(id: string): Promise<Run>;                                        // throws NotFoundError
  listRuns(filter: RunFilter, cursor: string | null, limit: number):
    Promise<{ runs: RunSummary[]; next: string | null }>;                 // selects every column except input, result, log_tail; toRunSummary
  listByState(states: State[], limit: number): Promise<Run[]>;             // non-terminal; the runs_active_idx predicate plus state in (<requested>)
  countByState(): Promise<Map<string, Map<State, number>>>;                // non-terminal runs per function and state; the runs_active_idx predicate
  countQueued(fn: string): Promise<number>;                                // queued per function, for maxQueued
  countQueuedBy(fn: string, createdBy: string): Promise<number>;           // queued per function and key, for the key's maxQueued
  claimQueued(fn: string, owner: string, leaseUntil: Date, limit: number): Promise<Run[]>;
  releaseLease(id: string): Promise<void>;
  setJobToken(id: string, jobName: string, tokenHash: string): Promise<void>; // before the Job exists; idempotent
  markScheduled(id: string): Promise<boolean>;                             // queued -> scheduled, clears lease, sets scheduled_at, appends a run_events row, notifies; false on stale state
  transition(id: string, from: State, to: State, reason: string | null, patch: Partial<Run>,
    event?: { actor: string }): Promise<boolean>;                        // event, when given, is the run_events payload; error written as coalesce(error, patch.error)                                                      // compare-and-set; sets started_at when to = running, finished_at when terminal; appends run_events; inserts the delivery when terminal and callback_url set
  setRuntimeStatus(id: string, status: RuntimeStatus): Promise<boolean>;  // queued with token, scheduled or running; publishes notify, no run_events row
  setResult(id: string, result: unknown): Promise<boolean>;                // queued with token, scheduled or running
  setError(id: string, error: RunError): Promise<boolean>;                 // queued with token, scheduled or running; source function
  setJobStatus(id: string, status: JobStatus): Promise<boolean>;           // scheduled, running or cancelling; writes and appends run_events only when a field other than observedAt changed
  expireQueued(fn: string, olderThan: Date): Promise<Run[]>;               // queued -> failed queue_timeout; sets finished_at; one run_events row, notify and delivery each
  listStale(fn: string, before: Date): Promise<Run[]>;                     // running runs whose later of runtime_status.at and started_at is < before
  subscribe(signal: AbortSignal): AsyncIterable<{ id: string; kind: "state" | "status" | "job_status" }>;
  claimDeliveries(now: Date, limit: number): Promise<Delivery[]>;         // sets next_at = now + 60s in the claim statement, ordered by next_at, skip locked
  updateDelivery(id: string, state: DeliveryState, attempt: number, nextAt: Date | null, lastError: string | null): Promise<void>;
  sweep(finishedBefore: Date, batch: number): Promise<number>;             // SQLite runs pragma incremental_vacuum after each batch
  migrate(): Promise<void>;
}
```

Error classes next to it: `NotFoundError`, `ConflictError` (PLAN.md:234).
`transition` takes the optional `event` payload (PLAN.md:233-234).

## Effect form (docs/STACK.md 2.3, 4.2, 4.4)

SPEC writes the interface with Promises. krun runs on Effect 4, so the
implementation is a `Context.Service` whose methods return Effects. Names,
parameters, order and semantics stay exactly as above; only these types
change:

| SPEC | Effect form |
|---|---|
| `Promise<A>` | `Effect.Effect<A, DatabaseError>` (plus the domain error below) |
| `throws NotFoundError` (`getRun`) | fails with `NotFoundError` (`Data.TaggedError`) |
| `ConflictError` (`createRun`) | fails with `ConflictError` (`Data.TaggedError`) |
| `Date` parameters and `Run` time fields | `DateTime.Utc` |
| `subscribe(signal): AsyncIterable<...>` | `subscribe(): Stream.Stream<{ id, kind }, DatabaseError>`; interrupting the consuming fiber replaces the `AbortSignal` and releases the `LISTEN` client or the poll |
| "now" inside `claimQueued`, `markScheduled`, `transition`, `expireQueued`, ids | read from `Clock` / `DateTime.now` inside the method, never a new parameter |

```ts
// Effect 3 spelling of the service class; check MIGRATION.md for Context.Service
export class Store extends Context.Service<Store, {
  readonly createRun: (run: NewRun) => Effect.Effect<{ run: Run; created: boolean }, ConflictError | DatabaseError>
  readonly getRun: (id: string) => Effect.Effect<Run, NotFoundError | DatabaseError>
  readonly claimQueued: (fn: string, owner: string, leaseUntil: DateTime.Utc, limit: number) => Effect.Effect<Run[], DatabaseError>
  readonly transition: (id: string, from: State, to: State, reason: string | null,
    patch: Partial<Run>, event?: { actor: string }) => Effect.Effect<boolean, DatabaseError>
  readonly subscribe: () => Stream.Stream<{ id: string; kind: "state" | "status" | "job_status" }, DatabaseError>
  // ... every other SPEC method, same translation
}>()("krun/Store") {}
```

Each method body: compute `at`, ids and hashes in Effect, then run one
Kysely function (a single statement or one `db.transaction().execute`)
inside `Effect.tryPromise`, `catch` mapping to `DatabaseError`. In
`createRun` a unique violation on `runs_idem_idx` is not a
`DatabaseError`: re-read the existing row, return it when the hash matches,
fail with `ConflictError` when it does not. Kysely rows go through the dialect mapper into `Run`; the
wire shape comes only from `toRun` / `toRunSummary`.

## Method by method: task, semantics, acceptance

| Method | PLAN task | Semantics the contract suite must prove | Source |
|---|---|---|---|
| (types) `Run`, `NewRun`, `RunSummary`, `RunFilter`, `State`, `RuntimeStatus`, `JobStatus`, `RunError`, `Delivery`, `DeliveryState`, Kysely table types, `toRun`, `toRunSummary`, tagged errors | P1.1 (PLAN.md:231-235) | `tsc --noEmit` passes with no implementation; `toRun` FULL, `toRunSummary` BASIC = `toRun` minus `input`, `result`, `logTail`, `error.details`; the only row-to-wire mappers (`name`, UPPER_SNAKE enums, `*Time`, `resultUri`, `reportTime`, `observeTime`) | SPEC.md:529-539, SPEC.md:259-265, SPEC.md:241-244 |
| `migrate()` | P1.2 (PLAN.md:236-243) | Kysely `Migrator` + `FileMigrationProvider`, one folder per dialect, raw SQL via `sql` templates; up twice is idempotent on both dialects; see `dialect-differences.md` for the `krun migrate` diff rule | SPEC.md:385-388, SPEC.md:1405-1410 |
| `createRun` | P1.3 (PLAN.md:244-252) | Dedupe on `(created_by, function_name, idempotency_key)` via `runs_idem_idx`; same key + same `request_hash` returns the existing row with `created: false`; same key + different hash fails with `ConflictError`; when created, appends the `queued` `run_events` row with `payload.actor = created_by` and notifies. Concurrent duplicate creates yield exactly one row and one event; reordered JSON keys hash identically (RFC 8785 via `canonicalize`) | SPEC.md:494, SPEC.md:433-434, SPEC.md:527-529, SPEC.md:352-356, SPEC.md:225-232 |
| `claimQueued` | P1.4 (PLAN.md:253-262) | Claim statement from `ddl.md`; lease only, `attempt + 1`, no state change; two claimers never receive the same run while the lease is valid; an expired lease (`lease_until < now`, `now` from `Clock`) is reclaimable after `TestClock.adjust` past the lease | SPEC.md:470-487, SPEC.md:365-366 |
| `releaseLease` | P1.4 | Clears `lease_owner`/`lease_until` so the row is claimable at once (used after a transient Kubernetes error) | SPEC.md:503, SPEC.md:827-831 |
| `setJobToken` | P1.4 | Writes `job_name` and `job_token_hash` before the Job exists; idempotent (same values twice is fine); the token is valid while the run is `queued` with a token (D27) | SPEC.md:504, SPEC.md:568-570, SPEC.md:1468 |
| `markScheduled` | P1.4 | CAS `queued -> scheduled`; clears the lease; sets `scheduled_at` = event `at`; appends a `run_events` row; notifies; `false` on stale state (for example cancelled) | SPEC.md:505, SPEC.md:357-359 |
| `countByState` | P1.4 | Non-terminal runs per function and state; literal `runs_active_idx` predicate from the shared `sql` fragment; `explain` names `runs_active_idx` after seeding 5000 terminal + 50 active and `analyze runs`, inside a transaction with `set local enable_seqscan = off` | SPEC.md:499, SPEC.md:534-536, PLAN.md:259-262 |
| `countQueued`, `countQueuedBy` | P1.4 | Queued rows per function, and per function and `created_by`, for `maxQueued` checks | SPEC.md:500-501 |
| `listByState` | P1.4 | Literal predicate plus `state in (<requested>)`, requested states must be non-terminal | SPEC.md:498, SPEC.md:534-536 |
| `transition` | P1.5 (PLAN.md:263-274) | CAS `where id = $id and state = $from`; sets `started_at` when `to = running`, `finished_at` when terminal; `error = coalesce(error, patch.error)`; appends `run_events` (payload = `event` when given); notifies; inserts the `deliveries` row in the same transaction when terminal and `callback_url` set, payload `toRunSummary(updated row)`; stale returns `false` and writes nothing | SPEC.md:341-351, SPEC.md:367-373, SPEC.md:506-507 |
| `getRun` | P1.6 (PLAN.md:275-283) | Fails with `NotFoundError` on a missing id | SPEC.md:495 |
| `listRuns` | P1.6 | `RunSummary` items; filter `state`, `failureReason`, `createTime` bounds with `AND`; order `created_at desc, id desc`; cursor base64url `created_at|id` plus a hash of parent and filter; default limit 50; row-value comparison `(created_at, id) < ($createdAt, $id)`; owner scoping; Postgres `explain` for an unfiltered admin list names `runs_created_idx` | SPEC.md:496-497, SPEC.md:522-523, SPEC.md:236-240, docs/API.md:231-249 |
| `expireQueued` | P1.7 (PLAN.md:284-289) | `queued -> failed` reason `queue_timeout` for rows older than `olderThan`; sets `finished_at`; one `run_events` row, notify and delivery each; returns the expired runs so the scheduler can clean up Job and Secret when `job_token_hash` is set | SPEC.md:512, SPEC.md:348-351, SPEC.md:808-814 |
| `sweep` | P1.7 | Batched delete on `runs_finished_idx` where `finished_at < finishedBefore`, `limit batch`; returns the count; SQLite runs `pragma incremental_vacuum` after each batch; `run_events` and `deliveries` go with the run through `on delete cascade` | SPEC.md:467-468, SPEC.md:517, SPEC.md:930-931 |
| `claimDeliveries` | P1.7 | Leases pending rows due at `now` by setting `next_at = now + 60s` in the claim statement itself, ordered by `next_at`, `skip locked` in Postgres; a claimed row is not re-claimed within 60 s (`TestClock.adjust("59 seconds")` then `"1 second"`) | SPEC.md:515, SPEC.md:921-925 |
| `updateDelivery` | P1.7 | Sets `state`, `attempt`, `next_at`, `last_error`; the scheduler owns the schedule 1m, 5m, 30m, 2h, 12h and marks `dead` after the sixth failure | SPEC.md:516, SPEC.md:925-927 |
| `subscribe` | P1.8 (PLAN.md:290-294) | A `Stream`; Postgres `LISTEN krun_runs` on a dedicated client acquired in the stream scope, with reconnect; SQLite polls `run_events where rowid > $last order by rowid` every 1 s from `max(rowid)` at subscribe; `from_state = to_state` is kind `job_status`, else `state`; a transition is observed within 2 s in both modes; SQLite never re-emits a row | SPEC.md:514, SPEC.md:541-549 |
| (pragmas, driver) | P1.9 (PLAN.md:295-300) | Pragmas on every connection; one `better-sqlite3` connection per process; `SqliteDriver` subclass whose `beginTransaction` runs `begin immediate`; `journal_mode` reads `wal`; a second connection's `begin immediate` with `busy_timeout` 0 fails `SQLITE_BUSY` while a Store transaction is open | SPEC.md:551-562 |
| `setRuntimeStatus` | P1.10 (PLAN.md:301-308) | Allowed in `queued` with `job_token_hash` set, `scheduled`, `running`; stores only the latest value on the run; publishes `<id>:status`; writes no `run_events` row; `false` otherwise | SPEC.md:508, SPEC.md:346-347, SPEC.md:354-355 |
| `setResult`, `setError` | P1.10 | Same allowed states as `setRuntimeStatus`; `setError` is the function's own report (`source function`); `false` on a terminal run or a `queued` run without a token | SPEC.md:509-510, SPEC.md:367-373 |
| `setJobStatus` | P1.10 | Allowed in `scheduled`, `running`, `cancelling`; writes and appends a `run_events` row (`from_state = to_state`, reason `job_status`, payload the new `jobStatus`) only when a field other than `observedAt` changed; the comparison is applied inside the CAS; publishes `<id>:job_status` | SPEC.md:511, SPEC.md:352-354, SPEC.md:858-860 |
| `listStale` | P1.11 (PLAN.md:309-313) | `running` runs whose later of `runtime_status.at` and `started_at` is `< before`; dialect expressions in `dialect-differences.md`; `failure_reason` travels in the `transition` patch and every `failed` row carries it | SPEC.md:513, SPEC.md:523-527, SPEC.md:379-381 |

## Allowed-state matrix for the internal-API writers

| Method | queued (no token) | queued (token set) | scheduled | running | cancelling | terminal |
|---|---|---|---|---|---|---|
| `setRuntimeStatus`, `setResult`, `setError` | false | write | write | write | false | false |
| `setJobStatus` | false | false | write on change | write on change | write on change | false |

Source: SPEC.md:508-511, PLAN.md:301-308. "false" means the method returns
`false` and writes nothing; the internal API maps that to 401/409 as
docs/INTERNAL-API.md says (not this skill's concern).

## Notify payloads (Postgres only, SPEC.md:344-347)

| Writer | `pg_notify('krun_runs', ...)` payload | `subscribe` kind |
|---|---|---|
| `createRun`, `markScheduled`, `transition`, `expireQueued` | `<id>:<state>` | `state` |
| `setRuntimeStatus` | `<id>:status` | `status` |
| `setJobStatus` | `<id>:job_status` | `job_status` |

`NOTIFY` inside a transaction is delivered on commit, so issue it inside
the same transaction as the write (docs/research/node-stack-facts.md:693-694, UNVERIFIED
API detail but standard Postgres behaviour).
