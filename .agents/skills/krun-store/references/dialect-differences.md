# Dialect differences: Postgres vs SQLite

One schema, two dialects, identical table and column names (SPEC.md:385).
Everything that differs is listed here so the two implementations under
`packages/shared/src/store/postgres/` and `packages/shared/src/store/sqlite/`
(PLAN.md:98-99) stay small and the contract suite stays the single source
of behaviour.

## 1. Type mapping (SPEC.md:390-397)

| Concept | Postgres | SQLite | Row <-> TS |
|---|---|---|---|
| `id` | `uuid` | `text` | `string`, UUIDv7 from `uuid` `v7({ msecs })` with `msecs` from `Clock.currentTimeMillis` (SPEC.md:400, D9 SPEC.md:1450, docs/STACK.md 2.5) |
| JSON columns (`input result error runtime_status job_status payload`) | `jsonb` | `text`, read with JSON1 | PG returns parsed objects; SQLite returns a string: `JSON.parse` in the row mapper. Insert with `JSON.stringify(v)` in both (docs/research/node-stack-facts.md:658-661, UNVERIFIED) |
| timestamps | `timestamptz` | `text`, RFC 3339 UTC with milliseconds | `DateTime.Utc` in `Run`. pg returns a driver-built `Date`, SQLite returns the string; convert both to `DateTime.Utc` in the dialect mapper (Effect 3 `DateTime.unsafeMake`; check MIGRATION.md for the Effect 4 name). Write `DateTime.formatIso(dt)` in both dialects (always `YYYY-MM-DDTHH:mm:ss.sssZ`, fixed width, sorts as text; pg accepts the string for `timestamptz`) |
| `state` | `text` + `check` | `text` + `check` | string union `State` |
| `int` | `int` | `integer` | `number` |
| partial indexes | yes | yes | same DDL text |
| `returning` | yes | yes (3.35+) | same builders; better-sqlite3 13.0.3 bundles SQLite 3.53.4 (VERIFIED from the tarball) |

Rules that follow:

- Never rely on the driver's timestamp parsing for ordering in SQLite: the
  text format is the order. A single non-ISO or local-offset string breaks
  `listRuns`, `claimQueued` and `sweep` silently.
- Kysely table types: use `ColumnType<Select, Insert, Update>` so `Date`
  (pg) or `string` (SQLite) on select and `string` on insert can differ per
  dialect, or map at the dialect boundary and keep one `RunRow` type with
  `DateTime.Utc` fields for `toRun`. Pick one; the
  contract suite must pass unchanged on both.
- `toRun(row)` and `toRunSummary(row)` are the only row-to-wire mappers
  (SPEC.md:529-539, 264-265): UPPER_SNAKE enums, `name`, `*Time` fields,
  `resultUri` from `result_ref`, `runtimeStatus.reportTime` from JSON `at`,
  `jobStatus.observeTime` from JSON `observedAt`. Unset fields are omitted,
  never `null` (SPEC.md:245-246).

## 2. Connection and transactions

| Topic | Postgres | SQLite |
|---|---|---|
| Pool | `pg.Pool` of 5 per process (SPEC.md:548) | none: one synchronous `better-sqlite3` connection per process (SPEC.md:561) |
| Extra connection | one dedicated `pg.Client` for `LISTEN`, outside the pool (SPEC.md:548-549) | none |
| Transaction start | Kysely default `begin` | `SqliteDriver` subclass whose `beginTransaction` runs `begin immediate` (SPEC.md:562, PLAN.md:295-297) |
| Row locking | `for update skip locked` in claim statements (SPEC.md:480, 515) | serialised by `begin immediate` plus Kysely's connection mutex; omit the clause (SPEC.md:485) |
| Pragmas | none | set on every connection (SPEC.md:551-559), see below |
| Lifecycle | the `Database` layer is scoped: acquire builds `pg.Pool` (`max: 5`, `query_timeout: 10000`), release `db.destroy()` | acquire opens the file and sets the pragmas, release `db.destroy()` |
| Query errors | rejection -> `Effect.tryPromise` `catch` -> `DatabaseError` | `better-sqlite3` throws synchronously inside Kysely's promise; same mapping |

Kysely facts (VERIFIED from `pkgs/kysely-0.29.7/package/dist`):

- `SqliteDriver.beginTransaction(connection)` runs
  `CompiledQuery.raw('begin')` (`dialect/sqlite/sqlite-driver.js:26-28`).
  Override: `class ImmediateSqliteDriver extends SqliteDriver {
  async beginTransaction(connection) { await connection.executeQuery(
  CompiledQuery.raw('begin immediate')) } }` and a `Dialect` whose
  `createDriver()` returns it; `SqliteDialect`'s `createQueryCompiler`,
  `createAdapter`, `createIntrospector` can be reused.
- `SqliteAdapter.supportsMultipleConnections` is false, so the runtime driver
  wraps every `acquireConnection` in a `ConnectionMutex`
  (`driver/runtime-driver.js:22-24, 49-51`): Store calls serialise per
  process. Do not open a second `better-sqlite3` handle in the Store; the
  P1.9 test opens one only to prove `SQLITE_BUSY` (PLAN.md:298-300).
