import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { z } from "zod";
import { Database } from "../runtime/database.js";
import { InternalStoreSignal, internalStoreCall } from "../runtime/internal-store-call.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { decodeRun } from "./rows.js";

type Methods = Pick<StoreShape, "setRuntimeStatus" | "setResult" | "setError" | "setJobStatus">;
type ReportMethod = Exclude<keyof Methods, "setJobStatus">;
const json = z.json();
const inlineResult = json.refine((value) => value !== null);
const encode = (value: unknown, result = false) => {
  // Validate without rebuilding opaque JSON objects: parsing into a record can
  // discard an own __proto__ key. Never silently turn NaN/undefined into null.
  (result ? inlineResult : json).parse(value);
  return JSON.stringify(value);
};
const adapter = (operation: keyof Methods, execute: () => Promise<boolean>) =>
  Effect.gen(function* () {
    const signal = yield* InternalStoreSignal;
    const changed = yield* Effect.tryPromise({
      try: () => internalStoreCall(signal, execute),
      catch: () => new DatabaseError({ operation }),
    });
    yield* Effect.annotateCurrentSpan("db.response.returned_rows", changed ? 1 : 0);
    return changed;
  });
const traced = (
  operation: keyof Methods,
  id: string,
  body: Effect.Effect<boolean, DatabaseError>,
) =>
  body.pipe(
    // Driver promises cannot be cancelled safely. Settle commit/rollback and
    // connection release before interruption can close the Database scope.
    Effect.uninterruptible,
    Effect.withSpan(`store.${operation}`, {
      kind: "client",
      attributes: {
        "db.operation.name": operation,
        "db.response.returned_rows": 0,
        "krun.run_id": id,
      },
    }),
  );

// D45: only real declared methods; full Store assembly follows the final slice.
export const makeRunReports = Effect.map(Database, ({ db, dialect }): Methods => {
  const report = (
    operation: ReportMethod,
    id: string,
    column: "runtime_status" | "result" | "error",
    value: () => unknown,
    at?: DateTime.Utc,
  ) =>
    traced(
      operation,
      id,
      adapter(operation, () =>
        db.transaction().execute(async (tx) => {
          const encoded = encode(value(), operation === "setResult");
          const updated = (
            await sql`update runs set ${sql.ref(column)}=${encoded}
              where id=${id} and (state in ('scheduled','running')
                or (state='queued' and job_token_hash is not null)) returning *`.execute(tx)
          ).rows[0];
          if (updated === undefined) return false;
          decodeRun(updated, dialect);
          if (dialect === "postgres" && operation === "setRuntimeStatus") {
            // The status trigger invalidates every replacement, even legacy
            // writers. Publish this writer's projection before commit, under
            // the row lock already held by the guarded UPDATE.
            await sql`update runs set runtime_status_at=${at === undefined ? null : DateTime.formatIso(at)} where id=${id}`.execute(
              tx,
            );
            await sql`select pg_notify('krun_runs',${`${id}:status`})`.execute(tx);
          }
          // Reports do not change lifecycle state, append events or deliver a
          // callback. setError replaces a previous report; transition's coalesce
          // preserves this function report against a later infrastructure error.
          return true;
        }),
      ),
    );
  return {
    setRuntimeStatus: (id, status) =>
      report(
        "setRuntimeStatus",
        id,
        "runtime_status",
        () => ({
          ...status,
          at: DateTime.formatIso(status.at),
        }),
        status.at,
      ),
    setResult: (id, result) => report("setResult", id, "result", () => result),
    setError: (id, error) =>
      report("setError", id, "error", () => ({ ...error, source: "function" })),
    setJobStatus: (id, status) =>
      traced(
        "setJobStatus",
        id,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* adapter("setJobStatus", () =>
            db.transaction().execute(async (tx) => {
              const encoded = encode({
                ...status,
                observedAt: DateTime.formatIso(status.observedAt),
              });
              // JobStatus's non-time fields are flat scalars. SQLite compares
              // key/value/type sets, not JSON text/order/whitespace. Numeric 1
              // and 1.0 have the same meaning, as they do in PostgreSQL jsonb.
              const fields = sql`key,value,case type when 'integer' then 'number'
                when 'real' then 'number' else type end`;
              const before = sql`select ${fields} from json_each(job_status) where key <> 'observedAt'`;
              const after = sql`select ${fields} from json_each(${encoded}) where key <> 'observedAt'`;
              const changed =
                dialect === "postgres"
                  ? sql`(job_status - 'observedAt') is distinct from (${encoded}::jsonb - 'observedAt')`
                  : sql`job_status is null or exists (${before} except ${after})
                      or exists (${after} except ${before})`;
              // State eligibility and semantic inequality are both in UPDATE:
              // competing identical reports cannot append duplicate events.
              const updated = (
                await sql`update runs set job_status=${encoded}
                  where id=${id} and state in ('scheduled','running','cancelling')
                    and (${changed}) returning *`.execute(tx)
              ).rows[0];
              if (updated === undefined) return false;
              const run = decodeRun(updated, dialect);
              await sql`insert into run_events(run_id,at,from_state,to_state,reason,payload)
                values(${id},${DateTime.formatIso(now)},${run.state},${run.state},'job_status',${encoded})`.execute(
                tx,
              );
              if (dialect === "postgres")
                await sql`select pg_notify('krun_runs',${`${id}:job_status`})`.execute(tx);
              return true;
            }),
          );
        }),
      ),
  };
});
