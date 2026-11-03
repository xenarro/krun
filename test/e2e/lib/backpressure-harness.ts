import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { publicSchemas } from "../../../apps/gateway/src/public-contracts.js";
import {
  admissionVerdict,
  backpressureKey,
  jobOccupancy,
  pressureJobSchema,
  schedulerMetricsScript,
} from "./backpressure.js";
import { contextArgs } from "./contracts.js";
import { eventually } from "./wait.js";

type Run = z.infer<typeof publicSchemas.Run>;
const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const decode = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid private backpressure evidence");
  return parsed.data;
};
const terminal = (run: { state: string }) =>
  ["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.state);

// Real API/Kubernetes adapters are supplied by the existing owned scenario.
// Bulk queued runs are tracked separately from its live credential witnesses.
export const backpressureAcceptance = (options: {
  name: string;
  namespace: string;
  jobsNamespace: string;
  kubeconfig: string;
  url: string;
  key: string;
  mode: string;
  kube: (args: string[], operation: string, input?: string) => string;
  children: ChildProcess[];
  live: (run: Run) => void;
}) => {
  const { name, namespace, jobsNamespace, kube, url, key } = options;
  const selector = `krun.io/function=${name}`;
  const quotaName = `${name}-quota`;
  const owned = new Set<string>();
  const jobs = new Map<string, z.infer<typeof pressureJobSchema>>();
  const seen = new Set<string>();
  let watchBroken = false;
  let closing = false;
  let quotaOwned = false;
  let maximum = 0;
  let events = 0;
  let watch: ChildProcess | undefined;
  let watchDone: Promise<void> = Promise.resolve();
  const healthy = () =>
    check(!watchBroken, "Backpressure Job watch failed; absence is not evidence");
  const observe = () => {
    healthy();
    const count = jobOccupancy([...jobs.values()], name);
    maximum = Math.max(maximum, count);
    check(count <= 5, "Function exceeded five nonterminal native Jobs");
    return count;
  };
  const request = async (path: string, method = "GET", body?: unknown, capped = false) => {
    let response: Response;
    let value: unknown;
    try {
      response = await fetch(`${url}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${capped ? backpressureKey(key) : key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      value = await response.json();
    } catch {
      throw new Error("Private backpressure API transport failed; mutation is not replayed");
    }
    return { status: response.status, retry: response.headers.get("retry-after"), value };
  };
  const get = async (path: string) => {
    const result = await request(path);
    check(result.status === 200, "Backpressure GetRun failed; private body withheld");
    return decode(publicSchemas.Run, result.value);
  };
  const list = async () => {
    const values: z.infer<typeof publicSchemas.RunSummary>[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    do {
      const query = new URLSearchParams({
        pageSize: "200",
        ...(token ? { pageToken: token } : {}),
      });
      const result = await request(`functions/${name}/runs?${query}`);
      check(result.status === 200, "Backpressure ListRuns failed");
      const page = decode(
        z.object({ runs: z.array(publicSchemas.RunSummary), nextPageToken: z.string().optional() }),
        result.value,
      );
      values.push(...page.runs);
      token = page.nextPageToken;
      check(!token || !tokens.has(token), "Backpressure pagination repeated a token");
      if (token) tokens.add(token);
    } while (token);
    check(
      new Set(values.map((run) => run.name)).size === values.length &&
        values.every((run) => owned.has(run.name)),
      "Backpressure inventory has duplicate or unowned Runs",
    );
    return values;
  };
  const cancel = async (names: readonly string[]) => {
    let cursor = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        for (;;) {
          const path = names[cursor++];
          if (!path) return;
          const result = await request(`${path}:cancel`, "POST", {});
          if (result.status !== 200) {
            // A real terminal race is allowed, never transport/permission failure.
            const current = await get(path);
            check(terminal(current), "Backpressure cancellation failed");
          } else
            check(
              ["CANCELLING", "CANCELLED"].includes(decode(publicSchemas.Run, result.value).state),
              "Cancellation was not accepted",
            );
        }
      }),
    );
    // A failed mutation is not replayed; every sibling must finish before the
    // caller may unwind into another cleanup sweep or a fresh runner attempt.
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  };
  const allTerminal = async () =>
    eventually(
      list,
      (runs) => (runs.length === owned.size && runs.every(terminal) ? "done" : "wait"),
      "Bulk owned cancellation readback",
      120_000,
      500,
    );
  const quota = async () => {
    const pods = decode(
      z.object({
        items: z.array(
          z.object({
            metadata: z.object({ name: z.string() }),
            spec: z.object({ containers: z.array(z.object({ name: z.string() })) }),
          }),
        ),
      }),
      JSON.parse(
        kube(["get", "pods", "-n", namespace, "-o", "json"], "Read actual scheduler replicas"),
      ),
    );
    let sum = 0;
    for (const pod of pods.items.filter((pod) =>
      pod.spec.containers.some((container) => container.name === "scheduler"),
    )) {
      const text = kube(
        [
          "exec",
          "-n",
          namespace,
          pod.metadata.name,
          "-c",
          "scheduler",
          "--",
          "/nodejs/bin/node",
          "-e",
          schedulerMetricsScript,
        ],
        "Observe scheduler quota counter",
      );
      for (const line of text.split("\n"))
        if (
          line.startsWith("krun_quota_rejections_total{") &&
          line.includes(`function="${name}"`)
        ) {
          const value = Number(line.split(" ").at(-1));
          check(Number.isFinite(value) && value >= 0, "Invalid quota counter");
          sum += value;
        }
    }
    check(
      pods.items.some((pod) =>
        pod.spec.containers.some((container) => container.name === "scheduler"),
      ),
      "No native scheduler metric witness",
    );
    return sum;
  };
  const startWatch = () => {
    const list = decode(
      z.object({
        metadata: z.object({ resourceVersion: z.string() }),
        items: z.array(pressureJobSchema),
      }),
      JSON.parse(
        kube(
          ["get", "jobs", "-n", jobsNamespace, "-l", selector, "-o", "json"],
          "Anchor complete native Job watch",
        ),
      ),
    );
    check(list.items.length === 0, "Backpressure starts with unexpected Jobs");
    const query = new URLSearchParams({
      watch: "true",
      resourceVersion: list.metadata.resourceVersion,
      labelSelector: selector,
      allowWatchBookmarks: "true",
    });
    watch = spawn(
      "kubectl",
      [
        ...contextArgs(options.kubeconfig),
        "get",
        "--raw",
        `/apis/batch/v1/namespaces/${jobsNamespace}/jobs?${query}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    options.children.push(watch);
    const child = watch;
    watchDone = new Promise<void>((resolve) => child.once("close", () => resolve()));
    watch.stderr?.resume();
    watch.on("error", () => {
      watchBroken = true;
    });
    watch.on("exit", () => {
      if (!closing) watchBroken = true;
    });
    let buffer = "";
    watch.stdout?.on("error", () => {
      watchBroken = true;
    });
    watch.stdout?.on("end", () => {
      if (buffer.trim()) watchBroken = true;
    });
    watch.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        watchBroken = true;
        return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = decode(
            z.object({
              type: z.enum(["ADDED", "MODIFIED", "DELETED", "BOOKMARK"]),
              object: z.unknown(),
            }),
            JSON.parse(line),
          );
          if (event.type === "BOOKMARK") continue;
          const job = decode(pressureJobSchema, event.object);
          check(job.metadata.labels["krun.io/function"] === name, "Foreign Job in native watch");
          if (event.type === "DELETED") jobs.delete(job.metadata.uid);
          else {
            jobs.set(job.metadata.uid, job);
            seen.add(job.metadata.uid);
          }
          events++;
          observe();
        } catch {
          watchBroken = true;
        }
      }
    });
  };
  const submit = async (capped: boolean, input: unknown) => {
    const result = await request(`functions/${name}/runs`, "POST", { input }, capped);
    if (result.status === 201) {
      const run = decode(publicSchemas.Run, result.value);
      check(
        run.name.startsWith(`functions/${name}/runs/`) &&
          !owned.has(run.name) &&
          run.state === "QUEUED",
        "Invalid newly admitted backpressure Run",
      );
      owned.add(run.name);
      return run;
    }
    admissionVerdict(result.status, result.retry, result.value, capped ? "key" : "function");
    return undefined;
  };
  const removeQuota = () => {
    kube(
      ["delete", "resourcequota", quotaName, "-n", jobsNamespace, "--wait=true"],
      "Remove only scenario quota",
    );
    check(
      !kube(
        [
          "get",
          "resourcequota",
          quotaName,
          "-n",
          jobsNamespace,
          "--ignore-not-found",
          "-o",
          "json",
        ],
        "Read back scenario quota deletion",
      ).trim(),
      "Scenario quota remained",
    );
    quotaOwned = false;
  };
  return {
    async run(input: unknown) {
      startWatch();
      quotaOwned = true; // Own even a partially successful apply.
      kube(
        ["apply", "-f", "-"],
        "Apply actual native Job-count quota",
        JSON.stringify({
          apiVersion: "v1",
          kind: "ResourceQuota",
          metadata: { name: quotaName, namespace: jobsNamespace },
          spec: { hard: { "count/jobs.batch": "0" } },
        }),
      );
      await eventually(
        async () =>
          JSON.parse(
            kube(
              ["get", "resourcequota", quotaName, "-n", jobsNamespace, "-o", "json"],
              "Await enforced native quota",
            ),
          ),
        (value) =>
          decode(
            z.object({ status: z.object({ hard: z.record(z.string(), z.string()) }).optional() }),
            value,
          ).status?.hard["count/jobs.batch"] === "0"
            ? "done"
            : "wait",
        "Native zero-Job quota",
      );
      const capped: Run[] = [];
      for (let index = 0; index < 10; index++) {
        const run = await submit(true, input);
        check(run, "Key queue cap rejected before ten");
        if (run) capped.push(run);
      }
      check((await submit(true, input)) === undefined, "Key accepted its eleventh queued Run");
      const initial = await list();
      check(
        initial.length === 10 &&
          initial.every((run) => run.state === "QUEUED" && run.createdBy === "e2e-backpressure"),
        "Key queue cap lacks exact durable evidence",
      );
      await cancel(capped.map((run) => run.name));
      await allTerminal();
      const accepted: Run[] = [];
      let rejected = 0;
      // Deliberately sequential admission gives an exact cap witness, not a
      // count/check race or a rate-limit benchmark across gateway replicas.
      for (let index = 0; index < 3000; index++) {
        const run = await submit(false, input);
        if (run) {
          check(index < 1000, "Function accepted after the queued cap");
          accepted.push(run);
        } else {
          check(index >= 1000, "Function rejected before the queued cap");
          rejected++;
        }
      }
      check(
        accepted.length === 1000 && rejected === 2000,
        "Incorrect 3000-submission admission totals",
      );
      const denied = await eventually(
        quota,
        (count) => {
          healthy();
          return count > 0 ? "done" : "wait";
        },
        "Scheduler classified a real native quota denial",
        30_000,
      );
      const queued = await list();
      check(
        queued.filter((run) => run.state === "QUEUED").length === 1000 &&
          queued.every((run) => run.state === "QUEUED" || run.state === "CANCELLED"),
        "Quota rejection changed queued runs to failures",
      );
      check(observe() === 0, "Zero-Job quota admitted a native Job");
      const attempted = queued.find(
        (run) => run.state === "QUEUED" && run.attempt > 0 && run.jobName,
      );
      check(attempted, "Quota rejection lacks an attempted queued Run");
      const retained = accepted.slice(0, 5);
      const retainNames = new Set(retained.map((run) => run.name));
      await cancel(accepted.filter((run) => !retainNames.has(run.name)).map((run) => run.name));
      await eventually(
        list,
        (runs) =>
          runs.filter((run) => run.state === "QUEUED").length === 5 &&
          runs.filter(terminal).length === 1005
            ? "done"
            : "wait",
        "Leave five durable queued Runs before quota recovery",
        120_000,
        500,
      );
      removeQuota();
      const active = await eventually(
        async () => Promise.all(retained.map((run) => get(run.name))),
        (runs) => {
          observe();
          return runs.some(terminal)
            ? "fail"
            : runs.every(
                  (run) => run.state === "RUNNING" && run.runtimeStatus?.message === "holding",
                ) && jobs.size === 5
              ? "done"
              : "wait";
        },
        "Five live held Jobs after quota recovery",
        90_000,
      );
      for (const run of active) options.live(run);
      const overflow = await submit(false, input);
      check(overflow, "Five live Jobs incorrectly filled the queue cap");
      if (!overflow) throw new Error("Missing overflow witness");
      const saturatedAt = performance.now();
      await eventually(
        async () => get(overflow.name),
        (run) => {
          observe();
          if (run.state !== "QUEUED" || run.attempt !== 0) return "fail";
          return performance.now() - saturatedAt >= 3000 ? "done" : "wait";
        },
        "Sixth Run stays queued through multiple live scheduler ticks",
        10_000,
      );
      // The producer cannot end until this observer acknowledges one owned FIFO.
      const first = active[0];
      check(first?.jobStatus?.podName, "Missing held producer");
      kube(
        [
          "exec",
          "-n",
          jobsNamespace,
          `pod/${first?.jobStatus?.podName}`,
          "-c",
          "function",
          "--",
          "/bin/sh",
          "-c",
          'printf "%s\\n" release > /tmp/krun-e2e-backpressure-release',
        ],
        "Release one held Function through its FIFO",
      );
      await eventually(
        async () => get(overflow.name),
        (run) => {
          observe();
          return terminal(run)
            ? "fail"
            : run.state === "RUNNING" && run.runtimeStatus?.message === "holding"
              ? "done"
              : "wait";
        },
        "Queued overflow recovers only after a slot opens",
        60_000,
      );
      options.live(await get(overflow.name));
      check(
        first && (await get(first.name)).state === "SUCCEEDED",
        "Released Run did not complete successfully",
      );
      check(
        maximum === 5 && seen.size === 6 && events > 6 && observe() === 5,
        "Incomplete continuous native concurrency evidence",
      );
      console.log(
        JSON.stringify({
          scenario: "backpressure",
          mode: options.mode,
          submitted: 3000,
          accepted: 1000,
          queueFull: rejected,
          keyAccepted: 10,
          keyRejectedAt: 11,
          quotaRejections: denied,
          quotaRunsRemainQueued: true,
          maximumNativeJobs: maximum,
          distinctNativeJobs: seen.size,
          jobWatchEvents: events,
          queuedOverflowRecovered: true,
        }),
      );
    },
    async close() {
      try {
        if (owned.size) {
          await cancel([...owned]);
          await allTerminal();
        }
        healthy();
        if (watch)
          await eventually(
            async () => jobOccupancy([...jobs.values()], name),
            (count) => {
              healthy();
              return count === 0 ? "done" : "wait";
            },
            "All owned native Jobs settled before closing their witness",
          );
      } finally {
        try {
          if (quotaOwned) removeQuota();
        } finally {
          closing = true;
          if (watch) {
            const child = watch;
            const deadline = new AbortController();
            try {
              child.kill("SIGTERM");
              const stopped = await Promise.race([
                watchDone.then(() => true),
                setTimeout(2000, false, { signal: deadline.signal }),
              ]);
              if (!stopped) {
                watchBroken = true;
                child.kill("SIGKILL");
                await Promise.race([
                  watchDone,
                  setTimeout(2000, undefined, { signal: deadline.signal }).then(() => {
                    throw new Error("Owned backpressure Job watch did not close");
                  }),
                ]);
              }
            } finally {
              deadline.abort();
            }
          }
          // Child close follows stdout drain. Late records and truncated input
          // remain failures even after intentional shutdown has begun.
          check(observe() === 0, "Nonterminal native Jobs remained after watch drain");
        }
      }
      console.log(
        JSON.stringify({
          scenario: "backpressure",
          bulkRunsTerminal: owned.size,
          quotaRemoved: true,
          nativeWatchDrained: watch !== undefined,
          finalNativeJobs: observe(),
        }),
      );
    },
  };
};
