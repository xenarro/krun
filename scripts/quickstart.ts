import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse, parseAllDocuments } from "yaml";
import { z } from "zod";
import { publicSchemas } from "../apps/gateway/src/public-contracts.ts";
import { assertRegistryOwner, contextArgs } from "../test/e2e/lib/contracts.ts";
import { acquireFoundationLease } from "../test/e2e/lib/foundation-lease.ts";
import { quickstartSettings, quickstartValues } from "./quickstart-config.ts";
import { cleanupAfterForward } from "./quickstart-process.ts";

// A source-checkout, disposable kind rehearsal, not a production installer.
const root = fileURLToPath(new URL("../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const foundation = join(tmpdir(), `krun-test-e2e-${owner}`);
const kubeconfig = join(foundation, "kubeconfig");
const release = "quickstart";
const started = performance.now();
let stage = "configuration";
let failed = false;
let work: string | undefined;
let createdNamespace = false;
const invocationOwner = randomBytes(12).toString("hex");
let forward: ReturnType<typeof spawn> | undefined;
let lock: string | undefined;
let heldLock = false;
let foundationLease: Awaited<ReturnType<typeof acquireFoundationLease>> | undefined;
let summary: object | undefined;
const ensure = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const settings = quickstartSettings(process.argv[2] ?? "", process.env);
const { namespace, jobsNamespace, name } = settings;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS"),
);
const command = (
  exe: string,
  args: string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
) => {
  const result = spawnSync(exe, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? environment,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  ensure(
    !result.error && result.status === 0,
    "Quickstart command failed; private output withheld",
  );
  return result.stdout;
};
const kube = (args: string[], input?: unknown) =>
  command("kubectl", [...contextArgs(kubeconfig), ...args], {
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
const apply = (value: unknown) => kube(["apply", "-f", "-"], value);
const helm = (args: string[]) =>
  command("helm", ["--kubeconfig", kubeconfig, "--kube-context", "kind-krun-test-e2e", ...args], {
    timeout: 300_000,
  });
const inventory = (kind: string, resource: string, ns?: string) =>
  kube(["get", kind, resource, ...(ns ? ["-n", ns] : []), "--ignore-not-found", "-o", "json"]);
const wait = async <T>(read: () => Promise<T>, judge: (value: T) => boolean, timeout: number) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read(); // A read error is never a successful absence witness.
    if (judge(value)) return value;
    await setTimeout(200);
  }
  throw new Error("Quickstart observation expired");
};
const secret = (secretName: string, stringData: Record<string, string>) =>
  apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace },
    type: "Opaque",
    stringData,
  });
