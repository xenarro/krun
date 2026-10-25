import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { decodeRun } from "./rows.js";

export const makeListStale = Effect.map(Database, ({ db, dialect }): StoreShape["listStale"] => {
  // SQLite scalar max returns null on any null argument: a missing status
  // must fall back to started_at before taking the later timestamp.
  const heartbeat =
    dialect === "postgres"
      ? sql`greatest((runtime_status->>'at')::timestamptz, started_at)`
      : sql`max(coalesce(json_extract(runtime_status,'$.at'), started_at), started_at)`;
  return (fn, before) =>
    Effect.gen(function* () {
      const rows = yield* Effect.tryPromise({
        try: async () =>
          (
            await sql`select * from runs where function_name=${fn} and state='running'
              and ${heartbeat} < ${DateTime.formatIso(before)}`.execute(db)
          ).rows.map((row) => decodeRun(row, dialect)),
        catch: () => new DatabaseError({ operation: "listStale" }),
      });
      yield* Effect.annotateCurrentSpan("db.response.returned_rows", rows.length);
      return rows;
    }).pipe(
      // As with other Store reads, settle the driver before its scope closes.
      Effect.uninterruptible,
      Effect.withSpan("store.listStale", {
        kind: "client",
        attributes: { "db.operation.name": "listStale", "db.response.returned_rows": 0 },
      }),
    );
});
