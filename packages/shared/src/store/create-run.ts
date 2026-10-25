import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { Database } from "../runtime/database.js";
import { ConflictError, DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import type { NewRun } from "./model.js";
import { requestIdStorage } from "./request-id.js";
import { decodeRun } from "./rows.js";

// Supplies exactly the declared method, without dummy implementations of the
// later Store tasks. The eventual Store layer composes these real factories.
export const makeCreateRun = Effect.map(
  Database,
  ({ db, dialect }): StoreShape["createRun"] =>
    (run: NewRun) =>
      Effect.gen(function* () {
        const values = yield* Effect.try({
          try: () => ({
            ...run,
            input: JSON.stringify(run.input),
            at: DateTime.formatIso(run.created_at),
          }),
          catch: () => new DatabaseError({ operation: "createRun" }),
        });
        const key = requestIdStorage(dialect, run.idempotency_key);
        const result = yield* Effect.tryPromise({
          try: () =>
            db.transaction().execute(async (transaction) => {
              // Target only the normative partial idempotency index. Unrelated PK,
              // check, permission and query failures must never become dedupe success.
              const inserted = (
                await sql`
          insert into runs (id,${key.column},request_hash,function_name,input,state,priority,attempt,callback_url,created_by,created_at)
          values (${values.id},${key.value},${values.request_hash},${values.function_name},${values.input},'queued',${values.priority},0,${values.callback_url},${values.created_by},${values.at})
          on conflict (created_by,function_name,${key.column}) where ${key.column} is not null do nothing
          returning *`.execute(transaction)
              ).rows[0];
              if (inserted !== undefined) {
                const normalized = decodeRun(inserted, dialect);
                await sql`insert into run_events (run_id,at,from_state,to_state,reason,payload)
            values (${normalized.id},${values.at},null,'queued',null,${JSON.stringify({ actor: values.created_by })})`.execute(
                  transaction,
                );
                if (dialect === "postgres")
                  await sql`select pg_notify('krun_runs', ${`${normalized.id}:queued`})`.execute(
                    transaction,
                  );
                return { run: normalized, created: true };
              }
              // Under Postgres READ COMMITTED this new statement sees the winning
              // transaction after the unique check waited for its commit. SQLite
              // serializes the same algorithm under its existing BEGIN IMMEDIATE.
              const existing = (
                await sql`select * from runs where created_by=${values.created_by}
          and function_name=${values.function_name} and ${key.column}=${key.value}`.execute(
                  transaction,
                )
              ).rows[0];
              return { run: decodeRun(existing, dialect), created: false };
            }),
          catch: () => new DatabaseError({ operation: "createRun" }),
        });
        yield* Effect.annotateCurrentSpan("krun.run_id", result.run.id);
        if (!result.created && result.run.request_hash !== values.request_hash)
          return yield* Effect.fail(new ConflictError());
        yield* Effect.annotateCurrentSpan("db.response.returned_rows", 1);
        return result;
      }).pipe(
        // Finish uncancellable driver promises/transaction release before the
        // surrounding database scope can be finalized on interruption.
        Effect.uninterruptible,
        Effect.withSpan("store.createRun", {
          kind: "client",
          attributes: {
            "db.operation.name": "createRun",
            "db.response.returned_rows": 0,
            "krun.run_id": run.id,
          },
        }),
      ),
);
