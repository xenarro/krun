import { DateTime } from "effect";
import { z } from "zod";
import type { JsonObject, JsonValue, Run, SummaryRow } from "./model.js";
import { failureReasons, states } from "./model.js";

const object = z.custom<JsonObject>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
const utc = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => DateTime.makeUnsafe(value));
const schema = z.object({
  id: z.string(),
  idempotency_key: z.string().nullable(),
  request_hash: z.string(),
  function_name: z.string(),
  input: object,
  state: z.enum(states),
  priority: z.number().int(),
  attempt: z.number().int(),
  lease_owner: z.string().nullable(),
  lease_until: utc.nullable(),
  job_name: z.string().nullable(),
  job_token_hash: z.string().nullable(),
  result: z.custom<JsonValue>((value) => value !== undefined),
  result_ref: z.string().nullable(),
  error: z
    .object({
      source: z.enum(["function", "kubernetes", "krun"]),
      message: z.string(),
      type: z.string().optional(),
      details: object.optional(),
    })
    .transform(({ type, details, ...value }) => ({
      ...value,
      ...(type === undefined ? {} : { type }),
      ...(details === undefined ? {} : { details }),
    }))
    .nullable(),
  log_tail: z.string().nullable(),
  failure_reason: z.enum(failureReasons).nullable(),
  runtime_status: z
    .object({
      message: z.string(),
      progress: z.number().optional(),
      data: object.optional(),
      at: utc,
    })
    .transform(({ progress, data, ...value }) => ({
      ...value,
      ...(progress === undefined ? {} : { progress }),
      ...(data === undefined ? {} : { data }),
    }))
    .nullable(),
  job_status: z
    .object({
      podName: z.string().optional(),
      phase: z.string().optional(),
      reason: z.string().optional(),
      message: z.string().optional(),
      exitCode: z.number().int().optional(),
      observedAt: utc,
    })
    .transform(({ observedAt, podName, phase, reason, message, exitCode }) => ({
      observedAt,
      ...(podName === undefined ? {} : { podName }),
      ...(phase === undefined ? {} : { phase }),
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
      ...(exitCode === undefined ? {} : { exitCode }),
    }))
    .nullable(),
  callback_url: z.string().nullable(),
  created_by: z.string(),
  created_at: utc,
  scheduled_at: utc.nullable(),
  started_at: utc.nullable(),
  finished_at: utc.nullable(),
});

const summarySchema = schema.omit({ input: true, result: true, log_tail: true });
const normalize = (row: unknown, dialect: "postgres" | "sqlite", columns: readonly string[]) => {
  if (dialect === "sqlite" && typeof row === "object" && row !== null) {
    const values: Record<string, unknown> = { ...row };
    for (const key of columns) {
      if (typeof values[key] === "string") values[key] = JSON.parse(values[key]);
    }
    return values;
  }
  return row;
};

// Infrastructure decoders, not row-to-wire mappers. Parse failures stay inside
// the query adapter's tryPromise boundary and are sanitized there. BASIC reads
// neither require nor decode the three FULL-only columns.
export const decodeRun = (row: unknown, dialect: "postgres" | "sqlite"): Run =>
  schema.parse(
    normalize(row, dialect, ["input", "result", "error", "runtime_status", "job_status"]),
  );
export const decodeSummaryRow = (row: unknown, dialect: "postgres" | "sqlite"): SummaryRow =>
  summarySchema.parse(normalize(row, dialect, ["error", "runtime_status", "job_status"]));
