# DDL, indexes and claim queries (SPEC.md:402-487)

The Postgres DDL below is verbatim from SPEC.md:402-465 (re-verify the
lines against the current file). The SQLite DDL is the same schema with the
type mapping from SPEC.md:390-397 applied; keep table and column names
identical (SPEC.md:385). Both live as raw SQL inside `sql` templates in the
first migration of each dialect folder (PLAN.md:236-238):
`packages/shared/src/store/migrations/postgres/` and
`packages/shared/src/store/migrations/sqlite/` (SPEC.md:386-387).

The application generates every id and timestamp; no database default for
time (SPEC.md:399-400). The only column defaults are `priority 0`,
`attempt 0` on `runs` and `attempt 0` on `deliveries`.

## Postgres DDL (SPEC.md:402-465, verbatim)

```sql
create table runs (
  id               uuid primary key,
  idempotency_key  text,
  request_hash     text not null,
  function_name    text not null,
  input            jsonb not null,
  state            text not null
                   check (state in ('queued','scheduled','running',
                                    'succeeded','failed','cancelling','cancelled')),
  priority         int  not null default 0,
  attempt          int  not null default 0,
  lease_owner      text,
  lease_until      timestamptz,
  job_name         text,
  job_token_hash   text,
  result           jsonb,
  result_ref       text,
  error            jsonb,
  log_tail         text,
  failure_reason   text,
  runtime_status   jsonb,
  job_status       jsonb,
  callback_url     text,
  created_by       text not null,
  created_at       timestamptz not null,
  scheduled_at     timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz
);

create unique index runs_idem_idx on runs (created_by, function_name, idempotency_key)
  where idempotency_key is not null;
create index runs_queue_idx    on runs (function_name, priority desc, created_at) where state = 'queued';
create index runs_active_idx   on runs (function_name, state) where state in ('queued','scheduled','running','cancelling');
create index runs_function_idx on runs (function_name, created_at desc, id desc);
create index runs_owner_idx    on runs (created_by, created_at desc, id desc);
create index runs_created_idx  on runs (created_at desc, id desc);
create index runs_finished_idx on runs (finished_at) where finished_at is not null;

create table run_events (
  run_id     uuid not null references runs(id) on delete cascade,
  at         timestamptz not null,
  from_state text,
  to_state   text not null,
  reason     text,
  payload    jsonb
);
create index run_events_run_idx on run_events (run_id, at);

create table deliveries (
  id          uuid primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  url         text not null,
  payload     jsonb not null,
  attempt     int  not null default 0,
  next_at     timestamptz not null,
  state       text not null check (state in ('pending','delivered','dead')),
  last_error  text,
  created_at  timestamptz not null
);
create index deliveries_due_idx on deliveries (next_at) where state = 'pending';
create index deliveries_run_idx on deliveries (run_id);
```

No table partitioning in v1 (SPEC.md:467, D10 SPEC.md:1451: the partition
key would have to join the idempotency unique index). Retention is a
batched delete on `runs_finished_idx` (SPEC.md:467-468).

## SQLite DDL (derived: SPEC.md:390-397 mapping applied to the above)

Only the types change: `uuid` -> `text`, `jsonb` -> `text`,
`timestamptz` -> `text` (RFC 3339 UTC with milliseconds), `int` -> `integer`.
`on delete cascade` needs `pragma foreign_keys = ON` on every connection
(SPEC.md:557). Partial indexes, `check`, and `returning` work on SQLite
3.35+ (SPEC.md:397); better-sqlite3 13.0.3 bundles SQLite 3.53.4
(`pkgs/better-sqlite3-13.0.3/package/deps/sqlite3/sqlite3.h:149`, VERIFIED).

```sql
create table runs (
  id               text primary key,
  idempotency_key  text,
  request_hash     text not null,
  function_name    text not null,
  input            text not null,
  state            text not null
                   check (state in ('queued','scheduled','running',
                                    'succeeded','failed','cancelling','cancelled')),
  priority         integer not null default 0,
  attempt          integer not null default 0,
  lease_owner      text,
  lease_until      text,
  job_name         text,
  job_token_hash   text,
  result           text,
  result_ref       text,
  error            text,
  log_tail         text,
  failure_reason   text,
  runtime_status   text,
  job_status       text,
  callback_url     text,
  created_by       text not null,
  created_at       text not null,
  scheduled_at     text,
  started_at       text,
  finished_at      text
);
-- the seven runs_* indexes, run_events, run_events_run_idx, deliveries and
-- the two deliveries_* indexes are character-for-character the same as
-- Postgres, with uuid -> text, timestamptz -> text, jsonb -> text, int -> integer.
```

Do not add `strict` tables, `without rowid`, generated columns or triggers:
no task asks for them (PLAN.md:31-32), and `subscribe` relies on the
implicit `rowid` of `run_events` (SPEC.md:541-543).

## Index to query map

