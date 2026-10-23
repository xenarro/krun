# Dialect differences: Postgres vs SQLite

One schema, two dialects, identical table and column names (SPEC.md:385).
Every difference is listed here, so the implementations under
`packages/shared/src/store/postgres/` and `packages/shared/src/store/sqlite/`
(PLAN.md:98-99) stay small and the contract suite stays the single source
of behaviour.

## 1. Type mapping (SPEC.md:390-397)

| Concept | Postgres | SQLite | Row <-> TS |
|---|---|---|---|
| `id` | `uuid` | `text` | `string`, UUIDv7 from `uuid` `v7({ msecs })` with `msecs` from `Clock.currentTimeMillis` (SPEC.md:400, D9, docs/STACK.md 2.5) |
| JSON columns (`input result error runtime_status job_status payload`) | `jsonb` | `text`, read with JSON1 | PG returns parsed objects; SQLite returns a string: `JSON.parse` in the row mapper. Insert with `JSON.stringify(v)` in both (docs/research/node-stack-facts.md:658-661, UNVERIFIED) |
| timestamps | `timestamptz` | `text`, RFC 3339 UTC with milliseconds | `DateTime.Utc` in `Run`. pg returns a driver-built `Date`, SQLite returns the string; convert both to `DateTime.Utc` in the dialect mapper (Effect 3 `DateTime.unsafeMake`; check MIGRATION.md for the Effect 4 name). Write `DateTime.formatIso(dt)` in both dialects (always `YYYY-MM-DDTHH:mm:ss.sssZ`, fixed width, sorts as text; pg accepts the string for `timestamptz`) |
| `state` | `text` + `check` | `text` + `check` | string union `State` |
| `int` | `int` | `integer` | `number` |
| partial indexes | yes | yes | same DDL text |
| `returning` | yes | yes (3.35+) | same builders; Node 24.22's `node:sqlite` bundles SQLite 3.53.4 (observed); Node 26's bundled version is UNVERIFIED, assert `select sqlite_version()` >= 3.35 in P1.9 |

Rules that follow:

- SQLite ordering never relies on driver timestamp parsing: the text
  format is the order. One non-ISO or local-offset string silently breaks
  `listRuns`, `claimQueued` and `sweep`.
- Kysely table types: either `ColumnType<Select, Insert, Update>`, so
  `Date` (pg) or `string` (SQLite) on select and `string` on insert differ
  per dialect; or map at the dialect boundary and keep one `RunRow` type
  with `DateTime.Utc` fields for `toRun`. Pick one; the contract suite must
  pass unchanged on both.
- `toRun(row)` and `toRunSummary(row)` (SKILL.md rule 16) map
  UPPER_SNAKE enums, `name`, `*Time` fields, `resultUri` from
  `result_ref`, `runtimeStatus.reportTime` from JSON `at`,
  `jobStatus.observeTime` from JSON `observedAt`. Unset fields are omitted,
  never `null` (SPEC.md:245-246, 529-539, 264-265).

## 2. Connection and transactions

| Topic | Postgres | SQLite |
|---|---|---|
| Pool | `pg.Pool` of 5 per process (SPEC.md:548) | none: one synchronous `node:sqlite` connection per process behind the in-house dialect (SPEC.md section 6, last paragraph) |
| Extra connection | one dedicated `pg.Client` for `LISTEN`, outside the pool (SPEC.md:548-549) | none |
| Transaction start | Kysely default `begin` | `SqliteDriver` subclass whose `beginTransaction` runs `begin immediate`, returned by the krun dialect's `createDriver()` (SPEC.md section 6, PLAN.md:300-306) |
| Row locking | `for update skip locked` in claim statements (SPEC.md:480, 515) | serialised by `begin immediate` plus Kysely's connection mutex; omit the clause (SPEC.md:485) |
| Pragmas | none | set on every connection (SPEC.md:551-559), see below |
| Lifecycle | the `Database` layer is scoped: acquire builds `pg.Pool` (`max: 5`, `query_timeout: 10000`), release `db.destroy()` | acquire opens the file and sets the pragmas, release `db.destroy()` |
| Query errors | rejection -> `Effect.tryPromise` `catch` -> `DatabaseError` | `node:sqlite` throws synchronously inside Kysely's async `executeQuery`, which turns it into a rejection; same mapping. SQLite result codes are on `errcode` (5 = `SQLITE_BUSY`), `code` is always `ERR_SQLITE_ERROR` (observed on Node 24.22) |

Kysely internals the adapter relies on (`SqliteDriver`, `ConnectionMutex`,
`acquireMigrationLock`, `SqliteDialectConfig`): `library-facts.md`
"Kysely 0.29.7".

### The `node:sqlite` dialect adapter (P1.9, `store/sqlite/dialect.ts`)

