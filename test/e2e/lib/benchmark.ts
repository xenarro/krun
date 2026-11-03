import { z } from "zod";

const observation = z.strictObject({
  name: z.string().min(1),
  submittedMs: z.number().finite().nonnegative(),
  runningMs: z.number().finite().nonnegative(),
  terminalMs: z.number().finite().nonnegative(),
  state: z.enum(["SUCCEEDED", "FAILED"]),
  exitMs: z.number().finite().nonnegative().optional(),
  failureReason: z.string().optional(),
});
export type BenchmarkObservation = z.infer<typeof observation>;

// Nearest rank: sort the complete population, then ceil(p*n)-1. No interpolation.
const percentile = (values: number[], p: number) => {
  values.sort((a, b) => a - b);
  const value = values[Math.ceil(p * values.length) - 1];
  if (value === undefined) throw new Error("Missing benchmark population");
  return value;
};
export const benchmarkSummary = (success: unknown, failure: unknown) => {
  const successes = z.array(observation).length(500).parse(success);
  const failures = z.array(observation).length(20).parse(failure);
  const all = [...successes, ...failures];
  if (
    new Set(all.map((v) => v.name)).size !== all.length ||
    all.some((v) => v.runningMs < v.submittedMs || v.terminalMs <= v.runningMs) ||
    successes.some((v) => v.state !== "SUCCEEDED" || v.failureReason !== undefined) ||
    failures.some(
      (v) =>
        v.state !== "FAILED" ||
        v.failureReason !== "EXIT_CODE" ||
        v.exitMs === undefined ||
        v.exitMs < v.runningMs ||
        v.exitMs > v.terminalMs,
    )
  )
    throw new Error("Invalid benchmark observation order, identity or outcome");
  const latency = successes.map((v) => v.runningMs - v.submittedMs);
  const detections = failures.map((v) => v.terminalMs - (v.exitMs ?? Number.NaN));
  const windowMs =
    Math.max(...successes.map((v) => v.terminalMs)) -
    Math.min(...successes.map((v) => v.submittedMs));
  return {
    successfulRuns: successes.length,
    durationSeconds: 10,
    submitToRunningMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    failureDetectionMs: { p95: percentile(detections, 0.95), samples: failures.length },
    sustainedRunsPerSecond: (successes.length * 1000) / windowMs,
    successWindowSeconds: windowMs / 1000,
  };
};

export const benchmarkAdmission = (value: { name: string; createdBy: string }, name: string) => {
  if (
    !/^krun-test-benchmark-[a-f0-9]{10}$/.test(name) ||
    value.name.split("/").slice(0, 3).join("/") !== `functions/${name}/runs` ||
    value.createdBy !== "e2e"
  )
    throw new Error("Benchmark admission is outside its exact Function/principal boundary");
};

export const terminalMetric = (text: string, name: string) => {
  const read = (suffix: string) => {
    const prefix = `krun_terminal_detect_seconds_${suffix}{function="${name}"} `;
    const lines = text.split("\n").filter((line) => line.startsWith(prefix));
    const literal = lines[0]?.slice(prefix.length).trim();
    // Prometheus finite decimal/exponent literals only; Number also accepts
    // absent values as zero and JavaScript-only hexadecimal/binary/octal forms.
    if (
      lines.length !== 1 ||
      literal === undefined ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(literal)
    )
      throw new Error("Missing or invalid exact-Function terminal metric");
    const value = Number(literal);
    if (!Number.isFinite(value) || value < 0)
      throw new Error("Missing or invalid exact-Function terminal metric");
    return value;
  };
  const count = read("count");
  if (!Number.isInteger(count)) throw new Error("Invalid terminal metric count");
  return { count, sumSeconds: read("sum") };
};
