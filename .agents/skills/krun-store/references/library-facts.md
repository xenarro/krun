# Library facts and prior art for the Store

From docs/research/node-stack-facts.md. VERIFIED means checked against the
unpacked tarball under `~/.hermes/cache/scratch/krun-skills/pkgs/`
(`pkgs/kysely-0.29.7/package/dist` for Kysely). The adapter sketch built on
these facts: `dialect-differences.md` section 2.

## Kysely 0.29.7

VERIFIED from `pkgs/kysely-0.29.7/package/dist` (the tarball's `dist/`).

- `SqliteDriver.beginTransaction(connection)` runs
  `CompiledQuery.raw('begin')` (`dist/dialect/sqlite/sqlite-driver.js:26-28`).
  Override: `class ImmediateSqliteDriver extends SqliteDriver {
  async beginTransaction(connection) { await connection.executeQuery(
  CompiledQuery.raw('begin immediate')) } }` and a `Dialect` whose
  `createDriver()` returns it. `SqliteDialect`'s `createQueryCompiler`,
  `createAdapter`, `createIntrospector` can be reused. `SqliteDialect`
  keeps its config in a private field, so the krun subclass keeps its own
  copy (`sqlite-dialect.js`).
- `SqliteAdapter.supportsMultipleConnections` is false, so the runtime
  driver wraps every `acquireConnection` in a `ConnectionMutex`
  (`dist/driver/runtime-driver.js:22-24`, `driver/runtime-driver.js:22-24, 49-51`): Store calls serialise per
  process. Open no second `node:sqlite` connection in the Store; the P1.9
  test opens one only to prove `SQLITE_BUSY` (PLAN.md:302-306).
- `SqliteAdapter.acquireMigrationLock` is a no-op (single connection); the
  Postgres adapter takes a real lock (`dialect/sqlite/sqlite-adapter.js:13-20`).
- `SqliteDialectConfig.database` is a `SqliteDatabase` (`close()`,
  `prepare(sql)`). Its `SqliteStatement` has `readonly reader: boolean`,
  `all(params)`, `run(params)` returning `{ changes, lastInsertRowid }`,
  and `iterate(params)`, each called with the parameter array as one
  argument (`dist/dialect/sqlite/sqlite-dialect-config.d.ts:40-52`,
  `sqlite-driver.js:56-80`). `SqliteConnection.executeQuery` calls
  `stmt.all(parameters)` when `reader`, else `stmt.run(parameters)`
  (`sqlite-driver.js:56-69`). The interface was written for a different
  driver, so `node:sqlite` needs an adapter.
- `migrateToLatest()` never throws: read `error` from the result
  (`dist/migration/migrator.d.ts:61-66`, VERIFIED) and turn it into a
  tagged failure. `getMigrations()` returns name + `executedAt` sorted by
  name (VERIFIED). Out-of-order or missing executed migrations throw
  "corrupted migrations" (`dist/migration/migrator.js:500-508`, VERIFIED),
  so run the `krun migrate` diff before the migrator.
- `sql.lit` inlines, `sql.val` binds (`dist/raw-builder/sql.d.ts:124,
  279`, VERIFIED). `eb.refTuple`/`eb.tuple` exist for row-value comparison
  (`dist/expression/expression-builder.d.ts:561`, VERIFIED).

## `node:sqlite`

Built in; release candidate in Node 26 (D36). Observed on Node 24.22.0
with Kysely 0.29.7; UNVERIFIED on Node 26 until the P1.9 test runs there.

- Statements have `run`, `get`, `all`, `iterate`, `columns`.
- Parameters are spread (`stmt.all(...params)`). An array passed as the
  single argument is read as a named-parameter object and fails `Unknown
  named parameter '0'`, so the adapter spreads.
- `reader` is `stmt.columns().length > 0`: an `insert ... returning` has
  columns, a plain `insert` has none.
- Rows have a null prototype. `undefined` and `Date` cannot be bound
  (`ERR_INVALID_ARG_TYPE`). Booleans bind as 1/0. Integers read as JS
  numbers.
- No `db.pragma()` helper: use `db.exec('pragma ...')` and
  `db.prepare('pragma journal_mode').get()` (returns `{ journal_mode:
  'wal' }`).
- Node 24.22 bundles SQLite 3.53.4. Node 26's bundled version is
  UNVERIFIED (`select sqlite_version()` in P1.9; `returning` needs 3.35+).
- Node 24.22 exports the class as `DatabaseSync`; docs/STACK.md 2.3 names
  it `Database`. The Node 26 export name is UNVERIFIED: check
  `Object.keys(await import('node:sqlite'))` before writing the adapter.
- Result codes are on `errcode` (5 = `SQLITE_BUSY`); `code` is always the
  generic `ERR_SQLITE_ERROR`.

## Effect

- `Effect.tryPromise({ try, catch })` maps a rejection to the `catch`
  result. The `try` callback receives an `AbortSignal` that fires on
  interruption, but `pg` and `node:sqlite` cannot cancel a running query
  with it: an interrupted write may still commit. `node:sqlite` is
  synchronous, so a slow statement also blocks the event loop.

## pg 8.23.1

- Use a dedicated `Client` for `LISTEN`. On `error`/`end` create a new
  `Client` (a Client cannot reconnect), `connect()`, re-`LISTEN`, and rely
  on the 1 s poll fallback for the gap. Payload limit 8000 bytes. `NOTIFY`
  in a transaction is delivered on commit
  (docs/research/node-stack-facts.md:688-694, UNVERIFIED API detail).
- pg parses `timestamptz` into a JS `Date`. Convert it to `DateTime.Utc`
  in the dialect mapper. A driver-built `Date` is fine; building one in
  krun code is not.

## uuid 14, canonicalize 5.1

- `import { v7 } from 'uuid'`; `v7({ msecs })` with the time from `Clock`
  (docs/STACK.md 2.5). UNVERIFIED: whether explicit `msecs` keeps the
  within-millisecond monotonic sequence. The `listRuns` cursor is
  `(created_at, id)`, so order stays stable either way. Use `uuid` even if
  Node offers a built-in v7: only `msecs` from `Clock` keeps ids
  deterministic under `TestClock`.
- canonicalize: one function from an object to its RFC 8785 string. Its
  default-export shape under `nodenext` ESM is UNVERIFIED; check once.
- No store dependency has an install or build script (`pg`, `kysely`,
  `uuid`, `canonicalize` are plain JavaScript; SQLite is built into Node).
  The store needs no pnpm build approval and the image no compiler.

## Prior art: Dapr and KEDA

Lesson, then the krun rule (SKILL.md rule number or SPEC line).

- Dapr's outbox is publish-then-commit with a consumer-side marker check:
  a 1 s scan delay, backoff 500 ms to 3 s for up to 10 s, and a "missing
  marker" ambiguity (`dapr pkg/runtime/pubsub/outbox.go:42, 148-158,
  307-342`). krun inserts the delivery in the terminal transaction, which
  removes all three (dapr.md:277-297, SPEC.md:348-351): Rule 3.
- Mark a delivery `delivered` or `dead` in its own statement after the HTTP
  result, never inside the terminal transaction, like Dapr's "delete the
  marker after successful publish" (`outbox.go:364-373`).
- The database is the dead-letter queue: after the sixth failure the row
  becomes `dead` with `last_error`, never deleted (dapr
  `pkg/runtime/subscription/subscription.go:407-457`; SPEC.md:925-927).
- Never mark a delivery `dead` because of shutdown. Leave it `pending` with
  its `next_at`, so the next leader retries (dapr `subscription.go:394-405`).
- Retry budgets are bounded and explicit: Dapr refuses unbounded policies
  and floors overrides at 3 retries (`pkg/resiliency/resiliency.go:370-459`).
  krun's six attempts on a fixed schedule live in the scheduler; the Store
  only persists `attempt` and `next_at` (SPEC.md:516, 925-927).
- A failed read is not zero. KEDA's `getRunningJobCount` returns 0 on a
  List error and can over-create Jobs (`keda pkg/scaling/scale_jobs.go:251-253`,
  keda.md:34-36, 351). `countByState`, `countQueued`, `countQueuedBy` must
  fail with `DatabaseError`, never succeed with an empty map or 0 (no
  `Effect.orElseSucceed` in the Store); callers skip the tick: Rule 20.
- KEDA ScaledJob scales from a scaler's queue depth; krun claims from SQL
  with a lease and creates exactly one Job per run. Scaling by metrics and
  Dapr-style pub/sub are non-goals (SPEC.md:19-24); import neither.
