import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { afterEach, beforeEach } from "vitest";
import { Database, DatabaseSqlite } from "../../runtime/database.js";

let directory: string;
let databasePath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "krun-test-dialect-"));
  databasePath = join(directory, "krun.db");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.effect("initializes every pragma before tables and supports current SQLite RETURNING", () =>
  Effect.gen(function* () {
    const { db } = yield* Database;
    const rows = yield* Effect.promise(async () => ({
      journal: (await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db)).rows,
      synchronous: (await sql<{ synchronous: number }>`pragma synchronous`.execute(db)).rows,
      busy: (await sql<{ timeout: number }>`pragma busy_timeout`.execute(db)).rows,
      foreignKeys: (await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(db)).rows,
      vacuum: (await sql<{ auto_vacuum: number }>`pragma auto_vacuum`.execute(db)).rows,
      version: (await sql<{ version: string }>`select sqlite_version() as version`.execute(db))
        .rows,
    }));
    expect(rows.journal).toEqual([{ journal_mode: "wal" }]);
    expect(rows.synchronous).toEqual([{ synchronous: 1 }]);
    expect(rows.busy).toEqual([{ timeout: 5000 }]);
    expect(rows.foreignKeys).toEqual([{ foreign_keys: 1 }]);
    expect(rows.vacuum).toEqual([{ auto_vacuum: 2 }]);
    const [major = 0, minor = 0] = (rows.version[0]?.version ?? "").split(".").map(Number);
    expect(major > 3 || (major === 3 && minor >= 35)).toBe(true);
    expect(db.getExecutor().adapter.supportsMultipleConnections).toBe(false);
    expect(db.getExecutor().adapter.supportsTransactionalDdl).toBe(true);
  }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect(
  "spreads bound values and distinguishes readers, RETURNING and affected-row results",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database;
      yield* Effect.promise(async () => {
        const bound = await sql<{
          text: string;
          n: number;
          empty: null;
          bytes: Uint8Array;
        }>`select ${"O'Reilly"} as text, ${42} as n, ${null} as empty, ${new Uint8Array([1, 2])} as bytes`.execute(
          db,
        );
        expect(bound.rows[0]).toEqual({
          text: "O'Reilly",
          n: 42,
          empty: null,
          bytes: new Uint8Array([1, 2]),
        });
        await sql`create table probe (value text)`.execute(db);
        expect((await sql`insert into probe values (${"one"})`.execute(db)).numAffectedRows).toBe(
          1n,
        );
        expect(
          (
            await sql<{
              value: string;
            }>`insert into probe values (${"two"}) returning value`.execute(db)
          ).rows,
        ).toEqual([{ value: "two" }]);
        const streamed: string[] = [];
        for await (const row of db
          .selectFrom(sql<{ value: string }>`probe`.as("p"))
          .select("value")
          .orderBy("value")
          .stream())
          streamed.push(row.value);
        expect(streamed).toEqual(["one", "two"]);
        await expect(sql`select ${undefined}`.execute(db)).rejects.toThrow(
          "Unsupported SQLite parameter",
        );
      });
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect("rolls back an ordinary transaction without retaining a writer lock", () =>
  Effect.gen(function* () {
    const { db } = yield* Database;
    yield* Effect.promise(async () => {
      await sql`create table probe (value text)`.execute(db);
      await expect(
        db.transaction().execute(async (transaction) => {
          await sql`insert into probe values (${"rolled back"})`.execute(transaction);
          throw new Error("test rollback");
        }),
      ).rejects.toThrow("test rollback");
      expect((await sql`select * from probe`.execute(db)).rows).toEqual([]);
      await db
        .transaction()
        .execute((transaction) =>
          sql`insert into probe values (${"committed"})`.execute(transaction),
        );
      expect((await sql`select * from probe`.execute(db)).rows).toEqual([{ value: "committed" }]);
    });
  }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect("closes the database when use fails", () =>
  Effect.gen(function* () {
    let captured: Kysely<unknown> | undefined;
    const failed = Effect.gen(function* () {
      captured = (yield* Database).db;
      return yield* Effect.fail("expected test failure");
    }).pipe(Effect.provide(DatabaseSqlite(databasePath)));
    expect(yield* Effect.flip(failed)).toBe("expected test failure");
    yield* Effect.promise(async () => {
      if (captured === undefined) throw new Error("database was not acquired");
      await expect(sql`select 1`.execute(captured)).rejects.toThrow("destroyed");
    });
  }),
);

it.effect("closes the database when an idle consumer is interrupted", () =>
  Effect.gen(function* () {
    let captured: Kysely<unknown> | undefined;
    const entered = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        captured = (yield* Database).db;
        yield* Deferred.succeed(entered, undefined);
        yield* Effect.never;
      }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    yield* Effect.promise(async () => {
      if (captured === undefined) throw new Error("database was not acquired");
      await expect(sql`select 1`.execute(captured)).rejects.toThrow("destroyed");
    });
  }),
);

it.effect("sanitizes an acquisition failure without opening an ambient database", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Effect.void.pipe(Effect.provide(DatabaseSqlite(join(directory, "missing", "krun.db")))),
    );
    expect(error._tag).toBe("DatabaseError");
    expect(error.operation).toBe("open");
    expect(error.message).not.toContain(directory);
  }),
);

