import { Data } from "effect";
import type { FastifyReply } from "fastify";
import { z } from "zod";

// docs/API.md section 4. Messages are owned constants, never adapter diagnostics.
const errors = {
  REQUEST_INVALID: [400, "INVALID_ARGUMENT", "Request is invalid"],
  INPUT_SCHEMA_VIOLATION: [400, "INVALID_ARGUMENT", "Input does not match the function schema"],
  FILTER_INVALID: [400, "INVALID_ARGUMENT", "Filter is invalid"],
  CALLBACK_NOT_ALLOWED: [400, "INVALID_ARGUMENT", "Callback is not allowed"],
  RUN_TERMINAL: [400, "FAILED_PRECONDITION", "Run is terminal"],
  RUN_NOT_TERMINAL: [400, "FAILED_PRECONDITION", "Run is not terminal"],
  KEY_MISSING: [401, "UNAUTHENTICATED", "Bearer key is required"],
  KEY_INVALID: [401, "UNAUTHENTICATED", "Bearer key is invalid"],
  SCOPE_MISSING: [403, "PERMISSION_DENIED", "Required scope is missing"],
  ROUTE_NOT_FOUND: [404, "NOT_FOUND", "Route not found"],
  FUNCTION_NOT_FOUND: [404, "NOT_FOUND", "Function not found"],
  RUN_NOT_FOUND: [404, "NOT_FOUND", "Run not found"],
  RESULT_MISSING: [404, "NOT_FOUND", "Result is missing"],
  IDEMPOTENCY_CONFLICT: [409, "ABORTED", "Request identifier conflicts with an earlier request"],
  INPUT_TOO_LARGE: [413, "INVALID_ARGUMENT", "Input is too large"],
  CONTENT_TYPE_UNSUPPORTED: [415, "INVALID_ARGUMENT", "Content type must be application/json"],
  RATE_LIMITED: [429, "RESOURCE_EXHAUSTED", "Request rate exceeded"],
  QUEUE_FULL: [429, "RESOURCE_EXHAUSTED", "Queue is full"],
  INTERNAL: [500, "INTERNAL", "Internal server error"],
  NOT_READY: [503, "UNAVAILABLE", "Service is not ready"],
} as const;
export type ApiReason = keyof typeof errors;
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly reason: ApiReason;
  // Only explicitly selected nonsecret API metadata, never arbitrary causes.
  readonly metadata?: Readonly<Record<string, string>>;
}> {}
const frameworkError = z.looseObject({ code: z.string() });
const malformed = new Set([
  "FST_ERR_VALIDATION",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
  "FST_ERR_BAD_URL",
  "FST_ERR_MAX_PARAM_LENGTH",
]);
export const errorEnvelope = (error: unknown) => {
  const framework = frameworkError.safeParse(error);
  const reason: ApiReason =
    error instanceof ApiError
      ? error.reason
      : framework.success && malformed.has(framework.data.code)
        ? "REQUEST_INVALID"
        : framework.success && framework.data.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
          ? "CONTENT_TYPE_UNSUPPORTED"
          : framework.success && framework.data.code === "FST_ERR_CTP_BODY_TOO_LARGE"
            ? "INPUT_TOO_LARGE"
            : "INTERNAL";
  const [code, status, message] = errors[reason];
  return {
    error: {
      code,
      message,
      status,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo" as const,
          reason,
          domain: "krun.io" as const,
          ...(error instanceof ApiError && error.metadata !== undefined
            ? { metadata: error.metadata }
            : {}),
        },
      ],
    },
  };
};
export const sendError = (reply: FastifyReply, error: unknown) => {
  const body = errorEnvelope(error);
  if (body.error.code === 429 || body.error.code === 503) reply.header("Retry-After", "1");
  // Error responses cannot accidentally use a route's successful response schema.
  return reply
    .code(body.error.code)
    .type("application/json; charset=utf-8")
    .serializer(JSON.stringify)
    .send(body);
};
