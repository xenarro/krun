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
      ? sql`started_at`
      : sql`max(coalesce(json_extract(runtime_status,'$.at'), started_at), started_at)`;
  return (fn, before) =>
    Effect.gen(function* () {
      const rows = yield* Effect.tryPromise({
        try: async () =>
          (
            await sql`select * from runs where function_name=${fn} and state='running'
              and ${heartbeat} < ${DateTime.formatIso(before)}
              ${dialect === "postgres" ? sql`and (runtime_status_at is null or runtime_status_at < ${DateTime.formatIso(before)})` : sql``}`.execute(
              db,
            )
          ).rows
            .map((row) => decodeRun(row, dialect))
            .filter((row) => {
              // Null projections include old writers. Decode with the same
              // identity-preserving JSON boundary as getRun; PG text extraction
              // rejects opaque NUL/surrogates even in unrelated report fields.
              if (dialect !== "postgres") return true;
              const latest = Math.max(
                row.started_at === null ? -Infinity : DateTime.toEpochMillis(row.started_at),
                row.runtime_status === null
                  ? -Infinity
                  : DateTime.toEpochMillis(row.runtime_status.at),
              );
              return latest < DateTime.toEpochMillis(before);
            }),
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