try {
  stage = "owned-foundation";
  foundationLease = await acquireFoundationLease(
    `${foundation}.lock`,
    process.env.KRUN_TEST_FOUNDATION_LEASE,
  );
  const state = z
    .object({ owner: z.literal(owner) })
    .parse(JSON.parse(await readFile(join(foundation, "state.json"), "utf8")));
  ensure(state.owner === owner, "Run make kind-up first");
  const config = z
    .object({
      "current-context": z.literal("kind-krun-test-e2e"),
      clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
    })
    .parse(parse(await readFile(kubeconfig, "utf8")));
  ensure(
    ["127.0.0.1", "localhost"].includes(new URL(config.clusters[0]?.cluster.server ?? "").hostname),
    "Refusing non-loopback Kubernetes access",
  );
  assertRegistryOwner(JSON.parse(command("docker", ["inspect", "kind-registry"]))[0], owner);
  lock = join(foundation, "quickstart.lock");
  await mkdir(lock, { mode: 0o700 });
  heldLock = true;
  for (const ns of [namespace, jobsNamespace])
    ensure(!inventory("namespace", ns).trim(), "Refusing an existing demo namespace");
  ensure(!inventory("crd", "functions.krun.io").trim(), "Quickstart requires a fresh platform");
  ensure(
    !inventory("validatingadmissionpolicy", "krun-jobs-digest").trim(),
    "Refusing an existing platform admission policy",
  );
  work = await mkdtemp(join(foundation, "quickstart-"));
  stage = "private-prerequisites";
  createdNamespace = true; // Own an unknown-outcome create before the RPC.
  kube(["create", "-f", "-"], {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      labels: {
        "krun.io/quickstart-owner": invocationOwner,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "v1.33",
      },
    },
  });
  const key = randomBytes(32).toString("hex");
  secret("krun-test-quickstart-keys", {
    "keys.yaml": JSON.stringify({
      keys: [
        {
          name: "quickstart",
          key,
          scopes: ["runs:read", "runs:write", "functions:read"],
          functions: [name],
        },
      ],
    }),
  });
  if (settings.mode === "postgres") {
    const password = randomBytes(32).toString("hex");
    secret("krun-test-postgres", {
      password,
      dsn: `postgresql://krun:${password}@krun-test-postgres.${namespace}.svc:5432/krun`,
    });
    for (const document of parseAllDocuments(
      (await readFile(join(root, "test/e2e/postgres.yaml"), "utf8")).replaceAll(
        "__KRUN_E2E_NAMESPACE__",
        namespace,
      ),
    ))
      apply(document.toJSON());
    kube(["rollout", "status", "deployment/krun-test-postgres", "-n", namespace, "--timeout=180s"]);
  }
  const valuesFile = join(work, "values.json");
  await writeFile(valuesFile, JSON.stringify(quickstartValues(settings)), { mode: 0o600 });
  stage = "chart-install";
  helm([
    "install",
    release,
    settings.chart,
    "-n",
    namespace,
    "-f",
    valuesFile,
    "--wait=watcher",
    "--timeout=240s",
  ]);
  kube(["wait", "--for=condition=Established", "crd/functions.krun.io", "--timeout=60s"]);
  stage = "init-vendor-test";
  const [cli, ...cliArgs] = settings.cli;
  ensure(cli, "Missing CLI executable");
  command(cli ?? "", [...cliArgs, "init", "--lang", "node", "--name", name, "function"], {
    cwd: work,
  });
  const project = join(work, "function");
  if (settings.vendor) {
    const vendor = join(project, "vendor");
    await mkdir(vendor);
    const source = resolve(settings.vendor);
    const archives = (await readdir(source)).filter((entry) => entry.endsWith(".tgz"));
    ensure(archives.length === 1, "KRUN_SDK_VENDOR needs exactly one Node SDK tgz");
    const archive = archives[0] ?? "";
    await copyFile(join(source, archive), join(vendor, archive));
    command(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `./vendor/${archive}`,
      ],
      { cwd: project },
    );
  } else {
    command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project });
  }
  command("npm", ["test"], { cwd: project });
  stage = "loopback-forward";
  let url = "";
  let forwardFailed = false;
  forward = spawn(
    "kubectl",
    [
      ...contextArgs(kubeconfig),
      "port-forward",
      "-n",
      namespace,
      `service/${release}`,
      ":8080",
      "--address=127.0.0.1",
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  forward.stderr?.resume();
  forward.on("error", () => {
    forwardFailed = true;
  });
  forward.on("exit", () => {
    forwardFailed = true;
  });
  forward.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    const match = chunk.match(/Forwarding from 127\.0\.0\.1:(\d+) ->/);
    if (match) url = `http://127.0.0.1:${match[1]}`;
  });
  await wait(
    async () => {
      ensure(!forwardFailed, "Public port-forward failed");
      return url;
    },
    Boolean,
    10_000,
  );
  stage = "deploy";
  const deployed = command(
    cli ?? "",
    [
      ...cliArgs,
      "deploy",
      "--registry",
      settings.registry,
      "--namespace",
      namespace,
      "--api-url",
      url,
      project,
    ],
    {
      cwd: project,
      env: { ...environment, KUBECONFIG: kubeconfig, KRUN_JOBS_NAMESPACE: jobsNamespace },
      timeout: 600_000,
    },
  );
  ensure(deployed.includes("$KRUN_API_KEY"), "CLI must print a credential-free first-run command");
  const live = z
    .object({
      metadata: z.object({ generation: z.number() }),
      spec: z.object({
        image: z
          .string()
          .regex(
            /^localhost:5001\/krun-test-quickstart-(?:embedded|postgres)@sha256:[a-f0-9]{64}$/,
          ),
      }),
      status: z.object({
        observedGeneration: z.number(),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      }),
    })
    .parse(JSON.parse(kube(["get", "functions.krun.io", name, "-n", namespace, "-o", "json"])));
  ensure(
    live.metadata.generation === live.status.observedGeneration &&
      live.status.conditions.some((v) => v.type === "Ready" && v.status === "True"),
    "Function is not current-generation Ready",
  );
  stage = "submit-and-read";
  const api = async (path: string, method = "GET", body?: object) => {
    ensure(!forwardFailed, "Public port-forward exited");
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    ensure(
      response.status === (path.endsWith("/runs?wait=30s") ? 201 : 200),
      "Unexpected public response status",
    );
    const run = publicSchemas.Run.parse(await response.json());
    ensure(
      run.name.split("/").slice(0, 3).join("/") === `functions/${name}/runs` &&
        run.createdBy === "quickstart",
      "Foreign quickstart Run response",
    );
    return run;
  };
  const created = await api(`functions/${name}/runs?wait=30s`, "POST", {
    input: { name: "quickstart" },
  });
  let run = created;
  const end = performance.now() + 120_000;
  while (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.state)) {
    ensure(performance.now() < end, "Quickstart Run deadline exceeded");
    run = await api(`${created.name}:wait`, "POST", { timeout: "30s" });
    ensure(run.name === created.name, "Quickstart wait changed Run identity");
  }
  ensure(
    run.state === "SUCCEEDED" && isDeepStrictEqual(run.result, { rows: 42 }),
    "Quickstart Run did not produce the template result",
  );
  const readback = await api(created.name);
  ensure(
    readback.name === created.name &&
      readback.state === "SUCCEEDED" &&
      isDeepStrictEqual(readback.result, { rows: 42 }),
    "GetRun result readback mismatch",
  );
  summary = {
    event: "quickstart_acceptance",
    mode: settings.mode,
    chart: settings.chart,
    vendoredSdk: Boolean(settings.vendor),
    currentGenerationReady: true,
    createStatus: 201,
    runSucceeded: true,
    resultReadback: true,
    functionImage: live.spec.image,
    namespace,
    jobsNamespace,
  };
} catch {
  failed = true;
  process.stderr.write(`Quickstart failed during ${stage}; private output withheld\n`);
} finally {
  try {
    await cleanupAfterForward(forward, async () => {
      try {
        if (createdNamespace) {
          const namespaceText = inventory("namespace", namespace);
          if (namespaceText.trim()) {
            const ns = JSON.parse(namespaceText);
            ensure(
              ns.metadata?.labels?.["krun.io/quickstart-owner"] === invocationOwner,
              "Refusing foreign cleanup",
            );
            const releases = z
              .array(z.object({ name: z.string() }))
              .parse(JSON.parse(helm(["list", "-n", namespace, "-o", "json"])));
            if (releases.some((v) => v.name === release))
              helm(["uninstall", release, "-n", namespace, "--wait=watcher", "--timeout=120s"]);
            kube(["delete", "namespace", namespace, "--wait=true", "--timeout=120s"]);
          }
          ensure(
            !inventory("namespace", namespace).trim() &&
              !inventory("namespace", jobsNamespace).trim(),
            "Demo namespace cleanup not confirmed",
          );
          ensure(!inventory("crd", "functions.krun.io").trim(), "Demo CRD cleanup not confirmed");
        }
        if (work) await rm(work, { recursive: true }); // exact mkdtemp return, not a response-derived path
      } finally {
        try {
          if (heldLock && lock) await rm(lock, { recursive: true });
        } finally {
          await foundationLease?.release();
        }
      }
    });
  } catch {
    failed = true;
    process.stderr.write("Owned quickstart cleanup failed\n");
  }
}
if (failed) process.exitCode = 1;
else
  console.log(
    JSON.stringify({
      ...summary,
      ownedCleanupVerified: true,
      durationSeconds: (performance.now() - started) / 1000,
    }),
  );
