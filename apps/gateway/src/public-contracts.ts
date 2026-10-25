import { z } from "zod";

const output = <T extends z.ZodType>(schema: T) =>
  schema.meta({ readOnly: true, "x-field-behavior": ["OUTPUT_ONLY"] });
const open = (values: readonly string[]) =>
  z
    .string()
    .describe(
      `Open enum; known values: ${values.join(", ")}. Unknown values must be treated as opaque strings.`,
    );
const time = z.iso
  .datetime({ precision: 3 })
  .describe("RFC3339 UTC timestamp with millisecond precision.");
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h)$/)
  .describe("Duration; installation/Function cap applies.");
// A record parser drops an own __proto__ key. Opaque JSON is not a krun-owned
// dictionary: preserve the object itself, with no copy or prototype assignment.
const data = z.custom<Record<string, unknown>>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
);
const runInput = data.meta({ "x-field-behavior": ["REQUIRED", "IMMUTABLE"] });
const functionInput = data.meta({
  readOnly: true,
  "x-field-behavior": ["OUTPUT_ONLY"],
  description: "JSON Schema2020-12 for Run.input; opaque schema document.",
});
const opaqueLeaves = new Set<z.core.$ZodType>([data, runInput, functionInput]);
export const publicContractProjection = ({ zodSchema }: { zodSchema: z.core.$ZodType }) =>
  opaqueLeaves.has(zodSchema)
    ? { type: "object" as const, additionalProperties: {} }
    : ("throw" as const);
const callback = z.strictObject({
  url: z.url().describe("Callback URL; existing host/address policy is enforced at admission."),
});
const result = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), data])
  .describe("Opaque JSON result. The root cannot be null; nested opaque JSON data is preserved.");
const source = open(["FUNCTION", "KUBERNETES", "KRUN"]);
const runError = z.strictObject({
  source,
  message: z.string(),
  type: z.string().optional(),
  details: data.optional(),
});
const summaryError = runError.omit({ details: true });
const runtimeStatus = z.strictObject({
  message: z.string(),
  progress: z.number().min(0).max(1).optional(),
  data: data.optional(),
  reportTime: time,
});
const jobStatus = z.strictObject({
  podName: z.string().optional(),
  phase: z.string().describe("Verbatim Kubernetes phase, not an enum.").optional(),
  reason: z.string().describe("Verbatim Kubernetes reason, not an enum.").optional(),
  message: z.string().optional(),
  exitCode: z.int32().optional(),
  observeTime: time,
});
const state = open([
  "QUEUED",
  "SCHEDULED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLING",
  "CANCELLED",
]);
const failure = open([
  "EXIT_CODE",
  "OOM_KILLED",
  "DEADLINE_EXCEEDED",
  "EVICTED",
  "DISRUPTED",
  "HEARTBEAT_TIMEOUT",
  "JOB_CREATE_FAILED",
  "JOB_LOST",
  "QUEUE_TIMEOUT",
]);
const summary = z.strictObject({
  name: output(
    z
      .string()
      .regex(
        /^functions\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
  ),
  state: output(state),
  attempt: output(z.int32().nonnegative()),
  priority: z
    .number()
    .int()
    .min(0)
    .max(9)
    .meta({ "x-field-behavior": ["OPTIONAL", "IMMUTABLE"] }),
  callback: callback.optional(),
  resultUri: output(z.string()).optional(),
  error: output(summaryError).optional(),
  failureReason: output(failure).optional(),
  runtimeStatus: output(runtimeStatus).optional(),
  jobStatus: output(jobStatus).optional(),
  jobName: output(z.string()).optional(),
  createdBy: output(z.string()),
  createTime: output(time),
  scheduleTime: output(time).optional(),
  startTime: output(time).optional(),
  endTime: output(time).optional(),
});
const run = summary
  .extend({
    input: runInput,
    result: output(result).optional(),
    error: output(runError).optional(),
    logTail: output(
      z.string().describe("Failed runs only; last 100 lines, at most 16KB."),
    ).optional(),
  })
  .describe(
    "FULL Run. Unset fields are omitted, never null; result and resultUri are mutually exclusive.",
  );
const functionResource = z.strictObject({
  name: output(z.string().regex(/^functions\/[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/)),
  inputSchema: functionInput,
  maxConcurrency: output(z.int32().nonnegative()),
  maxQueued: output(z.int32().nonnegative()),
  queueTimeout: output(duration),
  activeDeadlineSeconds: output(z.int32().positive()),
  heartbeatTimeout: output(duration).optional(),
  callback: output(callback).optional(),
  maxInputBytes: output(z.int32().positive()),
  maxResultBytes: output(z.int32().positive()),
  maxWait: output(duration),
});
const reason = open([
  "REQUEST_INVALID",
  "INPUT_SCHEMA_VIOLATION",
  "FILTER_INVALID",
  "CALLBACK_NOT_ALLOWED",
  "RUN_TERMINAL",
  "RUN_NOT_TERMINAL",
  "KEY_MISSING",
  "KEY_INVALID",
  "SCOPE_MISSING",
  "ROUTE_NOT_FOUND",
  "FUNCTION_NOT_FOUND",
  "RUN_NOT_FOUND",
  "RESULT_MISSING",
  "IDEMPOTENCY_CONFLICT",
  "INPUT_TOO_LARGE",
  "CONTENT_TYPE_UNSUPPORTED",
  "RATE_LIMITED",
  "QUEUE_FULL",
  "INTERNAL",
  "NOT_READY",
]);
const errorInfo = z.strictObject({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  reason,
  domain: z.literal("krun.io"),
  metadata: z.record(z.string(), z.string()).optional(),
});
const badRequest = z.strictObject({
  "@type": z.literal("type.googleapis.com/google.rpc.BadRequest"),
  fieldViolations: z.array(z.strictObject({ field: z.string(), description: z.string() })),
});
const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.int32(),
    message: z.string().describe("Generic public message; never internals or credentials."),
    status: open([
      "INVALID_ARGUMENT",
      "FAILED_PRECONDITION",
      "UNAUTHENTICATED",
      "PERMISSION_DENIED",
      "NOT_FOUND",
      "ABORTED",
      "RESOURCE_EXHAUSTED",
      "INTERNAL",
      "UNAVAILABLE",
    ]),
    details: z.tuple([errorInfo]).rest(badRequest),
  }),
});
export const publicSchemas = {
  Callback: callback,
  Result: result,
  RunError: runError,
  RuntimeStatus: runtimeStatus,
  JobStatus: jobStatus,
  Function: functionResource,
  RunSummary: summary,
  Run: run,
  ErrorInfo: errorInfo,
  BadRequest: badRequest,
  ErrorEnvelope: errorEnvelope,
};

