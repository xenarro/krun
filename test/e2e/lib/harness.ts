import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { publicSchemas } from "../../../apps/gateway/src/public-contracts.js";
import { contextArgs, parsePushDigest } from "./contracts.js";
import { podSchema } from "./pod.js";
import { runCredentials } from "./run-credentials.js";
import { eventually } from "./wait.js";
import { receiverSnapshotSchema, webhookResources } from "./webhook-fixture.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const privateDir = join(tmpdir(), `krun-test-e2e-${owner}`);
const modes = [
  "success",
  "exit_code",
  "exit_code_status",
  "image_pull_backoff",
  "heartbeat_timeout",
  "wait",
  "webhook",
] as const;
type Mode = (typeof modes)[number];
const runSchema = publicSchemas.Run;
type Run = z.infer<typeof runSchema>;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const decode = <T>(schema: z.ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
};
const terminal = (run: Run) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.state);

export const scenario = (mode: Mode) => {
  const name = `krun-test-${mode.replaceAll("_", "-")}-${randomBytes(5).toString("hex")}`;
  const selector = `krun.io/function=${name}`;
  const kubeconfig = join(privateDir, "kubeconfig");
  const children: ChildProcess[] = [];
  const pods = new Map<string, z.infer<typeof podSchema>>();
  const seenJobs = new Set<string>();
  const runs: Run[] = [];
  const forbidden = new Set<string>();
  const credentials = runCredentials(name, forbidden);
  const podContents = new Set<string>();
  let key = "";
  let url = "";
  let applied = false;
  let receiverApplied = false;
  let closing = false;
  let watchBroken = false;
  let manifestObserved = false;
  const command = (
    exe: string,
    args: string[],
    operation: string,
    input?: string,
    timeout = 120_000,
  ) => {
    const result = spawnSync(exe, args, {
      cwd: root,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (result.error || result.status !== 0)
      throw new Error(`${operation} failed; private output withheld`);
    return result.stdout;
  };
  const kube = (args: string[], operation: string, input?: string) =>
    command("kubectl", [...contextArgs(kubeconfig), ...args], operation, input);
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid private JSON response");
    }
  };
  const safeContent = (text: string) => {
    for (const value of forbidden)
      check(!text.includes(value), "Private test data appeared in a process log or Pod manifest");
    check(
      !text.includes("X-Amz-Signature="),
      "A presigned URL appeared in a process log or Pod manifest",
    );
  };
  const api = async (
    path: string,
    method = "GET",
    body?: unknown,
    timeout = 3000,
  ): Promise<Run> => {
    let response: Response;
    try {
      response = await fetch(`${url}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new Error("Public API transport failed");
    }
    const create = method === "POST" && !path.endsWith(":cancel") && !path.endsWith(":wait");
    if (response.status !== (create ? 201 : 200))
      throw new Error(`Public API returned HTTP ${response.status}; private body withheld`);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Public API response was not JSON");
    }
    return decode(runSchema, value, "Public API response violates the Run contract");
  };
  const healthyWatch = () =>
    check(!watchBroken, "Native credential/Pod watch failed; absence is not a witness");
  const watchPods = () => {
    const list = decode(
      z.object({ metadata: z.object({ resourceVersion: z.string() }) }),
      json(
        kube(
          ["get", "pods", "-n", "krun-jobs", "-l", selector, "-o", "json"],
          "Anchor native Pod watch",
        ),
      ),
      "Invalid Pod LIST metadata",
    );
    // Anchor at LIST resourceVersion so a fast Job cannot end between spawn and WATCH handshake.
    const query = new URLSearchParams({
      watch: "true",
      resourceVersion: list.metadata.resourceVersion,
      labelSelector: selector,
      allowWatchBookmarks: "true",
    });
    const child = spawn(
      "kubectl",
      [...contextArgs(kubeconfig), "get", "--raw", `/api/v1/namespaces/krun-jobs/pods?${query}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let buffer = "";
    child.stderr?.resume();
    child.on("error", () => {
      if (!closing) watchBroken = true;
    });
    child.on("exit", () => {
      if (!closing) watchBroken = true;
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
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
            z.object({ type: z.string(), object: z.unknown() }),
            json(line),
            "Invalid watch event",
          );
          if (event.type === "BOOKMARK") continue;
          check(
            ["ADDED", "MODIFIED", "DELETED"].includes(event.type),
            "Native watch returned an error event",
          );
          const content = JSON.stringify(event.object);
          // Secret and Pod streams can arrive out of order;recheck after binding.
          podContents.add(content);
          safeContent(content);
          const pod = decode(podSchema, event.object, "Invalid Pod event");
          check(
            pod.metadata.labels["krun.io/function"] === name,
            "Foreign Pod reached scenario watch",
          );
          check(pod.spec.automountServiceAccountToken === false, "Job mounted an API credential");
          const token = pod.spec.containers
            .find((c) => c.name === "function")
            ?.env.find((env) => env.name === "KRUN_TOKEN");
          check(
            token?.value === undefined && token?.valueFrom?.secretKeyRef.key === "token",
            "Pod contains an inline run credential",
          );
          pods.set(pod.metadata.name, pod);
          manifestObserved = true;
        } catch {
          watchBroken = true;
        }
      }
    });
  };
  const watchCredentials = () => {
    const list = decode(
      z.object({
        metadata: z.object({ resourceVersion: z.string() }),
        items: z.array(z.unknown()),
      }),
      json(
        kube(
          ["get", "secrets", "-n", "krun-jobs", "-l", selector, "-o", "json"],
          "Anchor private Run credential watch",
        ),
      ),
      "Invalid private Secret LIST metadata",
    );
    for (const secret of list.items) credentials.observe(secret);
    const query = new URLSearchParams({
      watch: "true",
      resourceVersion: list.metadata.resourceVersion,
      labelSelector: selector,
      allowWatchBookmarks: "true",
    });
    const child = spawn(
      "kubectl",
      [...contextArgs(kubeconfig), "get", "--raw", `/api/v1/namespaces/krun-jobs/secrets?${query}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let buffer = "";
    child.stderr?.resume();
    child.on("error", () => {
      if (!closing) watchBroken = true;
    });
    child.on("exit", () => {
      if (!closing) watchBroken = true;
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        buffer = "";
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
            z.object({ type: z.string(), object: z.unknown() }),
            json(line),
            "Invalid private Secret watch event",
          );
          if (event.type === "BOOKMARK") continue;
          check(
            ["ADDED", "MODIFIED", "DELETED"].includes(event.type),
            "Private Secret watch returned an error event",
          );
          credentials.observe(event.object);
        } catch {
          watchBroken = true;
        }
      }
    });
  };
  const until = async (run: Run, predicate: (value: Run) => boolean, timeout = 120_000) =>
    eventually(
      async () => api(run.name),
      (value) => {
        healthyWatch();
        return predicate(value) ? "done" : terminal(value) ? "fail" : "wait";
      },
      `${mode} Run observation`,
      timeout,
    );
  const getJob = (run: Run) => {
    const jobName = run.jobName;
    check(
      typeof jobName === "string" && jobName.startsWith("krun-"),
      "Run lacks its owned Job name",
    );
    return kube(
      ["get", "job", jobName, "-n", "krun-jobs", "--ignore-not-found", "-o", "json"],
      "Observe owned Job",
    );
  };
  return {
    async up() {
      const state = decode(
        z.object({
          owner: z.literal(owner),
          key: z.string().regex(/^[a-f0-9]{64}$/),
          image: z.string(),
          webhookSecrets: z.tuple([z.string(), z.string()]),
        }),
        json(readFileSync(join(privateDir, "state.json"), "utf8")),
        "Missing owned foundation state; run make e2e",
      );
      const config = decode(
        z.object({
          "current-context": z.literal("kind-krun-test-e2e"),
          clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
        }),
        parse(readFileSync(kubeconfig, "utf8")),
        "Foreign Kubernetes configuration",
      );
      check(
        ["127.0.0.1", "localhost"].includes(
          new URL(config.clusters[0]?.cluster.server ?? "").hostname,
        ),
        "Non-loopback Kubernetes configuration",
      );
      key = state.key;
      forbidden.add(key);
      for (const secret of [...state.webhookSecrets, state.webhookSecrets.join(",")])
        forbidden.add(secret);
      let image = `localhost:5001/krun-test-e2e-unpullable@sha256:${"0".repeat(64)}`;
      if (mode !== "image_pull_backoff") {
        const curl = decode(
          z.object({ curl: z.string().regex(/^curlimages\/curl:[\d.]+@sha256:[a-f0-9]{64}$/) }),
          json(readFileSync(join(root, "test/e2e/images.json"), "utf8")),
          "Missing pinned curl fixture",
        ).curl;
        const tag = `localhost:5001/krun-test-e2e-${mode.replaceAll("_", "-")}:e2e`;
        command(
          "docker",
          [
            "build",
            "--build-arg",
            `CURL_IMAGE=${curl}`,
            "--build-arg",
            `SCENARIO=${mode === "wait" || mode === "webhook" ? "success" : mode}`,
            "--tag",
            tag,
            "test/e2e/functions",
          ],
          "Build actual curl function",
          undefined,
          300_000,
        );
        const pushed = command(
          "docker",
          ["push", tag],
          "Push curl fixture only to owned local registry",
        );
        image = `${tag.slice(0, -4)}@${parsePushDigest(pushed)}`;
      }
      if (mode === "webhook") {
        // Set before apply: a partially applied List still belongs to this cleanup.
        receiverApplied = true;
        kube(
          ["apply", "-f", "-"],
          "Apply isolated webhook receiver",
          JSON.stringify(
            webhookResources(
              name,
              state.image,
              readFileSync(join(root, "test/e2e/lib/webhook-receiver.ts"), "utf8"),
            ),
          ),
        );
        kube(
          ["wait", "-n", "krun", `pod/${name}`, "--for=condition=Ready", "--timeout=90s"],
          "Await actual receiver readiness",
        );
        safeContent(
          kube(["get", "pod", name, "-n", "krun", "-o", "json"], "Check receiver Pod privacy"),
        );
      }
      kube(
        ["apply", "-f", "-"],
        "Apply scenario Function",
        JSON.stringify({
          apiVersion: "krun.io/v1alpha1",
          kind: "Function",
          metadata: { name, namespace: "krun" },
          spec: {
            image,
            inputSchema: { type: "object" },
            activeDeadlineSeconds: mode === "image_pull_backoff" ? 60 : 120,
            ...(mode === "heartbeat_timeout" ? { heartbeatTimeout: "30s" } : {}),
          },
        }),
      );
      applied = true;
      await eventually(
        async () =>
          json(
            kube(["get", "function", name, "-n", "krun", "-o", "json"], "Read scenario Function"),
          ),
        (value) => {
          const fn = decode(
            z.object({
              metadata: z.object({ generation: z.number() }),
              status: z
                .object({
                  observedGeneration: z.number().optional(),
                  conditions: z
                    .array(z.object({ type: z.string(), status: z.string() }))
                    .optional(),
                })
                .optional(),
            }),
            value,
            "Invalid Function projection",
          );
          if (fn.status?.observedGeneration !== fn.metadata.generation) return "wait";
          const ready = fn.status.conditions?.find(
            (condition) => condition.type === "Ready",
          )?.status;
          return ready === "True" ? "done" : ready === "False" ? "fail" : "wait";
        },
        `${mode} current Function readiness`,
      );
      let failed = false;
      const forward = spawn(
        "kubectl",
        [
          ...contextArgs(kubeconfig),
          "port-forward",
          "-n",
          "krun",
          "service/krun-gateway",
          ":8080",
          "--address=127.0.0.1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(forward);
      forward.stderr?.resume();
      forward.on("error", () => {
        failed = true;
      });
      forward.on("exit", () => {
        failed = true;
      });
      forward.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        const match = chunk.match(/Forwarding from 127\.0\.0\.1:(\d+) ->/);
        if (match) url = `http://127.0.0.1:${match[1]}`;
      });
      await eventually(
        async () => ({ url, failed }),
        (v) => (v.failed ? "fail" : v.url ? "done" : "wait"),
        "Private public-API port-forward",
        10_000,
      );
      watchCredentials();
      watchPods();
    },
    input() {
      const marker = randomBytes(24).toString("hex");
      forbidden.add(marker);
      return { marker, nested: { items: [1, true, "opaque"] } };
    },
    async submit(input?: unknown, options: { wait?: boolean; callback?: boolean } = {}) {
      check(!options.callback || mode === "webhook", "Callback requires the owned receiver");
      const marker = randomBytes(24).toString("hex");
      forbidden.add(marker);
      const run = await api(
        `functions/${name}/runs${options.wait ? "?wait=30s" : ""}`,
        "POST",
        {
          input: input ?? {},
          ...(options.callback
            ? {
                callback: {
                  url: `http://${name}.krun.svc.cluster.local:8080/hook?canary=${marker}`,
                },
              }
            : {}),
        },
        options.wait ? 35_000 : 3000,
      );
      credentials.bind(run.name);
      runs.push(run);
      return run;
    },
    wait(run: Run) {
      return api(`${run.name}:wait`, "POST", { timeout: "30s" }, 35_000);
    },
    async deliveries(run: Run) {
      check(receiverApplied, "No owned webhook receiver");
      const receipts = await eventually(
        async () =>
          decode(
            receiverSnapshotSchema,
            json(
              kube(
                [
                  "exec",
                  "-n",
                  "krun",
                  `pod/${name}`,
                  "--",
                  "/nodejs/bin/node",
                  "-e",
                  "fetch('http://127.0.0.1:8080/observations', {signal:AbortSignal.timeout(2000)}).then(async r => {if (!r.ok) process.exit(1);process.stdout.write(await r.text())}).catch(() => process.exit(1))",
                ],
                "Read sanitized receiver verdict",
              ),
            ),
            "Invalid sanitized receiver verdict",
          ),
        (values) => {
          healthyWatch();
          return values.some((value) => !value.valid) || values.length > 2
            ? "fail"
            : values.length === 2
              ? "done"
              : "wait";
        },
        "Native one-minute webhook retry",
        100_000,
        1000,
      );
      const [first, second] = receipts;
      check(
        first && second && first.responseStatus === 500 && second.responseStatus === 200,
        "Receiver did not return 500 then 200",
      );
      check(
        first.deliveryId === second.deliveryId &&
          first.runId === run.name.split("/").at(-1) &&
          second.runId === first.runId,
        "Delivery identity changed or belongs to another Run",
      );
      check(
        receipts.every((value) => value.v1Count === 2 && value.sameBody),
        "Rotation signatures or raw body changed",
      );
      check(second.timestamp > first.timestamp, "Retry did not carry a fresh send timestamp");
      check(
        Boolean(first.traceparent && second.traceparent) &&
          first.traceparent !== second.traceparent,
        "Retry did not carry its own valid attempt trace context",
      );
      safeContent(kube(["logs", "-n", "krun", `pod/${name}`], "Check receiver log privacy"));
      console.log(
        JSON.stringify({
          scenario: mode,
          nativeReceiver: true,
          attempts: receipts.length,
          responseStatuses: receipts.map((r) => r.responseStatus),
          distinctDeliveries: new Set(receipts.map((r) => r.deliveryId)).size,
          verifiedRotationKeys: 2,
          exactRawBytes: true,
          freshAttemptTimestamp: true,
          distinctAttemptTrace: true,
        }),
      );
    },
    until,
    async terminal(run: Run, state: "SUCCEEDED" | "FAILED", timeout = 120_000) {
      const value = await until(run, (value) => value.state === state, timeout);
      console.log(
        JSON.stringify({
          scenario: mode,
          state: value.state,
          failureReason: value.failureReason,
          jobReason: value.jobStatus?.reason,
          exitCode: value.jobStatus?.exitCode,
        }),
      );
      return value;
    },
    equalOpaque(actual: unknown, expected: unknown, message: string) {
      check(isDeepStrictEqual(actual, expected), message);
    },
    async exitedWithin(run: Run, code: number, limit: number) {
      const pod = await eventually(
        async () => {
          healthyWatch();
          return [...pods.values()].find((p) => p.metadata.name === run.jobStatus?.podName);
        },
        (pod) =>
          pod?.status?.containerStatuses?.some((c) => c.name === "function" && c.state.terminated)
            ? "done"
            : "wait",
        "Native container termination witness",
        5000,
      );
      const ended = pod?.status?.containerStatuses?.find((c) => c.name === "function")?.state
        .terminated;
      check(
        ended?.exitCode === code && typeof ended.finishedAt === "string",
        "Native exit code or finish-time witness differs",
      );
      const elapsed = performance.timeOrigin + performance.now() - Date.parse(ended.finishedAt);
      check(
        Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= limit,
        "Terminal detection exceeded the phase-gate bound",
      );
      console.log(
        JSON.stringify({
          scenario: mode,
          nativeExitCode: code,
          terminalDetectionMs: Math.ceil(elapsed),
        }),
      );
    },
    withinReportDeadline(run: Run, limit: number) {
      const elapsed =
        performance.timeOrigin +
        performance.now() -
        Date.parse(run.runtimeStatus?.reportTime ?? "");
      check(
        Number.isFinite(elapsed) && elapsed >= 30_000 && elapsed <= limit,
        "Heartbeat terminal detection violated its real-time bound",
      );
      console.log(
        JSON.stringify({ scenario: mode, acceptedReportToFailureMs: Math.ceil(elapsed) }),
      );
    },
    async jobExists(run: Run) {
      const text = getJob(run);
      check(text.trim(), "Expected live Job was absent");
      const job = decode(
        z.object({
          metadata: z.object({ labels: z.record(z.string(), z.string()) }),
          spec: z.object({ activeDeadlineSeconds: z.number() }),
        }),
        json(text),
        "Invalid live Job witness",
      );
      check(
        job.metadata.labels["krun.io/function"] === name,
        "Foreign Job reached scenario witness",
      );
      check(
        job.spec.activeDeadlineSeconds === (mode === "image_pull_backoff" ? 60 : 120),
        "Native Job deadline differs from its Function",
      );
      seenJobs.add(run.jobName ?? "");
    },
    async jobGone(run: Run) {
      check(seenJobs.has(run.jobName ?? ""), "Job deletion lacks a positive existence witness");
      await eventually(
        async () => getJob(run),
        (value) => (value.trim() ? "wait" : "done"),
        "Owned Job deletion",
        10_000,
      );
    },
    async privacy() {
      await eventually(
        async () => manifestObserved,
        (observed) => {
          healthyWatch();
          return observed ? "done" : "wait";
        },
        "Native Pod manifest witness",
        5000,
      );
      check(runs.length > 0, "No submitted Run credential witness");
      await eventually(
        async () => runs.every((run) => credentials.ready(run.name)),
        (ready) => {
          healthyWatch();
          return ready ? "done" : "wait";
        },
        "Owned Run credential witnesses",
        5000,
      );
      for (const content of podContents) safeContent(content);
      for (const container of ["gateway", "scheduler"])
        safeContent(
          kube(
            ["logs", "-n", "krun", "deployment/krun", "-c", container],
            "Check process log privacy",
          ),
        );
      console.log(
        JSON.stringify({
          scenario: mode,
          privatePodManifest: true,
          privateProcessLogs: true,
          runCredentialsWitnessed: runs.length,
          nativeUnknownFinishTime: [...pods.values()].some((pod) =>
            pod.status?.containerStatuses?.some(
              (container) =>
                container.state.terminated && container.state.terminated.finishedAt == null,
            ),
          ),
        }),
      );
    },
    async close() {
      let cleanupFailed = false;
      try {
        if (applied) {
          // API or observer failure must not bypass this Function's bounded cleanup.
          try {
            for (const created of runs) {
              const current = await api(created.name);
              if (!terminal(current)) {
                await api(`${created.name}:cancel`, "POST", {});
                await eventually(
                  async () => api(created.name),
                  (run) => (terminal(run) ? "done" : "wait"),
                  "Scenario cancellation",
                  45_000,
                );
              }
            }
          } catch {
            cleanupFailed = true;
          }
          try {
            kube(
              [
                "delete",
                "jobs,secrets",
                "-n",
                "krun-jobs",
                "-l",
                selector,
                "--wait=true",
                "--timeout=60s",
              ],
              "Clean only this scenario's Jobs and Secrets",
            );
            const inventory = () =>
              decode(
                z.object({ items: z.array(z.unknown()) }),
                json(
                  kube(
                    ["get", "jobs,secrets,pods", "-n", "krun-jobs", "-l", selector, "-o", "json"],
                    "Read back scenario cleanup",
                  ),
                ),
                "Invalid cleanup inventory",
              );
            await eventually(
              async () => inventory(),
              (value) => (value.items.length === 0 ? "done" : "wait"),
              "Scenario resource cleanup",
              60_000,
            );
          } catch {
            cleanupFailed = true;
          }
          try {
            kube(
              ["delete", "function", name, "-n", "krun", "--wait=true", "--timeout=60s"],
              "Clean only this scenario Function",
            );
            check(
              !kube(
                ["get", "function", name, "-n", "krun", "--ignore-not-found", "-o", "json"],
                "Read back Function deletion",
              ).trim(),
              "Scenario Function deletion was not confirmed",
            );
          } catch {
            cleanupFailed = true;
          }
        }
      } finally {
        if (receiverApplied) {
          try {
            const resources = "pods,services,configmaps,networkpolicies";
            const receiverSelector = `krun.io/e2e-receiver=${name}`;
            kube(
              [
                "delete",
                resources,
                "-n",
                "krun",
                "-l",
                receiverSelector,
                "--wait=true",
                "--timeout=60s",
              ],
              "Clean only this receiver's resources",
            );
            const inventory = decode(
              z.object({ items: z.array(z.unknown()) }),
              json(
                kube(
                  ["get", resources, "-n", "krun", "-l", receiverSelector, "-o", "json"],
                  "Read back receiver cleanup",
                ),
              ),
              "Invalid receiver cleanup inventory",
            );
            check(inventory.items.length === 0, "Receiver cleanup was not confirmed");
          } catch {
            cleanupFailed = true;
          }
        }
        closing = true;
        await Promise.all(
          children.map(async (child) => {
            if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
              return;
            child.kill("SIGTERM");
            const stopped = () => child.exitCode !== null || child.signalCode !== null;
            try {
              await eventually(
                async () => stopped(),
                (done) => (done ? "done" : "wait"),
                "Owned kubectl shutdown",
                2000,
                50,
              );
            } catch {
              child.kill("SIGKILL");
              await eventually(
                async () => stopped(),
                (done) => (done ? "done" : "wait"),
                "Owned kubectl forced shutdown",
                2000,
                50,
              );
            }
          }),
        );
      }
      credentials.clear();
      forbidden.clear();
      podContents.clear();
      check(!cleanupFailed, "Owned scenario cleanup failed;private diagnostics withheld");
    },
  };
};
