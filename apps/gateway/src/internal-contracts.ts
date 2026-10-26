import type { JsonObject } from "@krun/shared/dist/store/model.js";
import { z } from "zod";

const compactBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const text = (max: number, required = false) =>
  z
    .string()
    .min(required ? 1 : 0)
    .refine((value) => compactBytes(value) <= max)
    .describe(`At most ${max} bytes in compact UTF-8 JSON.`);
const opaque = z.custom<JsonObject>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    z.json().safeParse(value).success,
);
const leaves = new Set<z.core.$ZodType>([opaque]);
const data = (max: number) => {
  const bounded = opaque.refine((value) => compactBytes(value) <= max);
  const node = bounded.describe(`Opaque JSON object; at most ${max} compact UTF-8 bytes.`);
  leaves.add(bounded);
  leaves.add(node);
  return node;
};
const status = z.strictObject({
  message: text(1024, true),
  progress: z.number().min(0).max(1).optional(),
  data: data(4096).optional(),
});
const error = z.strictObject({
  message: text(4096, true),
  type: text(128).optional(),
  details: data(8192).optional(),
});
const params = z.strictObject({
  run: z
    .string()
    .describe("Lowercase UUID; malformed or unknown run is TOKEN_INVALID, not a schema error."),
});
const result = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), opaque])
  .refine((value) => z.json().safeParse(value).success);
const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.int32(),
    message: z.string(),
    status: z
      .string()
      .describe(
        "Open enum: INVALID_ARGUMENT, UNAUTHENTICATED, NOT_FOUND, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE",
      ),
    details: z.tuple([
      z.strictObject({
        "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
        reason: z
          .string()
          .describe(
            "Open enum: REQUEST_INVALID, TOKEN_INVALID, ROUTE_NOT_FOUND, UNSUPPORTED_API_VERSION, RESULT_TOO_LARGE, REQUEST_TOO_LARGE, CONTENT_TYPE_UNSUPPORTED, STATUS_RATE_LIMITED, INTERNAL, NOT_READY",
          ),
        domain: z.literal("krun.io"),
      }),
    ]),
  }),
});
const responses = Object.fromEntries(
  [400, 401, 404, 413, 415, 429, 500, 503].map((code) => [code, errorEnvelope]),
);
const common = { params, querystring: z.strictObject({}), security: [{ runToken: [] }] };
export const internalContracts = {
  GetInput: {
    method: "GET",
    url: "/internal/v1/runs/:run/input",
    schema: { ...common, operationId: "GetInput", response: { ...responses, 200: opaque } },
  },
  ReportStatus: {
    method: "POST",
    url: "/internal/v1/runs/:run/status",
    schema: {
      ...common,
      operationId: "ReportStatus",
      body: status,
      response: { ...responses, 204: z.never() },
    },
  },
  SetResult: {
    method: "PUT",
    url: "/internal/v1/runs/:run/result",
    schema: {
      ...common,
      operationId: "SetResult",
      body: result,
      response: { ...responses, 204: z.never() },
    },
  },
  SetError: {
    method: "PUT",
    url: "/internal/v1/runs/:run/error",
    schema: {
      ...common,
      operationId: "SetError",
      body: error,
      response: { ...responses, 204: z.never() },
    },
  },
} as const;
export const internalContractProjection = ({ zodSchema }: { zodSchema: z.core.$ZodType }) =>
  leaves.has(zodSchema)
    ? { type: "object" as const, additionalProperties: {} }
    : ("throw" as const);