STACK.md 2.3 budgets about 40 lines. The sketch ran against Kysely 0.29.7
on Node 24.22.0 (insert with `returning`, update, transaction, row-value
comparison, `stream()`). Every detail is UNVERIFIED on Node 26 until the
P1.9 test passes there, starting with the class name (Node 24.22 exports
`DatabaseSync`; docs/STACK.md 2.3 names it `Database`).

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite" // Node 26 name: check
import {
  CompiledQuery, SqliteDialect, SqliteDriver,
  type DatabaseConnection, type SqliteDatabase, type SqliteDialectConfig,
} from "kysely"

const asKysely = (db: DatabaseSync): SqliteDatabase => ({
  close: () => db.close(),
  prepare: (sql) => {
    const stmt = db.prepare(sql)
    const args = (p: ReadonlyArray<unknown>) => p as SQLInputValue[]
    return {
      reader: stmt.columns().length > 0,        // returns rows, incl. `returning`
      all: (p) => stmt.all(...args(p)),          // spread: node:sqlite binds varargs
      run: (p) => stmt.run(...args(p)),          // { changes, lastInsertRowid }
      iterate: (p) => stmt.iterate(...args(p)),
    }
  },
})

class ImmediateDriver extends SqliteDriver {
  override async beginTransaction(c: DatabaseConnection) {
    await c.executeQuery(CompiledQuery.raw("begin immediate"))
  }
}

