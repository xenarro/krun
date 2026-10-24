import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { z } from "zod";
import { Database } from "../runtime/database.js";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { type State, states } from "./model.js";
import { decodeRun } from "./rows.js";

// Match runs_active_idx literally, shared by the actual count/list statements.
export const activePredicate = sql`state in ('queued','scheduled','running','cancelling')`;
export const countByStateQuery = sql`select function_name,state,count(*) as n from runs
  where ${activePredicate} group by function_name,state`;
const count = z.coerce.number().int().nonnegative();
const limitSchema = z.number().int().nonnegative();
const groupedCount = z.object({
  function_name: z.string(),
  state: z.enum(["queued", "scheduled", "running", "cancelling"]),
  n: count,
});
type Methods = Pick<
  StoreShape,
  | "claimQueued"
  | "releaseLease"
  | "setJobToken"
  | "markScheduled"
  | "countByState"
  | "countQueued"
  | "countQueuedBy"
  | "listByState"
>;

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
  });
const traced = <A>(
  operation: keyof Methods,
  id: string | undefined,
  body: Effect.Effect<A, DatabaseError>,
) =>
  body.pipe(
    // Driver promises cannot be cancelled safely; finish release/rollback before
    // allowing the owning Database scope to close, as in createRun.
    Effect.uninterruptible,
    Effect.withSpan(`store.${operation}`, {
      kind: "client",
      attributes: {
        "db.operation.name": operation,
        "db.response.returned_rows": 0,
        ...(id === undefined ? {} : { "krun.run_id": id }),
      },
    }),
  );

// D45: compose real declared methods, never fill later Store tasks with stubs.
export const makeRunLeasing = Effect.map(
  Database,
  ({ db, dialect }): Methods => ({
    claimQueued: (fn, owner, leaseUntil, limit) =>
      traced(
        "claimQueued",
        undefined,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* adapter("claimQueued", () =>
            db.transaction().execute(async (tx) => {
              const rows = (
                await sql`update runs
        set lease_owner=${owner},lease_until=${DateTime.formatIso(leaseUntil)},attempt=attempt+1
        where id in (select id from runs where state='queued' and function_name=${fn}
          and (lease_until is null or lease_until < ${DateTime.formatIso(now)})
          order by priority desc,created_at
          ${dialect === "postgres" ? sql`for update skip locked` : sql``}
          limit ${limitSchema.parse(limit)}) returning *`.execute(tx)
              ).rows;
              return { value: rows.map((row) => decodeRun(row, dialect)), rowCount: rows.length };
            }),
          );
        }),
      ),
    releaseLease: (id) =>
      traced(
        "releaseLease",
        id,
        adapter("releaseLease", async () => {
          const result =
            await sql`update runs set lease_owner=null,lease_until=null where id=${id} returning id`.execute(
              db,
            );
          return { value: undefined, rowCount: result.rows.length };
        }),
      ),
    setJobToken: (id, jobName, tokenHash) =>
      traced(
        "setJobToken",
        id,
        adapter("setJobToken", async () => {
          const result =
            await sql`update runs set job_name=${jobName},job_token_hash=${tokenHash} where id=${id} and state='queued' returning id`.execute(
              db,
            );
          return { value: undefined, rowCount: result.rows.length };
        }),
      ),
    markScheduled: (id) =>
      traced(
        "markScheduled",
        id,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const changed = yield* adapter("markScheduled", () =>
            db.transaction().execute(async (tx) => {
              const at = DateTime.formatIso(now);
              const updated = (
                await sql`update runs set state='scheduled',scheduled_at=${at},lease_owner=null,lease_until=null
        where id=${id} and state='queued' returning id`.execute(tx)
              ).rows;
              if (updated.length === 0) return { value: false, rowCount: 0 };
              await sql`insert into run_events(run_id,at,from_state,to_state,reason,payload)
        values(${id},${at},'queued','scheduled',null,null)`.execute(tx);
              if (dialect === "postgres")
                await sql`select pg_notify('krun_runs',${`${id}:scheduled`})`.execute(tx);
              return { value: true, rowCount: updated.length };
            }),
          );
          if (!changed) yield* Effect.logDebug("Stale markScheduled ignored");
          return changed;
        }),
      ),
    countByState: () =>
      traced(
        "countByState",
        undefined,
        adapter("countByState", async () => {
          const rows = (await countByStateQuery.execute(db)).rows;
          const result = new Map<string, Map<State, number>>();
          for (const row of rows) {
            const value = groupedCount.parse(row);
            let functionCounts = result.get(value.function_name);
            if (functionCounts === undefined) {
              functionCounts = new Map<State, number>();
              result.set(value.function_name, functionCounts);
            }
            functionCounts.set(value.state, value.n);
          }
          return { value: result, rowCount: rows.length };
        }),
      ),
    countQueued: (fn) =>
      traced(
        "countQueued",
        undefined,
        adapter("countQueued", async () => {
          const rows = (
            await sql<{
              n: unknown;
            }>`select count(*) as n from runs where state='queued' and function_name=${fn}`.execute(
              db,
            )
          ).rows;
          return { value: count.parse(rows[0]?.n), rowCount: rows.length };
        }),
      ),
    countQueuedBy: (fn, createdBy) =>
      traced(
        "countQueuedBy",
        undefined,
        adapter("countQueuedBy", async () => {
          const rows = (
            await sql<{
              n: unknown;
            }>`select count(*) as n from runs where state='queued' and function_name=${fn} and created_by=${createdBy}`.execute(
              db,
            )
          ).rows;
          return { value: count.parse(rows[0]?.n), rowCount: rows.length };
        }),
      ),
    listByState: (requested, limit) =>
      traced(
        "listByState",
        undefined,
        adapter("listByState", async () => {
          const selected = z.array(z.enum(states)).parse(requested);
          // Bind the requested subset safely; the independent active-index predicate
          // remains literal and excludes terminal states even if requested.
          const subset = selected.length === 0 ? sql`1=0` : sql`state in (${sql.join(selected)})`;
          const rows = (
            await sql`select * from runs where ${activePredicate} and ${subset}
      order by created_at,id limit ${limitSchema.parse(limit)}`.execute(db)
          ).rows;
          return { value: rows.map((row) => decodeRun(row, dialect)), rowCount: rows.length };
        }),
      ),
  }),
);
