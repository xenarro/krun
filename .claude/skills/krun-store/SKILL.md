---
name: krun-store
description: Use when writing krun Store, migrations or SQL. Implements SPEC section 6 for Postgres and SQLite behind one contract suite.
---

# krun Store (SPEC section 6)

Covers `packages/shared/src/store`: model types, `toRun`/`toRunSummary`, the
`Store` interface, both dialect implementations, migrations and the shared
contract suite. Serves PLAN Phase 1 tasks P1.1-P1.11 (PLAN.md:203-292) and
is consulted by any P3.x/P4.x task that calls a Store method.

## When to use

- Any file under `packages/shared/src/store/**` or `bin/krun.js migrate`.
- Any SQL, Kysely query, migration, or row-to-wire mapping.
- A gateway or scheduler task that needs the exact semantics of a Store
  method (cite this skill's `references/store-interface.md` by row).
- Load `krun-development` first for the agent protocol; load `kysely`
  (installed) for query-builder syntax only, this skill wins on semantics.

## Read first

- SPEC.md:320-381 run lifecycle (CAS, `run_events`, timestamps, `error`
  precedence); SPEC.md:383-562 data model, DDL, claim query, `Store`
  interface, cursor, `listStale`, `subscribe`, pool and pragmas.
- SPEC.md:225-265 wire rules that `toRun`/`toRunSummary` implement;
  SPEC.md:1405-1410 migration policy; SPEC.md:1343-1347 `krun migrate` env.
- PLAN.md:36-74 toolchain and the dependency table; PLAN.md:203-292 Phase 1
  gate and tasks; docs/API.md:229-249 `ListRuns` filter grammar.
- `references/store-interface.md`: the interface verbatim, one row per
  method with task, semantics, acceptance, allowed-state matrix, notify
  payloads.
- `references/ddl.md`: DDL in both dialects, index-to-query map, claim,
  delivery-claim and sweep statements.
- `references/dialect-differences.md`: type mapping, connections and
  pragmas, `listStale`, literal predicate, cursor, `subscribe`, migration
  policy and the `krun migrate` diff rule.

## Rules

1. Implement the `Store` interface exactly as SPEC.md:492-520, with
   `transition(..., event?)` and error classes `NotFoundError`,
   `ConflictError` (PLAN.md:210-214); no extra methods, options or flags
   (PLAN.md:31-32).
2. Every transition is CAS `update runs set ... where id = $id and state =
   $from`; zero rows is a stale event, return `false`, write nothing, log at
   debug (SPEC.md:341-343), because the scheduler's informer, heartbeat and
   cancel paths race by design.
3. Every terminal transition inserts the `deliveries` row in the same
   transaction when `callback_url` is set, payload `toRunSummary` of the
   updated row, including `expireQueued`, heartbeat, `job_lost` and
   `job_create_failed` (SPEC.md:348-351, D29 SPEC.md:1470); a crash between
   two statements must not lose a webhook.
4. Every successful state change appends one `run_events` row and, in
   Postgres, `pg_notify('krun_runs', '<id>:<state>')` inside the
   transaction; `setRuntimeStatus` notifies `<id>:status` with no event row;
   `setJobStatus` notifies `<id>:job_status` with a row whose `from_state =
   to_state`, reason `job_status` (SPEC.md:344-356).
5. Gateway-written rows (`queued`, `cancelling`) carry `payload.actor` = key
   name: `createRun` sets it from `created_by`, `CancelRun` passes
   `event: { actor }` (SPEC.md:355-356, 494, 506-507).
6. `created_at`, `scheduled_at`, `started_at`, `finished_at` each equal the
   `at` of their `run_events` row; generate one `at` per write and use it
   for both (SPEC.md:357-359, PLAN.md:250).
7. The application generates all ids (UUIDv7 via `uuid` `v7()`) and all
   timestamps; no DB time defaults (SPEC.md:399-400, D9 SPEC.md:1450).
8. `transition` writes `error = coalesce(error, patch.error)` so a function's
   own report survives a later krun or Kubernetes error (SPEC.md:367-373,
   PLAN.md:251-253); `failure_reason` arrives in the patch (PLAN.md:289-290).
9. `countByState`/`listByState` filter with the `runs_active_idx` predicate
   as literal SQL from one shared `sql` fragment, never bound parameters
   (SPEC.md:534-536); bound values defeat the partial index and only the
   `explain` test catches it (PLAN.md:238-241).
10. The claim takes a lease only (`lease_owner`, `lease_until`,
    `attempt + 1`); state changes in `markScheduled` after the Job exists;
    `lease_until < now` makes a row claimable again (SPEC.md:470-487).
11. SQLite claim and every other Store transaction open with `begin
    immediate` through a `SqliteDriver` subclass (SPEC.md:485-486, 562;
    PLAN.md:274-276); a deferred transaction upgrading to write returns
    `SQLITE_BUSY` immediately regardless of `busy_timeout`.
12. `listStale` SQLite uses `max(coalesce(json_extract(runtime_status,
    '$.at'), started_at), started_at)`; scalar `max` returns null on any
    null (SPEC.md:523-527).
13. `setJobStatus` writes and appends only when a field other than
    `observedAt` changed, with the same comparison inside the CAS
    (SPEC.md:511, 858-860); `setRuntimeStatus`, `setResult`, `setError` are
    allowed only in `queued` with a token, `scheduled`, `running`
    (SPEC.md:508-510, D27 SPEC.md:1468).
14. `listRuns` orders `created_at desc, id desc`, cursor base64url
    `created_at|id` plus a parent/filter hash, row-value comparison
    `(created_at, id) < ($createdAt, $id)` in both dialects, items are
    `RunSummary` (SPEC.md:522-523, 236-240; PLAN.md:254-262).
15. Postgres: pool of 5 per process plus one dedicated `LISTEN` client
    outside the pool. SQLite: one synchronous `better-sqlite3` connection,
    no pool, the five pragmas on every open (SPEC.md:548-561).
16. `toRun` (FULL) and `toRunSummary` (BASIC = minus `input`, `result`,
    `logTail`, `error.details`) in `packages/shared/src/store` are the only
    row-to-wire mappers; `listRuns`, delivery payload, SSE and the gateway
    all use them (SPEC.md:529-539, 264-265).
17. `request_hash` = lowercase hex SHA-256 of the RFC 8785 (JCS)
    serialisation of `{ input, priority, callback }` as received
    (SPEC.md:527-529); same key + same hash returns the existing run, same
    key + different hash is `ConflictError` (PLAN.md:223-228).
18. Migrations: Kysely `Migrator` + `FileMigrationProvider`, one folder per
    dialect, raw SQL in `sql` templates, forward-only expand/contract; `krun
    migrate` diffs `kysely_migration` first (SPEC.md:385-388, 1405-1410;
    PLAN.md:215-222).
19. Only PLAN.md:48-67 dependencies: `pg`, `kysely`, `better-sqlite3`,
    `uuid`, `testcontainers`, `@testcontainers/postgresql`. A JCS library,
    an ORM, a migration CLI or `pg-listen` needs a Decisions row first
    (PLAN.md:29-30); write RFC 8785 canonicalisation in house.
20. Never log `input`, `result`, `runtimeStatus`, `error.details`, `dsn`,
    tokens or hashes of tokens (SPEC.md:1151-1153); the Store logs ids,
    states and reasons only.

## Layout and types (P1.1)

- Files: `packages/shared/src/store/{index,model,errors,mappers,kysely}.ts`
  (names are a suggestion), `store/postgres/`, `store/sqlite/`,
  `store/migrations/{postgres,sqlite}/0001_init.ts`, `store/contract/`
  (PLAN.md:81-86). Tests sit next to code as `*.test.ts` (PLAN.md:116).
- Type stripping: `State`, `DeliveryState`, `FailureReason` are string
  union types plus `as const` arrays, never `enum`; classes use explicit
  field declarations, never parameter properties (PLAN.md:38-41).
- `Run` holds lowercase DB values; `toRun` renders UPPER_SNAKE, `name`
  (`functions/<fn>/runs/<id>`, docs/API.md), `createTime`/`scheduleTime`/
  `startTime`/`endTime`, `resultUri`, `runtimeStatus.reportTime`,
  `jobStatus.observeTime`; omit unset fields, never `null` (SPEC.md:245-246,
  259-265).
- Acceptance: `tsc --noEmit` passes with no implementation (PLAN.md:213-214).

## Contract suite (Phase 1 gate)

- One suite in `store/contract/` exported as `runStoreContract(name,
  openStore)`; `postgres/*.test.ts` and `sqlite/*.test.ts` call it.
- SQLite: `fs.mkdtemp` under `os.tmpdir()`, file removed in `after`
  (PLAN.md:205-207). Postgres: `@testcontainers/postgresql`, one container
  per file, `db.destroy()` in `after` (PLAN.md:207).
- Gate: `node --test 'packages/shared/src/store/**/*.test.ts'` green on
  both (PLAN.md:205-208). Skip, never fake, the Postgres half when Docker is
  absent, and write `BLOCKED` (PLAN.md:27-28).
- Planner tests: seed 5000 terminal + 50 active rows, `analyze runs`, then
  inside a transaction `set local enable_seqscan = off` and assert the
  `explain` text names `runs_active_idx` (`countByState`) and
  `runs_created_idx` (unfiltered admin `listRuns`) (PLAN.md:238-241,
  261-262). Postgres only; SQLite has no `set local`.
- Concurrency tests: `Promise.all` of N identical `createRun` calls yields
  one row and one event (PLAN.md:229-231); two claimers never share a run
  while the lease is valid (PLAN.md:236-237); P1.9 opens a second
  `better-sqlite3` handle with `busy_timeout` 0 and expects `SQLITE_BUSY`
  on `begin immediate` while a Store transaction is open (PLAN.md:276-279).
- Delivery test: a terminal transition with a callback leaves exactly one
  `pending` delivery whose payload has `name`, `state: 'SUCCEEDED'`,
  `createTime` and no `input` (PLAN.md:246-250).

## Library facts

From node-stack-facts.md; VERIFIED means checked against the unpacked
tarball under `~/.hermes/cache/scratch/krun-skills/pkgs/`.

- Kysely 0.29.7: `SqliteDriver.beginTransaction` runs `begin`
  (`dist/dialect/sqlite/sqlite-driver.js:26-28`, VERIFIED); override it for
  `begin immediate`. The SQLite adapter reports a single connection, so
  Kysely serialises calls through a `ConnectionMutex`
  (`dist/driver/runtime-driver.js:22-24`, VERIFIED).
- Kysely `migrateToLatest()` never throws; read `error` from the result
  (`dist/migration/migrator.d.ts:61-66`, VERIFIED). `getMigrations()`
  returns name + `executedAt` sorted by name (VERIFIED). Out-of-order or
  missing executed migrations throw "corrupted migrations"
  (`dist/migration/migrator.js:500-508`, VERIFIED), so run the `krun
  migrate` diff before the migrator.
- Kysely `sql.lit` inlines, `sql.val` binds (`dist/raw-builder/sql.d.ts:124,
  279`, VERIFIED); `eb.refTuple`/`eb.tuple` exist for row-value comparison
  (`dist/expression/expression-builder.d.ts:561`, VERIFIED).
- better-sqlite3 13.0.3 bundles SQLite 3.53.4 (`deps/sqlite3/sqlite3.h:149`,
  VERIFIED): `returning`, partial indexes, row values, JSON1 all present.
  `db.pragma('journal_mode = WAL')`; `pragma(str, { simple: true })` returns
  the scalar (node-stack-facts.md:676-678, UNVERIFIED). Whether 13.0.3 ships
  a Node 24 (ABI 137) prebuilt is UNVERIFIED; otherwise node-gyp needs
  python3 and build-essential in the Docker build stage
  (node-stack-facts.md:670-675).
- pg 8.23.1: use a dedicated `Client` for `LISTEN`; on `error`/`end` create
  a new `Client` (a Client cannot reconnect), `connect()`, re-`LISTEN`, and
  rely on the 1 s poll fallback for the gap; payload limit 8000 bytes;
  `NOTIFY` in a transaction is delivered on commit (node-stack-facts.md:688-694,
  UNVERIFIED API detail).
- uuid 14: `import { v7 } from 'uuid'`; monotonic within a process in the
  same millisecond, across replicas ordered by millisecond only; Node 24 has
  no `crypto.randomUUIDv7` (node-stack-facts.md:696-704, UNVERIFIED).
- pnpm 10 skips dependency build scripts unless `pnpm-workspace.yaml` lists
  `onlyBuiltDependencies: [better-sqlite3]`; a skipped build fails only at
  `require` time (node-stack-facts.md:805-809, UNVERIFIED; see the `pnpm`
  skill).

## Lessons from Dapr and KEDA

- Keep the delivery insert in the terminal transaction. Dapr's outbox is
  publish-then-commit with a consumer-side marker check: a 1 s scan delay,
  backoff 500 ms to 3 s for up to 10 s, and a "missing marker" ambiguity
  (`dapr pkg/runtime/pubsub/outbox.go:42, 148-158, 307-342`). krun's single
  transaction removes all three (dapr.md:277-297, SPEC.md:348-351).
- Mark a delivery `delivered` or `dead` in its own statement after the HTTP
  result, never inside the terminal transaction, mirroring Dapr's "delete
  the marker after successful publish" (`outbox.go:364-373`).
- The database is the dead-letter queue: after the sixth failure the row
  becomes `dead` with `last_error`, never deleted (dapr
  `pkg/runtime/subscription/subscription.go:407-457`; SPEC.md:925-927).
- Never mark a delivery `dead` because of shutdown; leave it `pending` with
  its `next_at` so the next leader retries (dapr `subscription.go:394-405`).
- Retry budgets are bounded and explicit: Dapr refuses unbounded policies
  and floors overrides at 3 retries (`pkg/resiliency/resiliency.go:370-459`);
  krun's six attempts on a fixed schedule live in the scheduler, the Store
  only persists `attempt` and `next_at` (SPEC.md:516, 925-927).
- A failed read is not zero. KEDA's `getRunningJobCount` returns 0 on a List
  error and can over-create Jobs (`keda pkg/scaling/scale_jobs.go:251-253`,
  keda.md:34-36, 351). `countByState`, `countQueued`, `countQueuedBy` must
  throw on error, never resolve to an empty map or 0; callers skip the tick.
- KEDA ScaledJob scales from a scaler's queue depth; krun claims from SQL
  with a lease and creates exactly one Job per run. Scaling by metrics and
  Dapr-style pub/sub are non-goals (SPEC.md:19-24); do not import either.

## Pitfalls

- `sql.val`/template interpolation for the active predicate binds it;
  use the shared `sql` fragment with literal text (rule 9).
- Building `state in (...)` for `listByState` with `sql.lit` from
  unvalidated input is injection; validate against the non-terminal set
  first.
- SQLite timestamps compare as text: write `toISOString()` only
  (fixed-width `...sssZ`); a `Date` passed to better-sqlite3 throws or
  stores a number.
- `pragma auto_vacuum = INCREMENTAL` after the tables exist is a no-op
  without `vacuum`; set pragmas before `migrate()`.
- `foreign_keys` is off per connection by default; without it `sweep`
  leaves orphan `run_events` and `deliveries`.
- A pg `Client` emits `error` then `end`; guard against reconnecting twice.
- `NOTIFY` outside the write transaction can arrive before the row is
  visible to the SSE handler's re-read; notify inside the transaction.
- `Migrator` throws on unknown recorded names; the `krun migrate` diff must
  run first (SPEC.md:1407-1410).
- `FileMigrationProvider` imports every file in the folder: no helpers or
  tests inside `migrations/*`.
- `returning *` with Kysely on SQLite returns strings for JSON and
  timestamps; route every row through the dialect mapper before `toRun`.
- `markScheduled` must clear `lease_owner`/`lease_until` or the row looks
  leased forever in diagnostics (SPEC.md:505).
- `expireQueued` must return the rows so the scheduler can delete Job and
  Secret for runs that already had a token (SPEC.md:811-814).
- `uuid` v7 across two gateway replicas in the same millisecond can order
  differently from wall clock; the cursor is still stable because it is
  `(created_at, id)`, not `id` alone.
- The installed `kysely` skill shows `Generated<Date>` defaults and
  `CamelCasePlugin`; krun uses neither (SPEC.md:399-400; column names are
  snake_case on the wire of the Store, camelCase only in `toRun`).
- SPEC RISK: SPEC.md:1405 says "forward-only" while the installed `kysely`
  skill and Kysely itself support `down`. Do not add `down` migrations or
  a `migrateDown` command without a Decisions row (PLAN.md:23-26).
- SPEC RISK: SPEC.md:548 fixes the pool at 5 connections while the gateway
  also holds `LISTEN` clients and the `wait`/SSE handlers poll every 1 s
  (SPEC.md:545-546); if load tests in P9 show pool exhaustion, record a
  Decisions row rather than silently raising the pool size.

## Before marking a task done

- Run the task's acceptance from PLAN.md:210-292 (contract test named in
  the task) and the Phase 1 gate `node --test
  'packages/shared/src/store/**/*.test.ts'` on both dialects, then
  `make check` (PLAN.md:17-18, CLAUDE.md:5).
