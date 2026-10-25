import { Effect, Layer } from "effect";
import { Database, DatabasePostgres, DatabaseSqlite } from "../runtime/database.js";
import { makeCreateRun } from "./create-run.js";
import { DatabaseError } from "./errors.js";
import { Store, type StoreShape } from "./index.js";
import { migrate } from "./migrations.js";
import { makeRunLeasing } from "./run-leasing.js";
import { makeRunMaintenance } from "./run-maintenance.js";
import { makeRunQueries } from "./run-queries.js";
import { makeRunReports } from "./run-reports.js";
import { makeListStale } from "./run-stale.js";
import { makeRunSubscriptions } from "./run-subscriptions.js";
import { makeTransition } from "./transition.js";

// D45: P1.11 completes the interface. Compose only the real implementations,
// all capturing this one scoped Database, including deferred migrate calls.
const makeStore: Effect.Effect<StoreShape, never, Database> = Effect.gen(function* () {
  const database = yield* Database;
  return {
    createRun: yield* makeCreateRun,
    ...(yield* makeRunQueries),
    ...(yield* makeRunLeasing),
    transition: yield* makeTransition,
    ...(yield* makeRunReports),
    ...(yield* makeRunMaintenance),
    listStale: yield* makeListStale,
    ...(yield* makeRunSubscriptions),
    migrate: () =>
      migrate.pipe(
        Effect.provideService(Database, database),
        // The CLI retains its specific history diagnostic. Store declares only
        // DatabaseError and must not expose another error or migration details.
        Effect.mapError((error) =>
          error instanceof DatabaseError ? error : new DatabaseError({ operation: "migrate" }),
        ),
        Effect.withSpan("store.migrate", {
          kind: "client",
          attributes: { "db.operation.name": "migrate", "db.response.returned_rows": 0 },
        }),
      ),
  } satisfies StoreShape;
});

export const StoreLive = Layer.effect(Store, makeStore);
export const StorePostgres = (dsn: string) => StoreLive.pipe(Layer.provide(DatabasePostgres(dsn)));
export const StoreSqlite = (path: string) => StoreLive.pipe(Layer.provide(DatabaseSqlite(path)));
