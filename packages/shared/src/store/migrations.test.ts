import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterEach, beforeEach } from "vitest";
import { Database, DatabaseSqlite } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import * as postgresInit from "./migrations/postgres/0001_init.js";
import * as sqliteInit from "./migrations/sqlite/0001_init.js";
import * as sqliteEventRowid from "./migrations/sqlite/0002_event_rowid.js";
import { MigrationHistoryError, migrate, migrationProvider } from "./migrations.js";

let directory: string;
let databasePath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "krun-test-migrations-"));
  databasePath = join(directory, "krun.db");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const query = <A>(run: (database: (typeof Database)["Service"]["db"]) => Promise<A>) =>
  Effect.flatMap(Database, ({ db }) => Effect.promise(() => run(db)));
const history = query(
  async (db) =>
    (
      await sql<{
        name: string;
        timestamp: string;
      }>`select * from kysely_migration order by name`.execute(db)
    ).rows,
);
const recordUnknown = query((db) =>
  sql`insert into kysely_migration (name, timestamp) values (${"9999_future"}, ${"2026-10-24T00:00:00.000Z"})`.execute(
    db,
  ),
);
const emptyHistory = query((db) =>
  new Migrator({ db, provider: { getMigrations: async () => ({}) } }).migrateToLatest(),
);

// This is a real SQLite migration-core suite, not Postgres/CLI acceptance.
// Postgres must run the same policy through the approved pg/Testcontainers path.
describe("migration preparation", () => {
  it("discovers matching forward-only migration files for both dialects", async () => {
    expect(Object.keys(sqliteEventRowid)).toEqual(["up"]);
    expect(sqliteEventRowid.up).toBeTypeOf("function");
    for (const [dialect, module] of [
      ["postgres", postgresInit],
      ["sqlite", sqliteInit],
    ] as const) {
      const migrations = await migrationProvider(dialect).getMigrations();
      expect(Object.keys(migrations)).toEqual(
        dialect === "sqlite"
          ? ["0001_init", "0002_event_rowid"]
          : ["0001_init", "0002_opaque_unicode"],
      );
      for (const migration of Object.values(migrations)) {
        expect(migration.up).toBeTypeOf("function");
        expect(migration.down).toBeUndefined();
      }
      expect(Object.keys(module)).toEqual(["up"]);
      expect(migrations["0001_init"]?.up).toBeTypeOf("function");
      expect(migrations["0001_init"]?.down).toBeUndefined();
    }
  });

  it.effect("migrates an empty file twice without rewriting history or application data", () =>
    Effect.gen(function* () {
      yield* migrate;
      const first = yield* history;
      expect(first.map((row) => row.name)).toEqual(["0001_init", "0002_event_rowid"]);
      yield* query((db) =>
        sql`insert into runs (id, request_hash, function_name, input, state, created_by, created_at)
        values (${"run-one"}, ${"hash"}, ${"hello"}, ${"{}"}, ${"queued"}, ${"tester"}, ${"2026-10-24T00:00:00.000Z"})`.execute(
          db,
        ),
      );
      yield* migrate;
      expect(yield* history).toEqual(first);
      const rows = yield* query((db) =>
        sql<{
          id: string;
          priority: number;
          attempt: number;
        }>`select id, priority, attempt from runs`.execute(db),
      );
      expect(rows.rows).toEqual([{ id: "run-one", priority: 0, attempt: 0 }]);
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
  );

  it.effect("creates all canonical columns, indexes and cascade relationships", () =>
    Effect.gen(function* () {
      yield* migrate;
      const metadata = yield* query((db) => db.introspection.getTables());
      expect(metadata.map((table) => table.name).sort()).toEqual([
        "deliveries",
        "run_events",
        "runs",
      ]);
      expect(
        Object.fromEntries(metadata.map((table) => [table.name, table.columns.length])),
      ).toEqual({ runs: 25, run_events: 7, deliveries: 9 });
      const indexes = yield* query((db) =>
        sql<{
          name: string;
        }>`select name from sqlite_master where type = 'index' and name not like 'sqlite_%' and name not like 'kysely_%' order by name`.execute(
          db,
        ),
      );
      expect(indexes.rows.map((row) => row.name)).toEqual([
        "deliveries_due_idx",
        "deliveries_run_idx",
        "run_events_run_idx",
        "runs_active_idx",
        "runs_created_idx",
        "runs_finished_idx",
        "runs_function_idx",
        "runs_idem_idx",
        "runs_owner_idx",
        "runs_queue_idx",
      ]);
      for (const table of ["run_events", "deliveries"]) {
        const foreignKeys = yield* query((db) =>
          sql<{
            table: string;
            on_delete: string;
          }>`select * from pragma_foreign_key_list(${table})`.execute(db),
        );
        expect(foreignKeys.rows.map((key) => [key.table, key.on_delete])).toEqual([
          ["runs", "CASCADE"],
        ]);
      }
      const defaults = yield* query((db) =>
        sql<{
          name: string;
          dflt_value: string | null;
        }>`select name, dflt_value from pragma_table_info('runs') where name like '%_at'`.execute(
          db,
        ),
      );
      expect(defaults.rows).toHaveLength(4);
      expect(defaults.rows.every((column) => column.dflt_value === null)).toBe(true);
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
  );

  it.effect(
    "warns and leaves all history untouched when unknown names have nothing pending",
    () => {
      const warnings: unknown[] = [];
      return Effect.gen(function* () {
        yield* migrate;
        yield* recordUnknown;
        const before = yield* history;
        yield* migrate;
        expect(yield* history).toEqual(before);
        expect(warnings).toHaveLength(1);
        expect(JSON.stringify(warnings)).toContain("unknown");
        expect(JSON.stringify(warnings)).not.toContain("9999_future");
      }).pipe(
        Effect.provide(DatabaseSqlite(databasePath)),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make((options) => {
              warnings.push(options.message);
            }),
          ]),
        ),
      );
    },
  );

  it.effect("rejects unknown plus pending before any application migration runs", () =>
    Effect.gen(function* () {
      expect((yield* emptyHistory).error).toBeUndefined();
      yield* recordUnknown;
      const before = yield* history;
      const error = yield* Effect.flip(migrate);
      expect(error).toBeInstanceOf(MigrationHistoryError);
      expect(yield* history).toEqual(before);
      expect(yield* query((db) => db.introspection.getTables())).toEqual([]);
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
  );

  it.effect("checks resolved Migrator errors, rolls back DDL and sanitizes diagnostics", () =>
    Effect.gen(function* () {
      yield* query((db) => sql`create table deliveries (sentinel text)`.execute(db));
      const error = yield* Effect.flip(migrate);
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error.message).toBe("Database operation failed");
      expect(JSON.stringify(error)).not.toContain("sentinel");
      expect(
        (yield* query((db) => db.introspection.getTables())).map((table) => table.name),
      ).toEqual(["deliveries"]);
      expect(yield* history).toEqual([]);
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
  );

  it.effect("does not reinterpret a malformed migration table as an empty history", () =>
    Effect.gen(function* () {
      yield* query((db) => sql`create table kysely_migration (wrong text)`.execute(db));
      expect(yield* Effect.flip(migrate)).toBeInstanceOf(DatabaseError);
      expect(yield* query((db) => db.introspection.getTables())).toEqual([]);
    }).pipe(Effect.provide(DatabaseSqlite(databasePath))),
  );
});