- Branch per task id (`p1-3-claim`), Conventional Commits with scope
  `store` (`feat(store): claim query with lease`), PR to main, merge when CI
  is green, never push main (PLAN.md:13-22).
- Mark `[x]`, append `YYYY-MM-DD P1.x <short sha> note` to PLAN.md section
  6 and commit it with the code (PLAN.md:19-20).
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7, PLAN.md:16).
- Blocked (no Docker for testcontainers, no network for the Postgres
  image): `BLOCKED P1.x: <need>` in the progress log, take the next
  independent task (PLAN.md:27-28).

## Limitations

- Line numbers were verified against the working tree on 2026-10-23;
  SPEC.md/PLAN.md are being edited concurrently, so re-check a cited line
  before quoting it in a commit or a Decisions row.
- Kysely API facts marked VERIFIED were read from the 0.29.7 tarball's
  `dist/`; better-sqlite3 pragma API, pg LISTEN behaviour, uuid v7 and pnpm
  `onlyBuiltDependencies` are UNVERIFIED and should be confirmed at the
  first `pnpm install`.
- This skill does not cover the HTTP mapping of Store results (401/409 for
  `false`, error envelopes): see `krun-gateway-api`; nor the scheduler's
  use of `claimQueued`/`listStale`/`claimDeliveries`: see
  `krun-scheduler-k8s`; nor the test harness beyond the Phase 1 gate: see
  `krun-testing-ci`.
