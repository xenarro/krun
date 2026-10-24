import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import { failureReasons, type Run, states, toRun, toRunSummary } from "./index.js";

const at = DateTime.makeUnsafe("2026-10-24T03:00:00.123Z");
const time = "2026-10-24T03:00:00.123Z";
const row = (patch: Partial<Run> = {}): Run => ({
  id: "019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  function_name: "report-generator",
  idempotency_key: null,
  request_hash: "test-request-hash",
  input: { nested: { value: null } },
  state: "queued",
  priority: 0,
  attempt: 0,
  lease_owner: null,
  lease_until: null,
  job_name: null,
  job_token_hash: null,
  result: null,
  result_ref: null,
  error: null,
  log_tail: null,
  failure_reason: null,
  runtime_status: null,
  job_status: null,
  callback_url: null,
  created_by: "test-client",
  created_at: at,
  scheduled_at: null,
  started_at: null,
  finished_at: null,
  ...patch,
});

const basic = {
  name: "functions/report-generator/runs/019a1c0e-7b3e-7c9a-9f3a-2b1d4e5f6a7b",
  state: "QUEUED",
  priority: 0,
  attempt: 0,
  createdBy: "test-client",
  createTime: time,
};

describe("canonical Store row-to-wire mappers", () => {
  it("renders the exact minimal FULL/BASIC views and omits null columns", () => {
    expect(toRun(row())).toStrictEqual({ ...basic, input: { nested: { value: null } } });
    expect(toRunSummary(row())).toStrictEqual(basic);
  });

  it("renders every public field without exposing persistence columns", () => {
    const input = row({
      state: "failed",
      attempt: 2,
      priority: 9,
      lease_owner: "test-scheduler",
      lease_until: at,
      job_token_hash: "test-token-hash",
      idempotency_key: "test-request-id",
      callback_url: "https://example.test/hook",
      result_ref: "s3://krun-test-results/runs/test/result.json",
      job_name: "krun-test-job",
      scheduled_at: at,
      started_at: at,
      finished_at: at,
      failure_reason: "oom_killed",
      log_tail: "test log",
      error: {
        source: "function",
        message: "test failure",
        type: "Custom.Type",
        details: { secret: "test-detail" },
      },
      runtime_status: { message: "test status", progress: 0, data: { nested: null }, at },
      job_status: {
        podName: "test-pod",
        phase: "Failed",
        reason: "OOMKilled",
        message: "test pod",
        exitCode: 0,
        observedAt: at,
      },
    });
    const expected = {
      ...basic,
      state: "FAILED",
      attempt: 2,
      priority: 9,
      callback: { url: "https://example.test/hook" },
      resultUri: "s3://krun-test-results/runs/test/result.json",
      jobName: "krun-test-job",
      scheduleTime: time,
      startTime: time,
      endTime: time,
      failureReason: "OOM_KILLED",
      error: { source: "FUNCTION", message: "test failure", type: "Custom.Type" },
      runtimeStatus: {
        message: "test status",
        progress: 0,
        data: { nested: null },
        reportTime: time,
      },
      jobStatus: {
        podName: "test-pod",
        phase: "Failed",
        reason: "OOMKilled",
        message: "test pod",
        exitCode: 0,
        observeTime: time,
      },
    };
    expect(toRunSummary(input)).toStrictEqual(expected);
    expect(toRun(input)).toStrictEqual({
      ...expected,
      input: input.input,
      logTail: "test log",
      error: { ...expected.error, details: { secret: "test-detail" } },
    });
    expect(input.error?.source).toBe("function");
    expect(input.runtime_status?.at).toBe(at);
    expect(input.job_status?.observedAt).toBe(at);
  });

  it.each(states)("renders the %s state", (state) => {
    expect(toRunSummary(row({ state })).state).toBe(state.toUpperCase());
  });

  it.each(failureReasons)("renders the %s failure reason", (failure_reason) => {
    expect(toRunSummary(row({ state: "failed", failure_reason })).failureReason).toBe(
      failure_reason.toUpperCase(),
    );
  });

  it.each(["function", "kubernetes", "krun"] as const)(
    "renders %s error sources without changing origin strings",
    (source) => {
      expect(
        toRunSummary(row({ error: { source, message: "", type: "MixedCase" } })).error,
      ).toStrictEqual({ source: source.toUpperCase(), message: "", type: "MixedCase" });
    },
  );

  it.each([false, 0, "", [], {}])(
    "preserves non-null inline JSON result %j in FULL only",
    (result) => {
      const input = row({ result });
      expect(toRun(input).result).toEqual(result);
      expect(toRunSummary(input)).not.toHaveProperty("result");
    },
  );

  it("does not read FULL-only columns or details for BASIC, including projected database rows", () => {
    const projected = row({ error: { source: "krun", message: "test" } });
    for (const key of ["input", "result", "log_tail"]) {
      Object.defineProperty(projected, key, {
        get: () => {
          throw new Error("BASIC read a FULL-only column");
        },
      });
    }
    Object.defineProperty(projected.error, "details", {
      get: () => {
        throw new Error("BASIC read error details");
      },
    });
    expect(toRunSummary(projected)).toStrictEqual({
      ...basic,
      error: { source: "KRUN", message: "test" },
    });
  });

  it("preserves opaque own keys and nested JSON without mutating or rebuilding them", () => {
    const opaque = JSON.parse('{"__proto__":{"test":true},"constructor":0,"nested":null}');
    const input = Object.freeze(
      row({
        input: opaque,
        result: opaque,
        error: Object.freeze({ source: "function", message: "test", details: opaque }),
      }),
    );
    const full = toRun(input);
    expect(full.input).toBe(opaque);
    expect(full.result).toBe(opaque);
    expect(full.error?.details).toBe(opaque);
    expect(Object.hasOwn(full.input, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(opaque)).toBe(Object.prototype);
    expect(toRunSummary(input).error).not.toHaveProperty("details");
  });

  it("handles minimal optional status/error groups and null-prototype database records", () => {
    const input: Run = Object.assign(
      Object.create(null),
      row({
        runtime_status: { message: "test", at },
        job_status: { observedAt: at },
        error: { source: "kubernetes", message: "test" },
        log_tail: "",
      }),
    );
    expect(toRun(input)).toStrictEqual({
      ...basic,
      input: input.input,
      runtimeStatus: { message: "test", reportTime: time },
      jobStatus: { observeTime: time },
      error: { source: "KUBERNETES", message: "test" },
      logTail: "",
    });
  });
});