- `SqliteAdapter.acquireMigrationLock` is a no-op (single connection); the
  Postgres adapter takes a real lock (`dialect/sqlite/sqlite-adapter.js:13-20`).

### SQLite pragmas (SPEC.md:553-559, verbatim)

```
journal_mode = WAL
synchronous  = NORMAL
busy_timeout = 5000
foreign_keys = ON
auto_vacuum  = INCREMENTAL
```

- Apply with `db.pragma('journal_mode = WAL')` etc. right after
  `new Database(path)` and before `migrate()`; `db.pragma('journal_mode',
  { simple: true })` returns `'wal'` for the P1.9 assertion
  (docs/research/node-stack-facts.md:676-678, UNVERIFIED API detail).
- `auto_vacuum` only takes effect on an empty database or after `vacuum`;
  set it before the first migration creates tables.
- `foreign_keys` is per connection and off by default; without it
  `on delete cascade` in `sweep` is silently ignored.
- `busy_timeout` makes a plain write wait; it does not save a deferred
  transaction that upgrades to a write while another writer holds the lock,
  which is why every Store transaction opens with `begin immediate`
  (docs/research/node-stack-facts.md:678-681).

## 3. `listStale` expressions (SPEC.md:523-527)

"Running runs whose later of `runtime_status.at` and `started_at` is
`< before`" (SPEC.md:513).

| Dialect | Expression |
|---|---|
| Postgres | `greatest((runtime_status->>'at')::timestamptz, started_at) < $before` |
| SQLite | `max(coalesce(json_extract(runtime_status,'$.at'), started_at), started_at) < $before` |

Postgres `greatest` ignores nulls; SQLite's scalar `max` returns null when
any argument is null, so the `coalesce` is mandatory or runs without a
runtime status are never returned (SPEC.md:525-527). Both run with
`where state = 'running' and function_name = $fn`. The SQLite comparison is
text against an RFC 3339 string, so `runtime_status.at` must be written in
the same fixed format as `started_at` (SPEC.md:394).

## 4. `countByState` / `listByState` literal predicate (SPEC.md:534-536)

Both planners match a partial index only when the query text repeats the
index predicate. Define one fragment and reuse it in both dialects:

```ts
export const activePredicate =
  sql`state in ('queued','scheduled','running','cancelling')`;
```

Never build it from bound parameters (`state in (${states})` binds `$1..$4`
and the planner cannot prove they equal the predicate). For `listByState`
append `and state in (${sql.join(states.map(s => sql.lit(s)))})` only after
validating each requested state against the non-terminal set (so
`sql.lit` never receives untrusted text). `sql.lit` inlines, `sql.val`
binds (`raw-builder/sql.d.ts:124, 279`, VERIFIED). Acceptance: Postgres
`explain` inside a transaction with `set local enable_seqscan = off`, after
seeding 5000 terminal + 50 active rows and `analyze runs`, names
`runs_active_idx` (PLAN.md:259-262).

## 5. `listRuns` cursor (SPEC.md:522-523, PLAN.md:275-283)

- Order `created_at desc, id desc` in both dialects (SPEC.md:236, 439).
- Cursor: base64url of `created_at|id` plus a hash of parent and filter
  (PLAN.md:277-278, docs/API.md:234-235); a mismatch or malformed token is
  `REQUEST_INVALID` at the gateway (SPEC.md:237-238), the Store only
  decodes.
- Comparison: row value `(created_at, id) < ($createdAt, $id)` in both
  dialects (SPEC.md:522-523). Kysely: `eb.refTuple('created_at', 'id')`
  with `eb.tuple(createdAt, id)` (`expression/expression-builder.d.ts:561`,
  VERIFIED to exist) or `sql\`(created_at, id) < (${a}, ${b})\``. SQLite
  supports row values since 3.15.
- Postgres `uuid` compares bytewise and UUIDv7 text compares the same way,
  so `id desc` ties agree across dialects (D9 SPEC.md:1450).

## 6. `subscribe` per dialect (SPEC.md:541-549, PLAN.md:290-294)

| Topic | Postgres | SQLite |
|---|---|---|
| Shape | a `Stream` whose scope owns the dedicated client (`Effect.acquireRelease`), events pushed from `client.on('notification')` | a `Stream` of rows polled on `Schedule.spaced("1 second")` |
| Mechanism | `LISTEN krun_runs` on the dedicated client; writers `pg_notify('krun_runs', '<id>:<state>' / ':status' / ':job_status')` inside the write transaction (SPEC.md:344-347) | poll `select rowid, run_id, from_state, to_state from run_events where rowid > ? order by rowid` every 1 s |
| Start position | from connect | `max(rowid)` at subscribe time; never emit older rows (SPEC.md:542-543) |
| Kind | parsed from the payload suffix | `from_state = to_state` -> `job_status`, else `state`; runtime status is not in `run_events`, SSE picks it up through the handler's 1 s re-read (SPEC.md:543-545) |
| Reconnect | `client.on('error')` / `on('end')` fail the stream with `DatabaseError`; a `pg.Client` cannot reconnect, so `Stream.retry` with `Schedule.exponential` re-runs the acquire (new `Client`, `connect()`, `LISTEN`), and the handlers' 1 s poll fallback covers the gap (docs/research/node-stack-facts.md:688-694, UNVERIFIED API detail; PLAN.md:290) | none needed |
| Shutdown | the consumer fiber is interrupted, the stream scope closes, the release runs `UNLISTEN` and `client.end()` | the poll stops with the fiber; nothing to clear |
| Payload limit | 8000 bytes; krun sends `<id>:<kind>` only (docs/research/node-stack-facts.md:693) | n/a |

