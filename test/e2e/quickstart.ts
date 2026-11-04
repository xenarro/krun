import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { databaseMode } from "./lib/chart.ts";
import { acquireFoundationLease } from "./lib/foundation-lease.ts";

// Separate from the existing 600-second per-test Vitest corpus. Each fresh
// mode owns its unchanged 1800-second complete acceptance budget in CI.
const root = fileURLToPath(new URL("../../", import.meta.url));
const mode = databaseMode.parse(process.argv[2]);
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const privateDir = join(tmpdir(), `krun-test-e2e-${owner}`);
const started = performance.now();
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS"),
);
const command = (exe: string, args: string[], env = environment, timeout = 600_000) => {
  const result = spawnSync(exe, args, {
    cwd: root,
    env,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // These entrypoints emit only sanitized diagnostics, never captured raw
    // helm, kubectl, npm or Docker output from inside the quickstart.
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error("Owned quickstart acceptance command failed");
  }
  return result.stdout;
};
const cluster = (...args: string[]) =>
  command(process.execPath, [join(root, "test/e2e/cluster.ts"), ...args]);
let startedFoundation = false;
let lease: Awaited<ReturnType<typeof acquireFoundationLease>> | undefined;
try {
  lease = await acquireFoundationLease(`${privateDir}.lock`);
  environment.KRUN_TEST_FOUNDATION_LEASE = lease.token;
  const clusters = command("kind", ["get", "clusters"]).split(/\s+/);
  if (clusters.includes("krun-test-e2e"))
    throw new Error("Quickstart acceptance needs a fresh absent cluster");
  if (
    command("docker", [
      "container",
      "ls",
      "-a",
      "--filter",
      "name=^kind-registry$",
      "--format",
      "{{.ID}}",
    ]).trim()
  )
    throw new Error("Quickstart acceptance refuses an existing registry");
  let existingState = false;
  try {
    await lstat(privateDir);
    existingState = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot confirm fresh private foundation state");
  }
  if (existingState) throw new Error("Quickstart acceptance refuses existing foundation state");
  startedFoundation = true;
  cluster("up");
  // Positive CNI open/deny/reopen control with stock chart policies. Remove
  // this control release before the actual script, which requires fresh
  // namespaces and an absent CRD/admission policy. No policy is weakened.
  cluster("install", mode);
  const enforcement = cluster("verify");
  if (!enforcement.includes('"enforcement":"open-denied-reopened"'))
    throw new Error("Missing actual isolation control");
  cluster("uninstall");
  const projects = z
    .object({ node: z.string() })
    .parse(JSON.parse(await readFile(join(privateDir, "sdk-projects.json"), "utf8")));
  const output = command(
    "sh",
    [join(root, "scripts/quickstart.sh"), mode],
    {
      ...environment,
      KRUN_CHART: join(root, "deploy/helm/krun"),
      KRUN_IMAGE: "localhost:5001/krun:e2e",
      KRUN_CLI: `${process.execPath} ${join(root, "packages/cli/dist/main.js")}`,
      KRUN_SDK_VENDOR: join(projects.node, "vendor"),
      KRUN_REGISTRY: "localhost:5001",
    },
    1_800_000,
  );
  const lines = output.trim().split("\n");
  if (lines.length !== 1) throw new Error("Quickstart emitted unstructured output");
  const result = z
    .object({
      event: z.literal("quickstart_acceptance"),
      mode: z.literal(mode),
      vendoredSdk: z.literal(true),
      currentGenerationReady: z.literal(true),
      createStatus: z.literal(201),
      runSucceeded: z.literal(true),
      resultReadback: z.literal(true),
      ownedCleanupVerified: z.literal(true),
      durationSeconds: z.number().positive().max(1800),
    })
    .parse(JSON.parse(lines[0] ?? ""));
  console.log(
    JSON.stringify({
      ...result,
      freshCluster: true,
      actualIsolationControl: true,
      freshClusterDurationSeconds: (performance.now() - started) / 1000,
    }),
  );
} catch (error) {
  // Capture only safe native status before owned teardown; never retain raw
  // Job manifests, Secret data, environment lists or application logs.
  if (startedFoundation) {
    try {
      const config = z
        .object({
          "current-context": z.literal("kind-krun-test-e2e"),
          clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
        })
        .parse(parse(await readFile(join(privateDir, "kubeconfig"), "utf8")));
      if (
        !["127.0.0.1", "localhost"].includes(
          new URL(config.clusters[0]?.cluster.server ?? "").hostname,
        )
      )
        throw new Error("Foreign diagnostic context");
      const diagnosis = spawnSync(
        "kubectl",
        [
          "--kubeconfig",
          join(privateDir, "kubeconfig"),
          "--context",
          "kind-krun-test-e2e",
          "get",
          "job",
          "krun-test-minio-init",
          "-n",
          "krun-test-minio",
          "-o",
          "json",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      if (diagnosis.status === 0) {
        const job = z
          .object({
            status: z
              .object({
                conditions: z
                  .array(
                    z.object({
                      type: z.string().regex(/^[A-Za-z]+$/),
                      status: z.string().regex(/^[A-Za-z]+$/),
                      reason: z
                        .string()
                        .regex(/^[A-Za-z]+$/)
                        .optional(),
                    }),
                  )
                  .optional(),
                succeeded: z.number().optional(),
                failed: z.number().optional(),
              })
              .optional(),
          })
          .safeParse(JSON.parse(diagnosis.stdout));
        if (job.success)
          process.stderr.write(`${JSON.stringify({ initializerStatus: job.data.status })}\n`);
      }
    } catch {
      /* Diagnostics must not mask the original failure or expose private values. */
    }
  }
  throw error;
} finally {
  try {
    if (startedFoundation) process.stdout.write(cluster("down"));
  } finally {
    await lease?.release();
  }
}
