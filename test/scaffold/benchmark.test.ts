import { describe, expect, it } from "vitest";
import { benchmarkAdmission, benchmarkSummary, terminalMetric } from "../e2e/lib/benchmark.ts";

const batch = (count: number, failure = false) =>
  Array.from({ length: count }, (_, i) => ({
    name: `functions/krun-test-benchmark/runs/${failure ? "f" : "s"}-${i}`,
    submittedMs: i * 100,
    runningMs: i * 100 + 200 + i,
    terminalMs: i * 100 + 11_000 + i,
    state: failure ? "FAILED" : "SUCCEEDED",
    ...(failure ? { exitMs: i * 100 + 10_500, failureReason: "EXIT_CODE" } : {}),
  }));

describe("real benchmark evidence", () => {
  it("binds admission to the exact generated Function and expected principal before teardown ownership", () => {
    const name = "krun-test-benchmark-012345abcd";
    expect(() =>
      benchmarkAdmission({ name: `functions/${name}/runs/id`, createdBy: "e2e" }, name),
    ).not.toThrow();
    expect(() =>
      benchmarkAdmission({ name: "functions/foreign/runs/id", createdBy: "e2e" }, name),
    ).toThrow();
    expect(() =>
      benchmarkAdmission({ name: `functions/${name}/runs/id`, createdBy: "foreign" }, name),
    ).toThrow();
    expect(() =>
      benchmarkAdmission({ name: `functions/${name}/runs/id`, createdBy: "e2e" }, "foreign"),
    ).toThrow();
  });
  it("uses nearest-rank percentiles and the complete wall window, not submit rate", () => {
    const result = benchmarkSummary(batch(500), batch(20, true));
    expect(result.submitToRunningMs).toEqual({ p50: 449, p95: 674 });
    expect(result.failureDetectionMs).toEqual({ p95: 518, samples: 20 });
    expect(result.sustainedRunsPerSecond).toBeCloseTo(500 / 61.399, 8);
    expect(result.successfulRuns).toBe(500);
    expect(result.durationSeconds).toBe(10);
  });
  it.each([0, 499, 501])("rejects incomplete or surplus success samples: %s", (n) => {
    expect(() => benchmarkSummary(batch(n), batch(20, true))).toThrow();
  });
  it.each([0, 19, 21])("rejects incomplete or surplus crash samples: %s", (n) => {
    expect(() => benchmarkSummary(batch(500), batch(n, true))).toThrow();
  });
  it.each(["duplicate", "running", "terminal", "finite", "state", "exit", "reason"])(
    "fails closed on %s evidence corruption",
    (fault) => {
      const success = batch(500);
      const failures = batch(20, true);
      const first = success[0];
      const fail = failures[0];
      if (!first || !fail) throw new Error("Missing test fixture");
      if (fault === "duplicate") first.name = success[1]?.name ?? "";
      if (fault === "running") first.runningMs = first.submittedMs - 1;
      if (fault === "terminal") first.terminalMs = first.runningMs;
      if (fault === "finite") first.runningMs = Number.NaN;
      if (fault === "state") first.state = "FAILED";
      if (fault === "exit") fail.exitMs = fail.terminalMs + 1;
      if (fault === "reason") fail.failureReason = "job_lost";
      expect(() => benchmarkSummary(success, failures)).toThrow();
    },
  );
  it("reads only exact Function histogram series, preserving sums and counts", () => {
    expect(
      terminalMetric(
        'krun_terminal_detect_seconds_sum{function="krun-test-benchmark"} 1.5\nkrun_terminal_detect_seconds_count{function="krun-test-benchmark"} 20\nkrun_terminal_detect_seconds_count{function="other"} 999',
        "krun-test-benchmark",
      ),
    ).toEqual({ count: 20, sumSeconds: 1.5 });
  });
  it.each([
    ["empty-sum", "20", ""],
    ["blank-sum", "20", "   "],
    ["hex-sum", "20", "0x10"],
    ["empty-count", "", "1.5"],
    ["hex-count", "0x14", "1.5"],
    ["blank-count", "\t", "1.5"],
    ["binary-count", "0b10100", "1.5"],
    ["octal-sum", "20", "0o10"],
    ["overflow-sum", "20", "1e309"],
    ["negative-sum", "20", "-1"],
    ["fractional-count", "2.5", "1.5"],
  ])("rejects malformed or invalid exact-Function metric evidence: %s", (_label, count, sum) => {
    const text = `krun_terminal_detect_seconds_count{function="krun-test-benchmark"} ${count}\nkrun_terminal_detect_seconds_sum{function="krun-test-benchmark"} ${sum}`;
    expect(() => terminalMetric(text, "krun-test-benchmark")).toThrow();
  });
  it.each([
    ["zero", "0", "0", 0, 0],
    ["decimal", "20", "1.5", 20, 1.5],
    ["exponent", "2e1", "1.5e0", 20, 1.5],
    ["signed-exponent", "+2E+1", "+.15E1", 20, 1.5],
    ["decimal-point", "20.", ".5", 20, 0.5],
  ] as const)(
    "retains valid finite Prometheus numbers: %s",
    (_label, count, sum, countValue, sumValue) => {
      const text = `krun_terminal_detect_seconds_count{function="krun-test-benchmark"} ${count}\nkrun_terminal_detect_seconds_sum{function="krun-test-benchmark"} ${sum}`;
      expect(terminalMetric(text, "krun-test-benchmark")).toEqual({
        count: countValue,
        sumSeconds: sumValue,
      });
    },
  );
  it.each(["", 'krun_terminal_detect_seconds_count{function="krun-test-benchmark"} NaN'])(
    "missing or nonfinite histogram evidence is not zero",
    (text) => expect(() => terminalMetric(text, "krun-test-benchmark")).toThrow(),
  );
});