Both modes keep the 1 s poll fallback in the wait and SSE handlers
(SPEC.md:545-546); `subscribe` is a latency hint, not the correctness path.
Acceptance: a transition is observed within 2 s in both modes; SQLite never
re-emits a row (PLAN.md:293-294). Under `TestClock` the SQLite poll
advances with `TestClock.adjust("1 second")`; the Postgres latency test
needs the live clock (`it.live`).

## 7. Migration policy and `krun migrate` (SPEC.md:385-388, 1405-1410; PLAN.md:236-243)

- Runner: Kysely `Migrator` with `FileMigrationProvider`, one folder per
  dialect, each migration exports `up(db)` running raw SQL through `sql`
  templates (PLAN.md:236-238). No `down` is required; krun is forward-only
  (SPEC.md:1405).
- Name migrations so string order is chronological: `0001_init.ts`,
  `0002_<topic>.ts`. `FileMigrationProvider` sorts by file name and
  `Migrator` refuses executed migrations that are missing or out of order
  ("corrupted migrations", `migration/migrator.js:500-508`, VERIFIED).
- Under Vitest the provider's own `import()` runs in Node, outside Vite's
  transform, so it loads the `.ts` migration through Node 24 type stripping
  (UNVERIFIED; check in P1.2): keep migrations erasable-syntax only and
  importing nothing but `kysely`. Under `tsc` output it imports `.js`.
  Point `migrationFolder` at `import.meta.dirname`-relative paths and keep
  the two dialect folders free of non-migration files (the provider
  imports every file in the folder).
- `migrateToLatest()` never throws; check `result.error`
  (`migration/migrator.d.ts:61-66`, VERIFIED) and fail `migrate()` with a
  tagged error on it.
- Policy: expand/contract, each migration keeps the previous minor's code
  working, drops ship one minor later, `helm rollback` by one minor is
  supported (SPEC.md:1405-1407, docs/OPERATIONS.md:31-36).
- `krun migrate` diff rule (SPEC.md:1407-1410, PLAN.md:238-243): before
  `migrateToLatest`, call `migrator.getMigrations()` (sorted by name, each
  with `executedAt` when recorded, `migration/migrator.d.ts:59, 377-391`,
  VERIFIED) and read `kysely_migration` directly for names the binary does
  not know:

  | Unknown names in `kysely_migration` | Pending in the binary | Behaviour |
  |---|---|---|
  | none | any | run `migrateToLatest`, exit 0 |
  | some | none | warn (database newer than binary), exit 0 |
  | some | some | exit 1, run nothing |

  `krun migrate` is an Effect program under `NodeRuntime.runMain`: the
  warning is an Effect log line, exit 1 is a tagged failure of the main
  effect, never `process.exit`.

  Note that `Migrator` itself would throw "corrupted migrations" in the
  "some unknown" cases because the executed list no longer matches; the
  diff must run first and decide, so the operator sees krun's message, not
  Kysely's.
- `krun migrate` reads only `KRUN_DB_MODE`, `KRUN_DB_DSN`, `KRUN_DB_PATH`
  (SPEC.md:1346-1347, 1188-1190); it runs as the chart's pre-upgrade hook in
  Postgres mode and as an init step in embedded mode (SPEC.md:1343,
  1359-1361, docs/OPERATIONS.md:31-34). Never log the DSN (pino `redact`
  covers `dsn`, SPEC.md:1151-1153).
- Acceptance (PLAN.md:241-243): migrate up twice is idempotent on both
  dialects; a database with one extra recorded migration yields exit 0 and
  the warning; extra plus pending yields exit 1. Simulate "extra" by
  inserting a row into `kysely_migration` in the test.

## 8. Things that are the same on purpose

- All ids and timestamps come from the application (SPEC.md:399-400).
- Every transition is a CAS; zero rows is a stale event (SPEC.md:341-343).
- `run_events` content and the delivery-in-transaction rule (SPEC.md:344-356).
- `request_hash` is the lowercase hex SHA-256 of the RFC 8785 serialisation
  of `{ input, priority, callback }` (SPEC.md:527-529) via `canonicalize`;
  compute it once in shared code, not per dialect.
- `toRun`/`toRunSummary` and `RunSummary` live in `packages/shared/src/store`
  and are shared by `listRuns`, the delivery payload, SSE and the gateway
  (SPEC.md:536-539).
