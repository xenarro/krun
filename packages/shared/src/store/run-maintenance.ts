import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { v7 } from "uuid";
import { z } from "zod";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { toRunSummary } from "./mappers.js";
import { observeRunChange } from "./observations.js";
import { decodeDelivery, decodeRun } from "./rows.js";

type Methods = Pick<StoreShape, "expireQueued" | "sweep" | "claimDeliveries" | "updateDelivery">;
const nonnegative = z.number().int().nonnegative();
const adapter = <A>(
  operation: keyof Methods,
  execute: () => Promise<{ value: A; rowCount: number }>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: execute,
      catch: () => new DatabaseError({ operation }),
    });
    yield* Effect.annotateCurrentSpan("db.response.returned_rows", result.rowCount);
    return result.value;
  }).pipe(
    // The driver cannot cancel a write safely; settle commit/rollback before
    // interruption can release the enclosing Database scope.
    Effect.uninterruptible,
    Effect.withSpan(`store.${operation}`, {
      kind: "client",
      attributes: { "db.operation.name": operation, "db.response.returned_rows": 0 },
    }),
  );

// D45: real declared methods only, without placeholders for remaining Store work.
export const makeRunMaintenance = Effect.map(
  Database,
  ({ db, dialect }): Methods => ({
    expireQueued: (fn, olderThan) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const runs = yield* adapter("expireQueued", () =>
          db.transaction().execute(async (tx) => {
            const at = DateTime.formatIso(now);
            const changed = (
              await sql`update runs set state='failed',failure_reason='queue_timeout',finished_at=${at},
        error=coalesce(error,${JSON.stringify({ source: "krun", message: "Queued run exceeded its queue timeout" })})
        where state='queued' and function_name=${fn} and created_at < ${DateTime.formatIso(olderThan)} returning *`.execute(
                tx,
              )
            ).rows;
            // Decode the entire batch before dependent writes or commit. Preserve FULL
            // job/token metadata so the scheduler can remove partially created Jobs.
            const runs = changed.map((row) => decodeRun(row, dialect));
            for (const run of runs) {
              await sql`insert into run_events(run_id,at,from_state,to_state,reason,payload)
          values(${run.id},${at},'queued','failed','queue_timeout',null)`.execute(tx);
              if (run.callback_url !== null) {
                const deliveryId = v7({ msecs: DateTime.toEpochMillis(now) });
                await sql`insert into deliveries(id,run_id,url,payload,attempt,next_at,state,last_error,created_at)
            values(${deliveryId},${run.id},${run.callback_url},${JSON.stringify(toRunSummary(run))},0,${at},'pending',null,${at})`.execute(
                  tx,
                );
              }
              if (dialect === "postgres")
                await sql`select pg_notify('krun_runs',${`${run.id}:failed`})`.execute(tx);
            }
            return { value: runs, rowCount: runs.length };
          }),
        );
        for (const run of runs) yield* observeRunChange(run, "queued");
        return runs;
      }).pipe(Effect.uninterruptible),
    sweep: (finishedBefore, batch) =>
      adapter("sweep", () =>
        db.transaction().execute(async (tx) => {
          const removed = (
            await sql`delete from runs where id in (
      select id from runs where finished_at is not null and finished_at < ${DateTime.formatIso(finishedBefore)}
      order by finished_at,id ${dialect === "postgres" ? sql`for update skip locked` : sql``}
      limit ${nonnegative.parse(batch)}) returning id`.execute(tx)
          ).rows;
          // Run after every batch, including empty batches, on the same SQLite
          // transaction/connection; a failure cannot leave a partially accepted sweep.
          if (dialect === "sqlite") await sql`pragma incremental_vacuum`.execute(tx);
          return { value: removed.length, rowCount: removed.length };
        }),
      ),
    claimDeliveries: (now, limit) =>
      adapter("claimDeliveries", () =>
        db.transaction().execute(async (tx) => {
          // Selection and lease write are one statement. Postgres skips another
          // worker's locks; SQLite serializes through its BEGIN IMMEDIATE driver.
          const rows = (
            await sql`update deliveries set next_at=${DateTime.formatIso(DateTime.addDuration(now, "60 seconds"))}
      where id in (select id from deliveries where state='pending' and next_at <= ${DateTime.formatIso(now)}
        order by next_at,id ${dialect === "postgres" ? sql`for update skip locked` : sql``}
        limit ${nonnegative.parse(limit)}) returning *`.execute(tx)
          ).rows;
          return { value: rows.map((row) => decodeDelivery(row, dialect)), rowCount: rows.length };
        }),
      ),
    updateDelivery: (id, state, attempt, nextAt, lastError, expectedClaim) =>
      adapter("updateDelivery", async () => {
        // next_at is NOT NULL in the normative DDL. null means no replacement time
        // (terminal updates do not reschedule); retain the last claim/retry value.
        const rows = (
          await sql`update deliveries set state=${z.enum(["pending", "delivered", "dead"]).parse(state)},
      attempt=${nonnegative.parse(attempt)},next_at=coalesce(${nextAt === null ? null : DateTime.formatIso(nextAt)},next_at),
      last_error=${lastError} where id=${id} ${expectedClaim === undefined ? sql`` : sql`and state='pending' and attempt=${nonnegative.parse(expectedClaim.attempt)} and next_at=${DateTime.formatIso(expectedClaim.next_at)}`} returning id`.execute(
            db,
          )
        ).rows;
        // A successful zero-row statement is stale/missing, not a persisted
        // outcome. The scheduler uses the claim's pair as an atomic CAS token.
        return { value: rows.length > 0, rowCount: rows.length };
      }),
  }),
);
