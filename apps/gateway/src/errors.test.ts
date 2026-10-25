import { describe, expect, it } from "vitest";
import { ApiError, errorEnvelope } from "./errors.js";

const cases = [
  ["REQUEST_INVALID", 400, "INVALID_ARGUMENT"],
  ["INPUT_SCHEMA_VIOLATION", 400, "INVALID_ARGUMENT"],
  ["FILTER_INVALID", 400, "INVALID_ARGUMENT"],
  ["CALLBACK_NOT_ALLOWED", 400, "INVALID_ARGUMENT"],
  ["RUN_TERMINAL", 400, "FAILED_PRECONDITION"],
  ["RUN_NOT_TERMINAL", 400, "FAILED_PRECONDITION"],
  ["KEY_MISSING", 401, "UNAUTHENTICATED"],
  ["KEY_INVALID", 401, "UNAUTHENTICATED"],
  ["SCOPE_MISSING", 403, "PERMISSION_DENIED"],
  ["ROUTE_NOT_FOUND", 404, "NOT_FOUND"],
  ["FUNCTION_NOT_FOUND", 404, "NOT_FOUND"],
  ["RUN_NOT_FOUND", 404, "NOT_FOUND"],
  ["RESULT_MISSING", 404, "NOT_FOUND"],
  ["IDEMPOTENCY_CONFLICT", 409, "ABORTED"],
  ["INPUT_TOO_LARGE", 413, "INVALID_ARGUMENT"],
  ["CONTENT_TYPE_UNSUPPORTED", 415, "INVALID_ARGUMENT"],
  ["RATE_LIMITED", 429, "RESOURCE_EXHAUSTED"],
  ["QUEUE_FULL", 429, "RESOURCE_EXHAUSTED"],
  ["INTERNAL", 500, "INTERNAL"],
  ["NOT_READY", 503, "UNAVAILABLE"],
] as const;
describe("docs/API.md section 4 canonical mapping", () => {
  it.each(cases)("%s maps to %i %s", (reason, code, status) => {
    const error = new ApiError({ reason });
    const body = errorEnvelope(error);
    expect(body.error).toEqual({
      code,
      status,
      message: expect.any(String),
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "krun.io" }],
    });
  });
  it("never exposes unknown failures, causes, parser or validation diagnostics", () => {
    for (const error of [
      new Error("krun-test-private"),
      { _tag: "ApiError", reason: "KEY_MISSING", cause: "private" },
      { code: "FST_ERR_RESPONSE_SERIALIZATION", message: "private" },
      { statusCode: 400, message: "private" },
      null,
      undefined,
    ]) {
      expect(errorEnvelope(error)).toEqual(errorEnvelope(new ApiError({ reason: "INTERNAL" })));
    }
    for (const code of [
      "FST_ERR_VALIDATION",
      "FST_ERR_CTP_INVALID_JSON_BODY",
      "FST_ERR_CTP_EMPTY_JSON_BODY",
      "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
      "FST_ERR_BAD_URL",
    ]) {
      expect(errorEnvelope({ code, message: "private", validation: ["private"] })).toEqual(
        errorEnvelope(new ApiError({ reason: "REQUEST_INVALID" })),
      );
    }
  });
});
