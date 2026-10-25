import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { DateTime, Effect } from "effect";
import { sql } from "kysely";
import { z } from "zod";
import { Database } from "../runtime/database.js";
import { DatabaseError, NotFoundError } from "./errors.js";
import type { StoreShape } from "./index.js";
import { toRunSummary } from "./mappers.js";
import { failureReasons, type RunFilter, states } from "./model.js";
import { requestIdStorage } from "./request-id.js";
import { decodeRun, decodeSummaryRow } from "./rows.js";

const utc = z.custom<DateTime.Utc>((value) => DateTime.isDateTime(value) && DateTime.isUtc(value));
const filterSchema = z.strictObject({
  function_name: z.string().optional(),
  created_by: z.string().optional(),
  terms: z
    .array(
      z.union([
        z.strictObject({
          field: z.literal("state"),
          operator: z.enum(["=", "!="]),
          value: z.enum(states),
        }),
        z.strictObject({
          field: z.literal("failureReason"),
          operator: z.literal("="),
          value: z.enum(failureReasons),
        }),
        z.strictObject({
          field: z.literal("createTime"),
          operator: z.enum([">=", "<=", ">", "<"]),
          value: utc,
        }),
      ]),
    )
    .optional(),
});
const pageSize = (limit: number) =>
  Math.min(z.number().int().nonnegative().parse(limit) || 50, 200);
const scopeHash = (filter: RunFilter) =>
  createHash("sha256")
    .update(
      z.string().parse(
        canonicalize({
          function_name: filter.function_name ?? null,
          created_by: filter.created_by ?? null,
          terms: (filter.terms ?? []).map((term) =>
            term.field === "createTime" ? { ...term, value: DateTime.formatIso(term.value) } : term,
          ),
        }),
      ),
    )
    .digest("hex");
const cursorSchema = z.tuple([
  z.iso.datetime().refine((value) => value === DateTime.formatIso(DateTime.makeUnsafe(value))),
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  z.string().regex(/^[0-9a-f]{64}$/),
]);
const decodeCursor = (cursor: string, hash: string) => {
  z.string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .parse(cursor);
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  // Buffer's decoder is permissive: require canonical unpadded base64url/UTF8.
  z.literal(cursor).parse(Buffer.from(decoded, "utf8").toString("base64url"));
  const [at, id, scope] = cursorSchema.parse(decoded.split("|"));
  z.literal(hash).parse(scope);
  return { at, id };
};
const encodeCursor = (at: DateTime.Utc, id: string, filter: RunFilter) =>
  Buffer.from(`${DateTime.formatIso(at)}|${id}|${scopeHash(filter)}`, "utf8").toString("base64url");

// Exactly the SPEC BASIC projection: never fetch the three FULL-only columns.
const summaryColumns = sql`id,idempotency_key,request_hash,function_name,state,priority,attempt,
  lease_owner,lease_until,job_name,job_token_hash,result_ref,error,failure_reason,
  runtime_status,job_status,callback_url,created_by,created_at,scheduled_at,started_at,finished_at`;

// The planner contract runs EXPLAIN on this exact builder used by listRuns.
// Validation throws only inside the Store adapter (or a caller's schema boundary).
export const listRunsQuery = (
  filter: RunFilter,
  cursor: string | null,
  limit = 50,
  dialect: "postgres" | "sqlite" = "sqlite",
) => {
  filterSchema.parse(filter);
  const predicates = [];
  if (filter.function_name !== undefined)
    predicates.push(sql`function_name=${filter.function_name}`);
  if (filter.created_by !== undefined) predicates.push(sql`created_by=${filter.created_by}`);
  for (const term of filter.terms ?? []) {
    const column =
      term.field === "state"
        ? "state"
        : term.field === "failureReason"
          ? "failure_reason"
          : "created_at";
    const value = term.field === "createTime" ? DateTime.formatIso(term.value) : term.value;
    // Operators/column names come only from the strict closed structured schema.
    predicates.push(sql`${sql.ref(column)} ${sql.raw(term.operator)} ${value}`);
  }
  if (cursor !== null) {
    const after = decodeCursor(cursor, scopeHash(filter));
    predicates.push(sql`(created_at,id) < (${after.at},${after.id})`);
  }
  return sql`select ${summaryColumns}${dialect === "postgres" ? sql`,idempotency_key_nul` : sql``} from runs ${predicates.length === 0 ? sql`` : sql`where ${sql.join(predicates, sql` and `)}`}
    order by created_at desc,id desc limit ${pageSize(limit) + 1}`;
};

type Methods = Pick<StoreShape, "getRun" | "listRuns" | "findRunByRequestId">;
const traced = <A, E>(method: keyof Methods, id: string | undefined, body: Effect.Effect<A, E>) =>
  body.pipe(
    Effect.uninterruptible,
    Effect.withSpan(`store.${method}`, {
      kind: "client",
      attributes: {
        "db.operation.name": method,
        "db.response.returned_rows": 0,
        ...(id === undefined ? {} : { "krun.run_id": id }),
      },
    }),
  );

// D45: compose real declared methods, not future-method placeholders.
export const makeRunQueries = Effect.map(
  Database,
  ({ db, dialect }): Methods => ({
    findRunByRequestId: (functionName, createdBy, requestId) => {
      const key = requestIdStorage(dialect, requestId);
      return traced(
        "findRunByRequestId",
        undefined,
        Effect.gen(function* () {
          const row = yield* Effect.tryPromise({
            try: async () => {
              const raw = (
                await sql`select * from runs where function_name=${functionName} and created_by=${createdBy} and ${key.column}=${key.value}`.execute(
                  db,
                )
              ).rows[0];
              return raw === undefined ? undefined : decodeRun(raw, dialect);
            },
            catch: () => new DatabaseError({ operation: "findRunByRequestId" }),
          });
          yield* Effect.annotateCurrentSpan("db.response.returned_rows", row === undefined ? 0 : 1);
          return row;
        }),
      );
    },
    getRun: (id) =>
      traced(
        "getRun",
        id,
        Effect.gen(function* () {
          const row = yield* Effect.tryPromise({
            try: async () => {
              const raw = (await sql`select * from runs where id=${id}`.execute(db)).rows[0];
              return raw === undefined ? undefined : decodeRun(raw, dialect);
            },
            catch: () => new DatabaseError({ operation: "getRun" }),
          });
          if (row === undefined) return yield* Effect.fail(new NotFoundError({ id }));
          yield* Effect.annotateCurrentSpan("db.response.returned_rows", 1);
          return row;
        }),
      ),
    listRuns: (filter, cursor, limit = 50) =>
      traced(
        "listRuns",
        undefined,
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: async () => {
              const rows = (await listRunsQuery(filter, cursor, limit, dialect).execute(db)).rows;
              const size = pageSize(limit);
              const decoded = rows.slice(0, size).map((row) => decodeSummaryRow(row, dialect));
              const last = decoded.at(-1);
              return {
                runs: decoded.map(toRunSummary),
                next:
                  rows.length > size && last !== undefined
                    ? encodeCursor(last.created_at, last.id, filter)
                    : null,
              };
            },
            catch: () => new DatabaseError({ operation: "listRuns" }),
          });
          yield* Effect.annotateCurrentSpan("db.response.returned_rows", result.runs.length);
          return result;
        }),
      ),
  }),
);