export class KrunSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig
  constructor(db: DatabaseSync) {
    const config = { database: asKysely(db) }
    super(config)
    this.#config = config
  }
  override createDriver() { return new ImmediateDriver(this.#config) }
}
```

- The `Database` layer opens the file (`new DatabaseSync(path)`), runs the
  five pragmas with `db.exec`, then builds `new Kysely({ dialect: new
  KrunSqliteDialect(db) })`; release is `kysely.destroy()`, which calls
  `close()`.
- `reader` from `columns()` matches the interface: a statement returning
  rows goes through `all`, so `insert ... returning *` yields rows and a
  plain `update` yields `numAffectedRows`.
- Never pass Kysely's array straight through: a lone array argument is read
  as a named-parameter object (`Unknown named parameter '0'`).
- The parameter cast is the one unchecked spot. Values reaching it must
  already be `null`, `number`, `bigint`, `string` or `Uint8Array`;
  `undefined` and `Date` throw at bind time.
- Kysely prepares a statement per query. No statement cache until a
  benchmark asks for one.

### SQLite pragmas (SPEC.md:553-559, verbatim)

```
journal_mode = WAL
synchronous  = NORMAL
busy_timeout = 5000
foreign_keys = ON
auto_vacuum  = INCREMENTAL
```

- Apply with `db.exec('pragma journal_mode = WAL')` etc. right after
  opening the `node:sqlite` database, before `migrate()`; no `pragma()`
  helper exists. `db.prepare('pragma journal_mode').get()` returns
  `{ journal_mode: 'wal' }` for the P1.9 assertion (observed on Node
  24.22, UNVERIFIED on 26). WAL needs a file: an in-memory database
  reports `memory`, so the P1.9 test uses the temp-file database.
- `auto_vacuum` takes effect only on an empty database or after `vacuum`:
  set it before the first migration creates tables.
- `foreign_keys` is per connection, off by default. Without it `on delete
  cascade` in `sweep` is silently ignored.
- `busy_timeout` makes a plain write wait. It does not save a deferred
  transaction that upgrades to a write while another writer holds the
  lock; hence every Store transaction opens with `begin immediate`
  (docs/research/node-stack-facts.md:678-681).

## 3. `listStale` expressions (SPEC.md:523-527)

"Running runs whose later of `runtime_status.at` and `started_at` is
`< before`" (SPEC.md:513).

| Dialect | Expression |
|---|---|
| Postgres | `greatest((runtime_status->>'at')::timestamptz, started_at) < $before` |
| SQLite | `max(coalesce(json_extract(runtime_status,'$.at'), started_at), started_at) < $before` |

Postgres `greatest` ignores nulls. SQLite's scalar `max` returns null when
any argument is null, so the `coalesce` is mandatory; without it runs with
no runtime status are never returned (SPEC.md:525-527). Both run with
`where state = 'running' and function_name = $fn`. The SQLite comparison is
text against an RFC 3339 string, so `runtime_status.at` must use the same
fixed format as `started_at` (SPEC.md:394).

## 4. `countByState` / `listByState` literal predicate (SPEC.md:534-536)

Both planners match a partial index only when the query text repeats the
index predicate. One fragment, reused in both dialects:

```ts
export const activePredicate =
  sql`state in ('queued','scheduled','running','cancelling')`;
```

Never build it from bound parameters: `state in (${states})` binds
`$1..$4`, and the planner cannot prove they equal the predicate. For
`listByState` append `and state in (${sql.join(states.map(s =>
sql.lit(s)))})` only after validating each requested state against the
non-terminal set, so `sql.lit` never receives untrusted text. `sql.lit`
inlines, `sql.val` binds (`raw-builder/sql.d.ts:124, 279`, VERIFIED).
Acceptance: Postgres `explain` inside a transaction with `set local
enable_seqscan = off`, after seeding 5000 terminal + 50 active rows and
`analyze runs`, names `runs_active_idx` (PLAN.md:259-262).

## 5. `listRuns` cursor (SPEC.md:522-523, PLAN.md:275-283)

- Order `created_at desc, id desc` in both dialects (SPEC.md:236, 439).
- Cursor: base64url of `created_at|id` plus a hash of parent and filter
  (PLAN.md:277-278, docs/API.md:234-235). A mismatch or malformed token is
  `REQUEST_INVALID` at the gateway (SPEC.md:237-238); the Store only
  decodes.
- Comparison: row value `(created_at, id) < ($createdAt, $id)` in both
  dialects (SPEC.md:522-523). Kysely: `eb.refTuple('created_at', 'id')`
  with `eb.tuple(createdAt, id)` (`expression/expression-builder.d.ts:561`,
  VERIFIED to exist) or `sql\`(created_at, id) < (${a}, ${b})\``. SQLite
  supports row values since 3.15.
- Postgres `uuid` compares bytewise and UUIDv7 text compares the same way,
  so `id desc` ties agree across dialects (D9).

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
(SPEC.md:545-546): `subscribe` is a latency hint, not the correctness path.
Acceptance: a transition is observed within 2 s in both modes; SQLite never
re-emits a row (PLAN.md:293-294). Test clocks: SKILL.md "Contract suite".

## 7. Migration policy and `krun migrate` (SPEC.md:385-388, 1460-1465; PLAN.md:236-243)

- Runner: Kysely `Migrator` with `FileMigrationProvider`, one folder per
  dialect. Each migration exports `up(db)` running raw SQL through `sql`
  templates (PLAN.md:236-238). No `down`: krun is forward-only
  (SPEC.md:1460).
- Name migrations so string order is chronological: `0001_init.ts`,
  `0002_<topic>.ts`. `FileMigrationProvider` sorts by file name and
  `Migrator` refuses executed migrations that are missing or out of order
  ("corrupted migrations", `migration/migrator.js:500-508`, VERIFIED).
- Under Vitest the provider's own `import()` runs in Node, outside Vite's
  transform, so it loads the `.ts` migration through Node 26 type stripping
  (UNVERIFIED; check in P1.2). Keep migrations erasable-syntax only,
  importing nothing but `kysely`. Under `tsc` output it imports `.js`.
  Point `migrationFolder` at `import.meta.dirname`-relative paths. Keep
  both dialect folders free of non-migration files (the provider imports
  every file in the folder).
- `migrateToLatest()` never throws: check `result.error`
  (`migration/migrator.d.ts:61-66`, VERIFIED) and fail `migrate()` with a
  tagged error on it.
- Policy: expand/contract, each migration keeps the previous minor's code
  working, drops ship one minor later, `helm rollback` by one minor is
  supported (SPEC.md:1460-1462, docs/OPERATIONS.md:31-36).
- `krun migrate` diff rule (SPEC.md:1462-1465, PLAN.md:238-243): before
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
  warning is an Effect log line; exit 1 is a tagged failure of the main
  effect, never `process.exit`.

  `Migrator` itself throws "corrupted migrations" in the "some unknown"
  cases, because the executed list does not match the provider's. The diff
  must run first and decide, so the operator sees krun's message, not
  Kysely's.
- `krun migrate` reads only `KRUN_DB_MODE`, `KRUN_DB_DSN`, `KRUN_DB_PATH`
  (SPEC.md:1395-1396, 1220-1222); it runs as the chart's pre-upgrade hook in
  Postgres mode and as an init step in embedded mode (SPEC.md:1390-1392,
  1408-1412, docs/OPERATIONS.md:31-34). Never log the DSN (pino `redact`
  covers `dsn`, SPEC.md:1181-1186).
- Acceptance (PLAN.md:241-243): migrate up twice is idempotent on both
  dialects; one extra recorded migration yields exit 0 and the warning;
  extra plus pending yields exit 1. Simulate "extra" by inserting a row
  into `kysely_migration` in the test.

## 8. Things that are the same on purpose

Ids and timestamps from the application (SPEC.md:399-400); CAS on every
transition (SPEC.md:341-343); `run_events` content and delivery in the
same transaction (SPEC.md:344-356); `request_hash` computed once in shared
code; `toRun`/`toRunSummary` and `RunSummary` shared by `listRuns`, the
delivery payload, SSE and the gateway (SPEC.md:536-539). Rules: SKILL.md
rules 2-7, 16, 17.