// Read-only metadata alone does not ignore request values. A nested codec
// discards recognized output fields before the handler, without wrapping the
// strict request root in a transform or weakening writable/unknown/null checks.
// Encoding absence is supported too; no unidirectional transform is introduced.
const ignoredOutput = z
  .codec(result.optional(), z.undefined(), {
    decode: () => undefined,
    encode: () => undefined,
  })
  .meta({
    readOnly: true,
    "x-field-behavior": ["OUTPUT_ONLY"],
    description: "Recognized output-only member. Any non-null JSON value is ignored.",
  });
const ignoredOutputs = {
  name: ignoredOutput,
  state: ignoredOutput,
  attempt: ignoredOutput,
  resultUri: ignoredOutput,
  error: ignoredOutput,
  failureReason: ignoredOutput,
  runtimeStatus: ignoredOutput,
  jobStatus: ignoredOutput,
  jobName: ignoredOutput,
  createdBy: ignoredOutput,
  createTime: ignoredOutput,
  scheduleTime: ignoredOutput,
  startTime: ignoredOutput,
  endTime: ignoredOutput,
  result: ignoredOutput,
  logTail: ignoredOutput,
} satisfies Record<
  Exclude<keyof z.output<typeof run>, "input" | "priority" | "callback">,
  typeof ignoredOutput
>;

const label = z
  .string()
  .regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/)
  .describe("DNS1123 Function name.");