| Index | Used by | Why it must stay partial / ordered this way |
|---|---|---|
| `runs_idem_idx` (unique, partial) | `createRun` dedupe | partial so runs without a key never collide; the unique violation is how concurrent duplicates collapse to one row (SPEC.md:433-434, PLAN.md:244-252) |
| `runs_queue_idx` (partial `state = 'queued'`) | `claimQueued` inner select, `countQueued`, `countQueuedBy`, `expireQueued` | matches `order by priority desc, created_at` (SPEC.md:435, 479) |
| `runs_active_idx` (partial, four states) | `countByState`, `listByState` | the predicate must appear as literal text in the query so the planner can match the partial index (SPEC.md:436, 534-536) |
| `runs_function_idx` | `listRuns` for one function | `(function_name, created_at desc, id desc)` matches the fixed order (SPEC.md:437, 236) |
| `runs_owner_idx` | `listRuns` across functions for one key | `(created_by, created_at desc, id desc)` (SPEC.md:438) |
| `runs_created_idx` | `listRuns` admin list across functions | `explain` must name it for the unfiltered admin list (SPEC.md:439, PLAN.md:282-283) |
| `runs_finished_idx` (partial `finished_at is not null`) | `sweep` | batched delete of terminal rows (SPEC.md:440, 467-468) |
| `run_events_run_idx` | run history, `subscribe` poll uses `rowid` not this index | (SPEC.md:450) |
| `deliveries_due_idx` (partial `state = 'pending'`) | `claimDeliveries` | `where state = 'pending' and next_at <= $now order by next_at` (SPEC.md:463, 515) |
| `deliveries_run_idx` | cascade and per-run lookup | (SPEC.md:464) |

## Claim query, Postgres (SPEC.md:472-483, verbatim)

```sql
update runs
set    lease_owner = $1, lease_until = $2, attempt = attempt + 1
where  id in (
  select id from runs
  where  state = 'queued' and function_name = $3
    and (lease_until is null or lease_until < $4)
  order  by priority desc, created_at
  for update skip locked
  limit  $5)
returning *;
```

`$1` owner, `$2` leaseUntil, `$3` fn, `$4` now, `$5` limit
(`claimQueued(fn, owner, leaseUntil, limit)`, SPEC.md:502). `now` is not a
parameter of the method: read it from `Clock` / `DateTime.now` inside
`claimQueued`, so `TestClock.adjust` controls lease expiry without
changing the SPEC signature.

## Claim query, SQLite (SPEC.md:485-487)

Same statement without `for update skip locked`, run inside a transaction
that the `SqliteDriver` subclass opens with `begin immediate`
(SPEC.md:485-486, 562). `begin immediate` takes the write lock up front, so
two claimers serialise instead of one failing with `SQLITE_BUSY` on the
upgrade from a deferred read (docs/research/node-stack-facts.md:678-681).

```sql
update runs
set    lease_owner = ?, lease_until = ?, attempt = attempt + 1
where  id in (
  select id from runs
  where  state = 'queued' and function_name = ?
    and (lease_until is null or lease_until < ?)
  order  by priority desc, created_at
  limit  ?)
returning *;
```

Timestamps compare as text, which is correct only because every timestamp
is written as RFC 3339 UTC with a fixed millisecond width (SPEC.md:394):
`2026-10-23T08:00:00.000Z`. Never write a local-offset or a variable-width
string into a timestamp column.

The claim takes a lease only; state changes after the Job exists
(`markScheduled`); an expired lease (`lease_until < now`) makes the row
claimable again (SPEC.md:486-487). `attempt` counts scheduler claims
(SPEC.md:365).

## Delivery claim statement (SPEC.md:515, 921-925)

Lease in the same statement that selects, 60 s, so a crash between select
and update cannot strand a row:

```sql
-- Postgres
update deliveries
set    next_at = $1 + interval '60 seconds'
where  id in (
  select id from deliveries
  where  state = 'pending' and next_at <= $1
  order  by next_at
  for update skip locked
  limit  $2)
returning *;
```

SQLite: same without `for update skip locked`, inside `begin immediate`;
compute `now + 60s` in the application (`DateTime.addDuration`, check
the Effect 4 name) and bind it as an RFC 3339 string from
`DateTime.formatIso` instead of using `interval`.

## Delivery row inserted by every terminal path (SPEC.md:348-351, D29)

Inside the terminal transaction, when `callback_url` is set:
`id` UUIDv7 (`v7({ msecs })` from `Clock`, SPEC.md:1081), `run_id`, `url = callback_url`,
`payload = toRunSummary(updated row)`, `attempt 0`, `next_at = at` of the
transition, `state 'pending'`, `created_at = at`. Paths: `transition` to a
terminal state, `expireQueued`, and through `transition` the heartbeat,
`job_lost`, deadline and `job_create_failed` failures (SPEC.md:348-351).

## Sweep statement (SPEC.md:467-468, 517, 930-931)

```sql
delete from runs
where id in (
  select id from runs
  where finished_at is not null and finished_at < $1
  order by finished_at
  limit $2)
```

Return the affected row count. SQLite: `pragma incremental_vacuum` after
each batch (SPEC.md:517), which only reclaims pages because
`auto_vacuum = INCREMENTAL` was set before the tables were created
(SPEC.md:558; `auto_vacuum` cannot be changed on a populated database
without `vacuum`, so set it in the open sequence before `migrate()`).
