---
name: krun-store
description: Use when writing krun Store, migrations or SQL. Implements SPEC section 6 for Postgres and SQLite behind one contract suite.
---

# krun Store (SPEC section 6)

Covers `packages/shared/src/store`: model types, `toRun`/`toRunSummary`, the
`Store` interface, both dialect implementations, migrations and the shared
contract suite, plus the Effect `Database` service they run on. Serves PLAN
Phase 1 tasks P1.1-P1.11 (PLAN.md:228-318) and is consulted by any
P3.x/P4.x task that calls a Store method. Stack (SPEC D35, D36,
docs/STACK.md 2.3): Kysely 0.29 + `pg` + Node 26's built-in `node:sqlite`
behind an in-house Kysely dialect adapter, wrapped in Effect 4 services;
no native addon; `@effect/sql-*` and `effect/sql` are not used. Postgres
16 is the supported floor; CI runs the contract suite on Postgres 18.

## When to use

- Any file under `packages/shared/src/store/**`, the `Database` layer in
  `packages/shared/src/runtime/`, or `bin/krun.js migrate`.
- Any SQL, Kysely query, migration, or row-to-wire mapping.
- A gateway or scheduler task that needs the exact semantics of a Store
  method (cite this skill's `references/store-interface.md` by row).
- Load `krun-development` first for the agent protocol; load `kysely` and
  `using-relational-databases` for query-builder syntax only (this skill
  wins on semantics), and the Effect skills docs/STACK.md section 5 lists
  (`effect-core-patterns`, `effect-error-handling`,
  `effect-resource-management`, `effect-testing`). Effect's `MIGRATION.md`
  overrides skill text written for Effect 3: `Context.Tag` is
  `Context.Service`, there is no `Runtime<R>`, `FiberRef` is
  `Context.Reference` (CLAUDE.md rule 7).

## Read first

- SPEC.md:320-381 run lifecycle (CAS, `run_events`, timestamps, `error`
  precedence); SPEC.md:383-562 data model, DDL, claim query, `Store`
  interface, cursor, `listStale`, `subscribe`, pool and pragmas.
- SPEC.md:225-265 wire rules that `toRun`/`toRunSummary` implement;
  SPEC.md:1460-1465 migration policy; SPEC.md:1390-1396 `krun migrate` env;
  D35 and D36 (SPEC.md section 15, last two rows); SPEC.md section 14
  (Postgres 16 or newer, CI on 18; Node.js 26).
- docs/STACK.md 2.3 (data packages and rules), 4.2 (tagged errors), 4.4
  (time).
- PLAN.md:36-94 toolchain and the dependency table; PLAN.md:228-318 Phase 1
  gate and tasks (P1.9 at PLAN.md:300-306); docs/API.md:229-249 `ListRuns` filter grammar.
- `references/store-interface.md`: the interface verbatim, its Effect
  form, one row per method with task, semantics, acceptance, allowed-state
  matrix, notify payloads.
- `references/ddl.md`: DDL in both dialects, index-to-query map, claim,
  delivery-claim and sweep statements.
- `references/dialect-differences.md`: type mapping, connections and
  pragmas, the `node:sqlite` dialect adapter, `listStale`, literal
  predicate, cursor, `subscribe`, migration policy and the `krun migrate`
  diff rule.

## Rules

1. Implement the `Store` interface exactly as SPEC.md:492-520 in method
   names, parameters and semantics, with `transition(..., event?)` and the
   errors `NotFoundError`, `ConflictError` (PLAN.md:231-235); no extra
   methods, options or flags (PLAN.md:31-32). The Effect form
   (`references/store-interface.md`) changes only the types: Effects
   instead of Promises, tagged failures instead of throws, `DateTime.Utc`
   instead of `Date`, a `Stream` for `subscribe`.
2. Every transition is CAS `update runs set ... where id = $id and state =
   $from`; zero rows is a stale event, return `false`, write nothing, log at
   debug (SPEC.md:341-343), because the scheduler's informer, heartbeat and
   cancel paths race by design.
3. Every terminal transition inserts the `deliveries` row in the same
   transaction when `callback_url` is set, payload `toRunSummary` of the
   updated row, including `expireQueued`, heartbeat, `job_lost` and
   `job_create_failed` (SPEC.md:348-351, D29); a crash between
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
   `at` of their `run_events` row; read `DateTime.now` once per write and
   use it for both (SPEC.md:357-359, PLAN.md:270-271).
7. The application generates all ids and all timestamps; no DB time
   defaults (SPEC.md:399-400, D9). Ids are UUIDv7 from `uuid`
   `v7({ msecs })` with `msecs` from `Clock.currentTimeMillis`; timestamps
   from `DateTime.now`. Never `Date.now()` or `new Date()` (CLAUDE.md rule
   8), so `TestClock` controls leases, `created_at` and id order in tests.
8. `transition` writes `error = coalesce(error, patch.error)` so a function's
   own report survives a later krun or Kubernetes error (SPEC.md:367-373,
   PLAN.md:272-274); `failure_reason` arrives in the patch (PLAN.md:309-313).
9. `countByState`/`listByState` filter with the `runs_active_idx` predicate
   as literal SQL from one shared `sql` fragment, never bound parameters
   (SPEC.md:534-536); bound values defeat the partial index and only the
   `explain` test catches it (PLAN.md:259-262).
10. The claim takes a lease only (`lease_owner`, `lease_until`,
    `attempt + 1`); state changes in `markScheduled` after the Job exists;
    `lease_until < now` makes a row claimable again (SPEC.md:470-487), with
    `now` read from `Clock` inside the method.
11. SQLite claim and every other Store transaction open with `begin
    immediate` through a `SqliteDriver` subclass returned by the in-house
    dialect (SPEC.md:485-486, 562; PLAN.md:300-306); a deferred
    transaction upgrading to write returns `SQLITE_BUSY` immediately
    regardless of `busy_timeout`.
12. `listStale` SQLite uses `max(coalesce(json_extract(runtime_status,
    '$.at'), started_at), started_at)`; scalar `max` returns null on any
    null (SPEC.md:523-527).
13. `setJobStatus` writes and appends only when a field other than
    `observedAt` changed, with the same comparison inside the CAS
    (SPEC.md:511, 858-860); `setRuntimeStatus`, `setResult`, `setError` are
    allowed only in `queued` with a token, `scheduled`, `running`
    (SPEC.md:508-510, D27).
14. `listRuns` orders `created_at desc, id desc`, cursor base64url
    `created_at|id` plus a parent/filter hash, row-value comparison
    `(created_at, id) < ($createdAt, $id)` in both dialects, items are
    `RunSummary`; the unfiltered admin list uses `runs_created_idx`
    (SPEC.md:522-523, 236-240; PLAN.md:275-283).
15. Postgres: pool of 5 per process (`query_timeout` 10000) plus one
    dedicated `LISTEN` client outside the pool. SQLite: one synchronous
    `node:sqlite` connection reached through the in-house adapter in
    `packages/shared/src/store/sqlite/dialect.ts`, no pool, the five
    pragmas on every open (SPEC.md:548-566, docs/STACK.md 2.3).
16. `toRun` (FULL) and `toRunSummary` (BASIC = minus `input`, `result`,
    `logTail`, `error.details`) in `packages/shared/src/store` are the only
    row-to-wire mappers; `listRuns`, delivery payload, SSE and the gateway
    all use them (SPEC.md:529-539, 264-265).
17. `request_hash` = lowercase hex SHA-256 (`node:crypto`) of the RFC 8785
    (JCS) serialisation of `{ input, priority, callback }` as received,
    produced by the `canonicalize` package (SPEC.md:527-529, docs/STACK.md
    2.5); same key + same hash returns the existing run, same key +
    different hash fails with `ConflictError` (PLAN.md:244-252).
18. Migrations: Kysely `Migrator` + `FileMigrationProvider`, one folder per
    dialect, raw SQL in `sql` templates, forward-only expand/contract; `krun
    migrate` diffs `kysely_migration` first (SPEC.md:385-388, 1460-1465;
    PLAN.md:236-243).
19. Only docs/STACK.md dependencies: `effect`, `kysely`, `pg`, `uuid`,
    `canonicalize`, plus the built-in `node:sqlite`; dev `vitest`,
    `@effect/vitest`, `fast-check`, `testcontainers`,
    `@testcontainers/postgresql`, `@types/pg`. No SQLite package: embedded
    mode is the built-in `node:sqlite` and krun has no native addons (D36,
    docs/STACK.md principle 8). `@effect/sql-kysely`, `@effect/sql-pg`, `effect/sql`, an ORM,
    a migration CLI or `pg-listen` need a Decisions row first
    (PLAN.md:29-30, docs/STACK.md 2.3 "considered and rejected").
20. Every Kysely call runs through the `Database` service inside
    `Effect.tryPromise`, mapping the rejection to a tagged `DatabaseError`
    (docs/STACK.md 2.3, 4.2). No `throw` outside the adapter; a failed read
    is a failure, never an empty result.
21. Never log `input`, `result`, `runtimeStatus`, `error.details`, `dsn`,
    tokens or hashes of tokens (SPEC.md:1181-1186); the Store logs ids,
    states and reasons only.
22. Postgres 16 is the floor (SPEC.md section 14), CI tests only 18: SQL
    and migrations use nothing newer than 16. No `uuidv7()` (18; ids come
    from the application anyway), no `MERGE ... RETURNING` or `JSON_TABLE`
    (17). CI cannot catch this, so review migrations for it.
23. Every Store method call is an Effect span (`Effect.withSpan` in the
    `Store` layer, kind `client`, name `store.<method>`) with the method
    name, row count and, whenever the call is for one run, the attribute
    `krun.run_id`; never SQL text with values, bound parameters or row
    contents (SPEC.md:1147-1157). The span table and test recipe live in
    `krun-process-runtime` `references/telemetry.md`. The Store keeps no
    trace context with the run: v1 does not join a run's spans into one
    trace.

## Layout and types (P1.1)

- Files: `packages/shared/src/store/{index,model,errors,mappers,kysely}.ts`
  (names are a suggestion), `store/postgres/`, `store/sqlite/`,
  `store/migrations/{postgres,sqlite}/0001_init.ts`, `store/contract/`
  (PLAN.md:97-102). The `Database` layer lives in
  `packages/shared/src/runtime/` (PLAN.md:107). Tests sit next to code as
  `*.test.ts` (PLAN.md:133).
- Services: `Database` (`Context.Service`) holds the Kysely instance and
  the dialect; its layer is scoped: acquire builds the pool or opens the
  SQLite file and sets the pragmas, release calls `db.destroy()`. `Store`
  (`Context.Service`) is built from `Database`, one layer per dialect
  (`StorePostgres`, `StoreSqlite`). Exact `Context.Service` class syntax
  per Effect's `MIGRATION.md`.
- Errors: `NotFoundError`, `ConflictError`, `DatabaseError` are
  `Data.TaggedError` classes (docs/STACK.md 4.2 also lists `RunNotFound`
  and `IdempotencyConflict` as example domain tags; PLAN P1.1 names win
  for the Store, the gateway maps them to envelopes).
- Type stripping: `State`, `DeliveryState`, `FailureReason` are string
  union types plus `as const` arrays, never `enum`; classes use explicit
  field declarations, never parameter properties (PLAN.md:42-44).
- `Run` holds lowercase DB values; `toRun` renders UPPER_SNAKE, `name`
  (`functions/<fn>/runs/<id>`, docs/API.md), `createTime`/`scheduleTime`/
  `startTime`/`endTime`, `resultUri`, `runtimeStatus.reportTime`,
  `jobStatus.observeTime`; omit unset fields, never `null` (SPEC.md:245-246,
  259-265). Times render with `DateTime.formatIso`.
- Acceptance: `tsc --noEmit` passes with no implementation (PLAN.md:234-235).

## Contract suite (Phase 1 gate)

- One suite in `store/contract/` exported as `runStoreContract(name,
  storeLayer)`; `postgres/*.test.ts` and `sqlite/*.test.ts` call it. Tests
  are `@effect/vitest` `it.effect` (already scoped) with the dialect's layer
  provided through `layer(...)`.
- SQLite: `fs.mkdtemp` under `os.tmpdir()`, removed in `afterAll`
  (PLAN.md:231-234). Postgres: `@testcontainers/postgresql` on a
  `postgres:18` image pinned by digest (PLAN Phase 1 gate), one container
  per file, started in an `Effect.acquireRelease` layer (or `beforeAll`)
  with `db.destroy()` and container stop on release.
- Gate: `pnpm exec vitest run packages/shared/src/store` green on both
  (PLAN.md:231-234). Skip, never fake, the Postgres half when Docker is
  absent, and write `BLOCKED` (PLAN.md:27-28).
- Time: lease expiry, the 60 s delivery lease and `listStale` cut-offs are
  driven with `TestClock.adjust` (the Store reads `Clock`), never real
  sleeps. `TestClock` starts at epoch 0: set a realistic time first
  (`TestClock.setTime`) so seeded timestamps look like production ones.
  The "observed within 2 s" `subscribe` test on Postgres measures real
  `NOTIFY` latency: run it with the live clock (`it.live`), and the SQLite
  poll with `TestClock.adjust("1 second")`.
- Planner tests: seed 5000 terminal + 50 active rows, `analyze runs`, then
  inside a transaction `set local enable_seqscan = off` and assert the
  `explain` text names `runs_active_idx` (`countByState`) and
  `runs_created_idx` (unfiltered admin `listRuns`) (PLAN.md:259-262,
  282-283). Postgres only; SQLite has no `set local`.
- Concurrency tests: `Effect.all` of N identical `createRun` calls with
  `{ concurrency: "unbounded" }` yields one row and one event
  (PLAN.md:250-252); two claimers never share a run while the lease is
  valid (PLAN.md:257-258); P1.9 opens a second `node:sqlite` connection
  with `busy_timeout` 0 and expects `SQLITE_BUSY` on `begin immediate`
  while a Store transaction is open (PLAN.md:302-306). Assert the error's
  `errcode === 5` (SQLITE_BUSY), not its `code`: `node:sqlite` reports
  `code: 'ERR_SQLITE_ERROR'`, `errcode: 5`, `errstr: 'database is
  locked'` (observed on Node 24.22; UNVERIFIED on Node 26).
- Delivery test: a terminal transition with a callback leaves exactly one
  `pending` delivery whose payload has `name`, `state: 'SUCCEEDED'`,
  `createTime` and no `input` (PLAN.md:267-270).
- `request_hash`: a fast-check property that key order and whitespace
  never change the hash (docs/STACK.md 3).

## Library facts

From docs/research/node-stack-facts.md; VERIFIED means checked against the unpacked
tarball under `~/.hermes/cache/scratch/krun-skills/pkgs/`.

- Kysely 0.29.7: `SqliteDriver.beginTransaction` runs `begin`
  (`dist/dialect/sqlite/sqlite-driver.js:26-28`, VERIFIED); override it for
  `begin immediate`. The SQLite adapter reports a single connection, so
  Kysely serialises calls through a `ConnectionMutex`
  (`dist/driver/runtime-driver.js:22-24`, VERIFIED).
- Kysely 0.29.7 `SqliteDialectConfig.database` takes a `SqliteDatabase`
  (`close()`, `prepare(sql)`) whose `SqliteStatement` has `readonly
  reader: boolean`, `all(params)`, `run(params)` returning `{ changes,
  lastInsertRowid }`, `iterate(params)`
  (`dist/dialect/sqlite/sqlite-dialect-config.d.ts:40-52`, VERIFIED).
  `SqliteConnection.executeQuery` calls `stmt.all(parameters)` when
  `reader`, else `stmt.run(parameters)`, passing the parameter array as
  one argument (`sqlite-driver.js:56-69`, VERIFIED). `SqliteDialect` keeps
  its config in a private field, so the krun dialect subclass keeps its
  own copy and overrides `createDriver()` (`sqlite-dialect.js`,
  VERIFIED). Sketch in `references/dialect-differences.md` section 2.
- `node:sqlite` (built in; release candidate in Node 26, D36). Observed on
  Node 24.22.0 with Kysely 0.29.7; UNVERIFIED on Node 26 until the P1.9
  test runs there: statements have
  `run`, `get`, `all`, `iterate`, `columns`; parameters are spread
  (`stmt.all(...params)`): an array passed as the single argument is read
  as a named-parameter object and fails `Unknown named parameter '0'`, so
  the adapter spreads; `reader` is `stmt.columns().length > 0` (an
  `insert ... returning` has columns, a plain `insert` has none); rows
  have a null prototype; `undefined` and `Date` cannot be bound
  (`ERR_INVALID_ARG_TYPE`), booleans bind as 1/0; integers read as JS
  numbers; there is no `db.pragma()` helper, use `db.exec('pragma ...')`
  and `db.prepare('pragma journal_mode').get()` (returns `{ journal_mode:
  'wal' }`). Node 24.22 bundles SQLite 3.53.4; Node 26's bundled version
  is UNVERIFIED (`select sqlite_version()` in P1.9; `returning` needs
  3.35+). Node 24.22 exports the class as `DatabaseSync`; docs/STACK.md
  2.3 names it `Database`; the Node 26 export name is UNVERIFIED, check
  `Object.keys(await import('node:sqlite'))` before writing the adapter.
- Kysely `migrateToLatest()` never throws; read `error` from the result
  (`dist/migration/migrator.d.ts:61-66`, VERIFIED) and turn it into a
  tagged failure. `getMigrations()` returns name + `executedAt` sorted by
  name (VERIFIED). Out-of-order or missing executed migrations throw
  "corrupted migrations" (`dist/migration/migrator.js:500-508`, VERIFIED),
  so run the `krun migrate` diff before the migrator.
- Kysely `sql.lit` inlines, `sql.val` binds (`dist/raw-builder/sql.d.ts:124,
  279`, VERIFIED); `eb.refTuple`/`eb.tuple` exist for row-value comparison
  (`dist/expression/expression-builder.d.ts:561`, VERIFIED).
- Effect `Effect.tryPromise({ try, catch })` maps a rejection to the
  `catch` result; the `try` callback receives an `AbortSignal` that fires
  on interruption, but `pg` and `node:sqlite` cannot cancel a running
  query with it: an interrupted write may still commit. `node:sqlite` is
  synchronous, so a slow statement also blocks the event loop.
- pg 8.23.1: use a dedicated `Client` for `LISTEN`; on `error`/`end` create
  a new `Client` (a Client cannot reconnect), `connect()`, re-`LISTEN`, and
  rely on the 1 s poll fallback for the gap; payload limit 8000 bytes;
  `NOTIFY` in a transaction is delivered on commit (docs/research/node-stack-facts.md:688-694,
  UNVERIFIED API detail). pg parses `timestamptz` into a JS `Date`;
  convert it to `DateTime.Utc` in the dialect mapper (a driver-built
  `Date` is fine, building one in krun code is not).
- uuid 14: `import { v7 } from 'uuid'`; `v7({ msecs })` with the time from
  `Clock` (docs/STACK.md 2.5). Whether explicit `msecs` keeps the
  within-millisecond monotonic sequence is UNVERIFIED; the `listRuns`
  cursor is `(created_at, id)` so order stays stable either way. Use
  `uuid` even if Node offers a built-in v7: only `msecs` from `Clock`
  keeps ids deterministic under `TestClock`.
- canonicalize 5.1: one function from an object to its RFC 8785 string;
  its default-export shape under `nodenext` ESM is UNVERIFIED, check once.
- No store dependency has an install or build script (`pg`, `kysely`,
  `uuid`, `canonicalize` are plain JavaScript; SQLite is built into Node),
  so the store needs no pnpm build approval and the image no compiler.

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
  fail with `DatabaseError`, never succeed with an empty map or 0 (no
  `Effect.orElseSucceed` in the Store); callers skip the tick.
- KEDA ScaledJob scales from a scaler's queue depth; krun claims from SQL
  with a lease and creates exactly one Job per run. Scaling by metrics and
  Dapr-style pub/sub are non-goals (SPEC.md:19-24); do not import either.

## Pitfalls

- `sql.val`/template interpolation for the active predicate binds it;
  use the shared `sql` fragment with literal text (rule 9).
- Building `state in (...)` for `listByState` with `sql.lit` from
  unvalidated input is injection; validate against the non-terminal set
  first.
- SQLite timestamps compare as text: write `DateTime.formatIso` output only
  (fixed-width `...sssZ`); a `Date` or `DateTime` object bound through
  `node:sqlite` throws `ERR_INVALID_ARG_TYPE`, and so does `undefined`.
  Map optional fields to `null` before binding.
- The adapter must spread parameters into `node:sqlite`; passing Kysely's
  array as one argument works only for zero-parameter statements, so a
  bug here hides until the first query with a bound value.
- `node:sqlite` rows have a null prototype: route them through the dialect
  mapper into plain objects before `toRun`, and do not `toStrictEqual` a
  raw row against an object literal.
- The P1.9 `SQLITE_BUSY` assertion checks `errcode` 5; `code` is the
  generic `ERR_SQLITE_ERROR` for every SQLite failure.
- `node:sqlite` is a release candidate in Node 26 (D36): a Node minor may
  change it. Keep every `node:sqlite` call inside `dialect.ts` and the
  open sequence so a change touches one file.
- Do not run Effects inside a Kysely transaction callback. Read the clock,
  make ids and compute the hash first, then run the whole transaction as
  one Promise-returning Kysely function inside one `Effect.tryPromise`.
- `Effect.timeout` around a Store call (the gateway's 5 s internal bound)
  abandons the promise but not the query: the write may still commit. The
  CAS and the idempotency index make the retry harmless; never assume a
  timed-out write did nothing.
- `pragma auto_vacuum = INCREMENTAL` after the tables exist is a no-op
  without `vacuum`; set pragmas before `migrate()`.
- `foreign_keys` is off per connection by default; without it `sweep`
  leaves orphan `run_events` and `deliveries`.
- A pg `Client` emits `error` then `end`; guard against reconnecting twice.
- `NOTIFY` outside the write transaction can arrive before the row is
  visible to the SSE handler's re-read; notify inside the transaction.
- `Migrator` throws on unknown recorded names; the `krun migrate` diff must
  run first (SPEC.md:1462-1465).
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
- Skills and blog posts pairing Effect with SQL point at `@effect/sql`;
  docs/STACK.md 2.3 rejected it (Effect 3 only for Kysely, unstable and
  Effect Schema based in Effect 4). Stay on Kysely behind `Database`.
- SPEC RISK: SPEC.md:1460 says "forward-only" while the installed `kysely`
  skill and Kysely itself support `down`. Do not add `down` migrations or
  a `migrateDown` command without a Decisions row (PLAN.md:23-26).
- SPEC RISK: SPEC.md:548 fixes the pool at 5 connections while the gateway
  also holds `LISTEN` clients and the `wait`/SSE handlers poll every 1 s
  (SPEC.md:545-546); if load tests in P9 show pool exhaustion, record a
  Decisions row rather than silently raising the pool size.

## Before marking a task done

- Run the task's acceptance from PLAN.md:236-318 (contract test named in
  the task) and the Phase 1 gate `pnpm exec vitest run
  packages/shared/src/store` on both dialects, then `make check`
  (PLAN.md:17-18, CLAUDE.md:5).
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
  `dist/`. The `node:sqlite` facts and the dialect adapter sketch were
  observed on Node 24.22.0 only; the Node 26 export name, bundled SQLite
  version and adapter behaviour are UNVERIFIED until the P1.9 test runs on
  Node 26. pg LISTEN behaviour, uuid v7 with `msecs` and canonicalize's
  export shape are UNVERIFIED and should be confirmed at the first
  `pnpm install`.
  Effect 4 API names in this skill follow docs/STACK.md; where one is
  uncertain, Effect's `MIGRATION.md` decides.
- This skill does not cover the HTTP mapping of Store results (401/409 for
  `false`, error envelopes): see `krun-gateway-api`; nor the scheduler's
  use of `claimQueued`/`listStale`/`claimDeliveries`: see
  `krun-scheduler-k8s`; nor the test harness beyond the Phase 1 gate: see
  `krun-testing-ci`.
