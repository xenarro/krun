import { Context, Effect, Layer } from "effect";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { DatabaseError } from "../store/errors.js";
import { KrunSqliteDialect } from "../store/sqlite/dialect.js";

// Migration SQL is schema-independent. Typed Store implementations can narrow
// the database at their dialect boundary without making migrations know rows.
export class Database extends Context.Service<
  Database,
  { readonly db: Kysely<unknown>; readonly dialect: "postgres" | "sqlite" }
>()("krun/Database") {}

const databaseLayer = (dialect: "postgres" | "sqlite", create: () => Kysely<unknown>) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({ try: create, catch: () => new DatabaseError({ operation: "open" }) }),
        (database) =>
          Effect.tryPromise({
            try: () => database.destroy(),
            catch: () => new DatabaseError({ operation: "close" }),
          }).pipe(Effect.orDie),
      );
      // Force lazy driver initialization after the finalizer is registered.
      yield* Effect.tryPromise({
        try: () => sql`select 1`.execute(db),
        catch: () => new DatabaseError({ operation: "open" }),
      });
      return { db, dialect };
    }),
  );

export const DatabaseSqlite = (path: string) =>
  databaseLayer("sqlite", () => new Kysely<unknown>({ dialect: new KrunSqliteDialect(path) }));

export const DatabasePostgres = (dsn: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const context = yield* Effect.context();
      return databaseLayer(
        "postgres",
        () =>
          new Kysely<unknown>({
            dialect: new PostgresDialect({
              pool: async () => {
                const pool = new Pool({
                  connectionString: dsn,
                  max: 5,
                  query_timeout: 10000,
                  connectionTimeoutMillis: 10000,
                });
                // pg removes failed idle clients itself. Own the error event so it cannot
                // crash the process, and never retain/log its raw connection error.
                pool.on("error", () =>
                  Effect.runSyncWith(context)(Effect.logWarning("Database idle connection failed")),
                );
                return pool;
              },
            }),
          }),
      );
    }),
  );