const wildcard = z
  .union([label, z.literal("-")])
  .describe("Function name, or '-' for cross-function lookup under the same ownership policy.");
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const functionParams = z.strictObject({ function: label });
const parentParams = z.strictObject({ function: wildcard });
const runParams = z.strictObject({ function: wildcard, run: uuid });
const empty = z.strictObject({});
const pages = {
  pageSize: z.coerce
    .number()
    .int()
    .min(0)
    .describe("Default 50 when absent or 0; values above 200 are capped at 200, not rejected.")
    .optional(),
  pageToken: z
    .string()
    .describe("Opaque cursor bound to parent/filter;empty on the last page.")
    .optional(),
};
const errors = {
  400: errorEnvelope,
  401: errorEnvelope,
  403: errorEnvelope,
  404: errorEnvelope,
  415: errorEnvelope,
  500: errorEnvelope,
  503: errorEnvelope,
};
const base = "/v1/functions/:function/runs/:run([^:]+)";
const schema = (operationId: string, scope: string) => ({
  operationId,
  summary: operationId,
  security: [{ bearerAuth: [] }],
  "x-krun-scope": scope,
  tags: ["Public v1"],
});
export const publicContracts = {
  ListFunctions: {
    method: "GET",
    url: "/v1/functions",
    config: { krun: { scope: "functions:read" } },
    schema: {
      ...schema("ListFunctions", "functions:read"),
      querystring: z.strictObject(pages),
      response: {
        ...errors,
        200: z.strictObject({ functions: z.array(functionResource), nextPageToken: z.string() }),
      },
    },
  },
  GetFunction: {
    method: "GET",
    url: "/v1/functions/:function",
    config: { krun: { scope: "functions:read", functionParam: "function" } },
    schema: {
      ...schema("GetFunction", "functions:read"),
      params: functionParams,
      querystring: empty,
      response: { ...errors, 200: functionResource },
    },
  },
  CreateRun: {
    method: "POST",
    url: "/v1/functions/:function/runs",
    config: { krun: { scope: "runs:write", functionParam: "function" } },
    schema: {
      ...schema("CreateRun", "runs:write"),
      description:
        "Create or replay a FULL Run; output-only body fields are ignored. Admission and per-Function schema/priority/callback/quota policy apply. Disconnect does not cancel the run.",
      params: functionParams,
      querystring: z.strictObject({
        requestId: z.string().max(128).optional(),
        wait: duration.optional(),
      }),
      body: z.strictObject({
        ...ignoredOutputs,
        input: data,
        priority: z.int32().min(0).max(9).default(0),
        callback: callback.optional(),
      }),
      response: { ...errors, 201: run, 409: errorEnvelope, 413: errorEnvelope, 429: errorEnvelope },
    },
  },
  GetRun: {
    method: "GET",
    url: base,
    config: { krun: { scope: "runs:read" } },
    schema: {
      ...schema("GetRun", "runs:read"),
      params: runParams,
      querystring: z.strictObject({ view: z.enum(["BASIC", "FULL"]).default("FULL") }),
      response: { ...errors, 200: z.union([run, summary]) },
    },
  },
  ListRuns: {
    method: "GET",
    url: "/v1/functions/:function/runs",
    config: { krun: { scope: "runs:read" } },
    schema: {
      ...schema("ListRuns", "runs:read"),
      description:
        "BASIC runs ordered createTime desc,UUIDv7 desc. filter accepts state (=,!=),createTime (>=,<=,>,<),failureReason (=),joined with AND;quoted RFC3339 timestamps;no orderBy or view.",
      params: parentParams,
      querystring: z.strictObject({ ...pages, filter: z.string().optional() }),
      response: {
        ...errors,
        200: z.strictObject({ runs: z.array(summary), nextPageToken: z.string() }),
      },
    },
  },
  WaitRun: {
    method: "POST",
    url: `${base}::wait`,
    config: { krun: { scope: "runs:read" } },
    schema: {
      ...schema("WaitRun", "runs:read"),
      description:
        "FULL Run at terminal state,timeout or earlier shutdown. Missing timeout defaults to Function.maxWait; values capped to the same limit;timeout is not an error.",
      params: runParams,
      querystring: empty,
      body: z.strictObject({ timeout: duration.optional() }),
      response: { ...errors, 200: run },
    },
  },
  CancelRun: {
    method: "POST",
    url: `${base}::cancel`,
    config: { krun: { scope: "runs:write" } },
    schema: {
      ...schema("CancelRun", "runs:write"),
      description:
        "Best-effort idempotent cancellation;FULL Run. Repeated CANCELLING/CANCELLED is200,no new transition;SUCCEEDED/FAILED is400 RUN_TERMINAL.",
      params: runParams,
      querystring: empty,
      body: empty,
      response: { ...errors, 200: run },
    },
  },
  GetRunResult: {
    method: "GET",
    url: `${base}::getResult`,
    config: { krun: { scope: "runs:read" } },
    schema: {
      ...schema("GetRunResult", "runs:read"),
      description:
        "Inline JSON value, not a Run wrapper;failed/cancelled runs can retain results. Nonterminal400 RUN_NOT_TERMINAL;missing result404 RESULT_MISSING.307 URL valid 300s;follow without Authorization/krun headers and never store it.",
      params: runParams,
      querystring: empty,
      response: {
        ...errors,
        200: result,
        307: z.never().describe("External presigned result URL;no response body."),
      },
    },
  },
  WatchRun: {
    method: "GET",
    url: `${base}::watch`,
    config: { krun: { scope: "runs:read" } },
    schema: {
      ...schema("WatchRun", "runs:read"),
      description:
        "SSE state/status/job_status events carry BASIC Run JSON; id is the changed group's timestamp. Initial state snapshot,close after terminal/shutdown; Last-Event-ID ignored;15s keepalive comments. Nonterminal disconnect is not an error.",
      params: runParams,
      querystring: empty,
      response: {
        ...errors,
        200: {
          description: "Server-sent BASIC Run events.",
          content: { "text/event-stream": { schema: z.string() } },
        },
      },
    },
  },
} as const;
