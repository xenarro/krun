import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { v7 } from "uuid";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { toRunSummary } from "./mappers.js";
import { decodeRun } from "./rows.js";

const json = (value: unknown) =>
  value === null || value === undefined ? value : JSON.stringify(value);
const time = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? value : DateTime.formatIso(value);

// D45: provide the real declared method without placeholders for later tasks.
export const makeTransition = Effect.map(
  Database,
  ({ db, dialect }): StoreShape["transition"] =>
    (id, from, to, reason, patch, event) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const changed = yield* Effect.tryPromise({
          try: () =>
            db.transaction().execute(async (tx) => {
              const at = DateTime.formatIso(now);
              const terminal = to === "succeeded" || to === "failed" || to === "cancelled";
              // Enumerate declared columns, never identifiers supplied by a caller.
              // The CAS owns identity/state and lifecycle timestamps, not patch.
              const values = {
                idempotency_key: patch.idempotency_key,
                request_hash: patch.request_hash,
                function_name: patch.function_name,
                input: json(patch.input),
                priority: patch.priority,
                attempt: patch.attempt,
                lease_owner: patch.lease_owner,
                lease_until: time(patch.lease_until),
                job_name: patch.job_name,
                job_token_hash: patch.job_token_hash,
                result: json(patch.result),
                result_ref: patch.result_ref,
                log_tail: patch.log_tail,
                failure_reason: patch.failure_reason,
                runtime_status: json(
                  patch.runtime_status == null
                    ? patch.runtime_status
                    : { ...patch.runtime_status, at: DateTime.formatIso(patch.runtime_status.at) },
                ),
                job_status: json(
                  patch.job_status == null
                    ? patch.job_status
                    : {
                        ...patch.job_status,
                        observedAt: DateTime.formatIso(patch.job_status.observedAt),
                      },
                ),
                callback_url: patch.callback_url,
                created_by: patch.created_by,
                // createRun/markScheduled own earlier lifecycle timestamps.
              };
              const assignments = Object.entries(values)
                .filter(([, value]) => value !== undefined)
                .map(([column, value]) => sql`${sql.ref(column)}=${value}`);
              assignments.push(sql`state=${to}`);
              if (patch.error !== undefined)
                assignments.push(sql`error=coalesce(error,${json(patch.error)})`);
              if (to === "running") assignments.push(sql`started_at=${at}`);
              else if (terminal && patch.started_at !== undefined)
                assignments.push(sql`started_at=coalesce(started_at,${time(patch.started_at)})`);
              if (terminal) assignments.push(sql`finished_at=${at}`);
              const updated = (
                await sql`update runs set ${sql.join(assignments)}
                  where id=${id} and state=${from} returning *`.execute(tx)
              ).rows[0];
              if (updated === undefined) return false;
              // Decode before committing: a malformed driver/patch row is a failure,
              // never a successful state change or a malformed callback payload.
              const run = decodeRun(updated, dialect);
              await sql`insert into run_events(run_id,at,from_state,to_state,reason,payload)
                values(${id},${at},${from},${to},${reason},${json(event) ?? null})`.execute(tx);
              if (terminal && run.callback_url !== null) {
                const deliveryId = v7({ msecs: DateTime.toEpochMillis(now) });
                await sql`insert into deliveries(id,run_id,url,payload,attempt,next_at,state,last_error,created_at)
                  values(${deliveryId},${id},${run.callback_url},${JSON.stringify(toRunSummary(run))},0,${at},'pending',null,${at})`.execute(
                  tx,
                );
              }
              if (dialect === "postgres")
                await sql`select pg_notify('krun_runs',${`${id}:${to}`})`.execute(tx);
              return true;
            }),
          catch: () => new DatabaseError({ operation: "transition" }),
        });
        yield* Effect.annotateCurrentSpan("db.response.returned_rows", changed ? 1 : 0);
        if (!changed) yield* Effect.logDebug("Stale transition ignored");
        return changed;
      }).pipe(
        // Driver promises are uncancellable. Finish commit/rollback and release
        // before interruption can close the owning Database scope.
        Effect.uninterruptible,
        Effect.withSpan("store.transition", {
          kind: "client",
          attributes: {
            "db.operation.name": "transition",
            "db.response.returned_rows": 0,
            "krun.run_id": id,
          },
        }),
      ),
);