// A deferred BEGIN also passes a contention check after its first write. Probe
// before any transaction-body SQL so only eager writer reservation passes.
const expectWriterBusy = (competitor: DatabaseSync) => {
  let failure: unknown;
  try {
    competitor.exec("begin immediate");
    competitor.exec("rollback");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
};

it.effect(
  "P1.9 reserves the writer before any transaction-body SQL while WAL readers proceed",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Database;
      yield* Effect.promise(async () => {
        await sql`create table probe (value text)`.execute(db);
        await sql`insert into probe values (${"committed"})`.execute(db);
        const competitor = new DatabaseSync(databasePath);
        try {
          competitor.exec("pragma busy_timeout = 0");
          expect(competitor.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
          await db.transaction().execute(async (transaction) => {
            expectWriterBusy(competitor);
            expect(competitor.prepare("select value from probe").all()).toEqual([
              { value: "committed" },
            ]);
            await sql`insert into probe values (${"new"})`.execute(transaction);
            expect(competitor.prepare("select value from probe").all()).toEqual([
              { value: "committed" },
            ]);
          });
          competitor.exec("begin immediate");
          competitor.exec("rollback");
          expect(competitor.prepare("select value from probe order by value").all()).toEqual([
            { value: "committed" },
            { value: "new" },
          ]);
        } finally {
          competitor.close();
        }
      });
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect("P1.9 rollback releases the native writer lock and discards uncommitted rows", () =>
  Effect.gen(function* () {
    const { db } = yield* Database;
    yield* Effect.promise(async () => {
      await sql`create table probe (value text)`.execute(db);
      const competitor = new DatabaseSync(databasePath);
      try {
        competitor.exec("pragma busy_timeout = 0");
        await expect(
          db.transaction().execute(async (transaction) => {
            expectWriterBusy(competitor);
            await sql`insert into probe values (${"uncommitted"})`.execute(transaction);
            expect(competitor.prepare("select * from probe").all()).toEqual([]);
            throw new Error("P1.9 rollback sentinel");
          }),
        ).rejects.toThrow("P1.9 rollback sentinel");
        competitor.exec("begin immediate");
        competitor.exec("insert into probe values ('native writer')");
        competitor.exec("commit");
        expect((await sql`select value from probe`.execute(db)).rows).toEqual([
          { value: "native writer" },
        ]);
      } finally {
        competitor.close();
      }
    });
  }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect("P1.9 concurrent borrowers reuse one serialized physical connection", () =>
  Effect.gen(function* () {
    const { db } = yield* Database;
    yield* Effect.promise(async () => {
      await sql`create temp table connection_probe (value text)`.execute(db);
      let active = 0;
      const connections = await Promise.all(
        ["a", "b", "c", "d"].map((value) =>
          db.getExecutor().provideConnection(async (connection) => {
            active += 1;
            try {
              expect(active).toBe(1);
              await connection.executeQuery(
                CompiledQuery.raw("insert into connection_probe values (?)", [value]),
              );
              return connection;
            } finally {
              active -= 1;
            }
          }),
        ),
      );
      expect(new Set(connections).size).toBe(1);
      expect((await sql`select count(*) as n from connection_probe`.execute(db)).rows).toEqual([
        { n: 4 },
      ]);
    });
  }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
);

it.effect("P1.9 reapplies connection-local pragmas when the file is reopened", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { db } = yield* Database;
      yield* Effect.promise(async () => {
        await sql`create table persisted_probe (value text)`.execute(db);
        await sql`pragma synchronous = OFF`.execute(db);
        await sql`pragma busy_timeout = 0`.execute(db);
        await sql`pragma foreign_keys = OFF`.execute(db);
      });
    }).pipe(Effect.provide(DatabaseSqlite(databasePath)));
    yield* Effect.gen(function* () {
      const { db } = yield* Database;
      yield* Effect.promise(async () => {
        expect((await sql`pragma synchronous`.execute(db)).rows).toEqual([{ synchronous: 1 }]);
        expect((await sql`pragma busy_timeout`.execute(db)).rows).toEqual([{ timeout: 5000 }]);
        expect((await sql`pragma foreign_keys`.execute(db)).rows).toEqual([{ foreign_keys: 1 }]);
        expect((await sql`pragma journal_mode`.execute(db)).rows).toEqual([
          { journal_mode: "wal" },
        ]);
        expect((await sql`pragma auto_vacuum`.execute(db)).rows).toEqual([{ auto_vacuum: 2 }]);
        expect((await sql`select * from persisted_probe`.execute(db)).rows).toEqual([]);
      });
    }).pipe(Effect.provide(DatabaseSqlite(databasePath)));
  }),
);
