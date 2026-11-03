import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type BenchmarkObservation,
  benchmarkSummary,
  terminalMetric,
} from "../test/e2e/lib/benchmark.js";
import { scenario } from "../test/e2e/lib/harness.js";

// A real-system measurement tool, separate from Vitest and make e2e.
// make bench-build emits this at dist/bench/scripts/bench.js.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scope = scenario("benchmark", undefined, root);
const now = () => performance.timeOrigin + performance.now();
let stopped = false;
const interrupted = () => {
  stopped = true;
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const check = (ok: unknown, message: string): void => {
  if (!ok) throw new Error(message);
};
const take = async (failure: boolean): Promise<BenchmarkObservation> => {
  check(!stopped, "Benchmark interrupted");
  const submittedMs = now();
  const created = await scope.submit(failure ? { fail: true } : {});
  let current = created;
  const deadline = performance.now() + 120_000;
  // First actual public RUNNING observation, not a backdated Pod timestamp.
  while (current.state !== "RUNNING") {
    check(!stopped && performance.now() < deadline, "Benchmark RUNNING observation expired");
    check(
      ["QUEUED", "SCHEDULED"].includes(current.state),
      "Benchmark missed RUNNING or failed early",
    );
    await setTimeout(200);
    current = await scope.get(created);
    check(
      current.name === created.name && current.createdBy === created.createdBy,
      "Benchmark identity changed",
    );
  }
  const runningMs = now();
  do {
    check(!stopped && performance.now() < deadline, "Benchmark terminal observation expired");
    current = await scope.wait(created);
    check(
      current.name === created.name && current.createdBy === created.createdBy,
      "Benchmark terminal identity changed",
    );
  } while (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(current.state));
  const terminalMs = now();
  check(
    current.state === (failure ? "FAILED" : "SUCCEEDED"),
    "Unexpected benchmark terminal state",
  );
  check(
    !failure || current.failureReason === "EXIT_CODE",
    "Benchmark failed for a reason other than actual exit1",
  );
  return {
    name: created.name,
    submittedMs,
    runningMs,
    terminalMs,
    state: failure ? "FAILED" : "SUCCEEDED",
    ...(failure
      ? { exitMs: await scope.benchmarkExit(created), failureReason: current.failureReason }
      : {}),
  };
};
const batch = async (count: number, failure: boolean) => {
  const observations: BenchmarkObservation[] = [];
  let cursor = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: 10 }, async () => {
      try {
        for (;;) {
          if (stopped || cursor++ >= count) return;
          observations.push(await take(failure));
          if (observations.length % 50 === 0)
            console.log(
              JSON.stringify({
                benchmarkProgress: observations.length,
                population: count,
                failure,
              }),
            );
        }
      } catch {
        stopped = true;
        throw new Error("Benchmark worker failed; private response withheld");
      }
    }),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  check(observations.length === count, "Benchmark population incomplete");
  return observations;
};
const metric = () => {
  const { name } = scope.benchmarkIdentity();
  const series = scope
    .benchmarkMetrics()
    .filter((text) => text.includes(`krun_terminal_detect_seconds_count{function="${name}"}`));
  check(series.length > 0, "No scheduler exposed this Function's actual terminal histogram");
  return series
    .map((text) => terminalMetric(text, name))
    .reduce((a, b) => ({ count: a.count + b.count, sumSeconds: a.sumSeconds + b.sumSeconds }), {
      count: 0,
      sumSeconds: 0,
    });
};
let result: unknown;
let failed = false;
let stage = "setup";
try {
  await scope.up();
  // One excluded warmup caches the exact image and establishes positive metrics.
  stage = "excluded-warmup";
  await take(false);
  stage = "baseline-histogram";
  const baseline = metric();
  stage = "500-success-observations";
  const success = await batch(500, false);
  stage = "success-histogram";
  const beforeFailure = metric();
  stage = "20-failure-observations";
  const failure = await batch(20, true);
  stage = "failure-histogram";
  const afterFailure = metric();
  check(
    beforeFailure.count - baseline.count === 500 &&
      afterFailure.count - beforeFailure.count === 20 &&
      afterFailure.sumSeconds >= beforeFailure.sumSeconds,
    "Benchmark histogram population/reset mismatch",
  );
  result = {
    benchmark: "krun-kind-500x10s",
    ...scope.benchmarkIdentity(),
    ...benchmarkSummary(success, failure),
    conditions: {
      source:
        process.env.GITHUB_ACTIONS === "true" ? "GitHub Actions" : "local kind (not a CI runner)",
      kubernetesNodes: 1,
      workers: 10,
      maxConcurrency: 10,
      excludedWarmups: 1,
      imageCachedAfterWarmup: true,
      observation:
        "GetRun every 200ms until first RUNNING; WaitRun until terminal; no mutation retries",
      failureClock:
        "client terminal observation minus actual native container finishedAt; kind/host wall clocks must agree",
      cpus: cpus().length,
      availableParallelism: availableParallelism(),
      cpuModel: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtEnd: freemem(),
      node: process.version,
      percentile: "nearest rank over complete population",
      load: "closed loop, 10 workers; not a 500-at-once burst or maximum capacity claim",
    },
    terminalMetric: {
      baseline,
      beforeFailure,
      afterFailure,
      failureDelta: {
        count: afterFailure.count - beforeFailure.count,
        sumSeconds: afterFailure.sumSeconds - beforeFailure.sumSeconds,
      },
    },
    // Sanitized raw observations make every percentile and denominator auditable.
    observations: { success, failure },
  };
} catch {
  failed = true;
  process.stderr.write(
    `Benchmark failed during ${stage}; private input, responses and credentials withheld\n`,
  );
} finally {
  try {
    await scope.close();
  } catch {
    failed = true;
    process.stderr.write("Owned benchmark cleanup failed\n");
  }
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}
if (failed) process.exitCode = 1;
else console.log(JSON.stringify({ ...(result as object), ownedCleanupVerified: true }));
