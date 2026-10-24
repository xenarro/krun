import { promises as fs } from "node:fs";
import path from "node:path";
import { Data, Effect } from "effect";
import { sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";

export class MigrationHistoryError extends Data.TaggedError("MigrationHistoryError") {
  override get message(): string {
    return "Database contains unknown migrations while this binary has pending migrations";
  }
}

export const migrationProvider = (dialect: "postgres" | "sqlite") =>
  new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(import.meta.dirname, "migrations", dialect),
  });

export const migrate = Effect.gen(function* () {
  const { db, dialect } = yield* Database;
  const state = yield* Effect.tryPromise({
    try: async () => {
      const migrations = await migrationProvider(dialect).getMigrations();
      let migrationTableSchema: string | undefined;
      if (dialect === "postgres") {
        const schema = (
          await sql<{ schema: string | null }>`select current_schema() as schema`.execute(db)
        ).rows[0]?.schema;
        if (typeof schema !== "string") throw new Error("No migration schema available");
        migrationTableSchema = schema;
      }
      const tables = await db.introspection.getTables({ withInternalKyselyTables: true });
      // Match the schema where this connection creates application tables.
      // Introspection also returns unrelated schemas with identically named tables.
      const tableExists = tables.some(
        (table) =>
          table.name === "kysely_migration" &&
          (migrationTableSchema === undefined || table.schema === migrationTableSchema),
      );
      const historyTable =
        migrationTableSchema === undefined
          ? sql.id("kysely_migration")
          : sql.id(migrationTableSchema, "kysely_migration");
      // A missing table is the sole empty-history case. Permission, query and
      // corrupt-table errors must fail closed rather than resetting history.
      const applied = tableExists
        ? (await sql<{ name: string }>`select name from ${historyTable}`.execute(db)).rows.map(
            (row) => row.name,
          )
        : [];
      const known = Object.keys(migrations);
      return {
        migrations,
        migrationTableSchema,
        unknown: applied.some((name) => !Object.hasOwn(migrations, name)),
        pending: known.some((name) => !applied.includes(name)),
      };
    },
    catch: () => new DatabaseError({ operation: "migration-history" }),
  });
  if (state.unknown) {
    if (state.pending) return yield* Effect.fail(new MigrationHistoryError());
    // Names stored in the database are untrusted; do not put them in logs.
    yield* Effect.logWarning("Database contains unknown migrations; no migrations are pending");
    return;
  }
  const failed = yield* Effect.tryPromise({
    try: async () => {
      const result = await new Migrator({
        db,
        ...(state.migrationTableSchema === undefined
          ? {}
          : { migrationTableSchema: state.migrationTableSchema }),
        provider: { getMigrations: async () => state.migrations },
      }).migrateToLatest();
      return (
        result.error !== undefined ||
        result.results?.some((item) => item.status !== "Success") === true
      );
    },
    catch: () => new DatabaseError({ operation: "migrate" }),
  });
  if (failed) return yield* Effect.fail(new DatabaseError({ operation: "migrate" }));
  // Driver promises are not cancelled by Effect interruption. Finish migration
  // and lock release before allowing the enclosing database scope to close.
}).pipe(Effect.uninterruptible);
