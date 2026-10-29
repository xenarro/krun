import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";
import { z } from "zod";
import { chartLayout, chartValues, type DatabaseMode, databaseMode, release } from "./lib/chart.ts";
import {
  assertRegistryOwner,
  contextArgs,
  parsePushDigest,
  probeVerdict,
} from "./lib/contracts.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cluster = "krun-test-e2e";
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const stateDir = join(tmpdir(), `krun-test-e2e-${owner}`);
const stateFile = join(stateDir, "state.json");
const kubeconfig = join(stateDir, "kubeconfig");
const lock = `${stateDir}.lock`;
const stateSchema = z.object({
  owner: z.literal(owner),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  mode: databaseMode.optional(),
  postgresPassword: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  webhookSecrets: z
    .tuple([z.string().regex(/^[a-f0-9]{64}$/), z.string().regex(/^[a-f0-9]{64}$/)])
    .optional(),
  minioSecrets: z
    .tuple([z.string().regex(/^[a-f0-9]{32}$/), z.string().regex(/^[a-f0-9]{64}$/)])
    .optional(),
  minioImage: z
    .string()
    .regex(/^localhost:5001\/krun-test-minio@sha256:[a-f0-9]{64}$/)
    .optional(),
  image: z
    .string()
    .regex(/^localhost:5001\/krun@sha256:[a-f0-9]{64}$/)
    .optional(),
});
const imageSchema = z.object({
  node: z.string().regex(/^kindest\/node:v1\.(?:3[3-9]|[4-9]\d)\.\d+@sha256:[a-f0-9]{64}$/),
  registry: z.string().regex(/^registry:2@sha256:[a-f0-9]{64}$/),
});
type State = z.infer<typeof stateSchema>;
class StepFailure extends Error {}
const run = (
  executable: string,
  args: string[],
  operation: string,
  options: { input?: string; allowFailure?: boolean; timeout?: number } = {},
) => {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (!options.allowFailure && (result.error || result.status !== 0))
    throw new StepFailure(`${operation} failed (exit ${result.status ?? "unavailable"})`);
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const loadState = async (): Promise<State | undefined> => {
  let text: string;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const decoded = stateSchema.safeParse(JSON.parse(text));
  if (!decoded.success) throw new StepFailure("Invalid or foreign private E2E state");
  return decoded.data;
};
const saveState = async (state: State) => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
};
const guardContext = async () => {
  const value = z
    .object({
      "current-context": z.literal(`kind-${cluster}`),
      clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
    })
    .safeParse(parse(await readFile(kubeconfig, "utf8")));
  if (
    !value.success ||
    !["127.0.0.1", "localhost"].includes(
      new URL(value.data.clusters[0]?.cluster.server ?? "").hostname,
    )
  )
    throw new StepFailure("Refusing a non-owned or non-loopback Kubernetes context");
};
const kube = (args: string[], operation: string, options: Parameters<typeof run>[3] = {}) => {
  if (args.some((arg) => /^--(?:context|kubeconfig)(?:=|$)/.test(arg)))
    throw new StepFailure("Cannot override the isolated Kubernetes context");
  return run("kubectl", [...contextArgs(kubeconfig), ...args], operation, options);
};
const apply = (value: unknown, operation: string) =>
  kube(["apply", "-f", "-"], operation, { input: JSON.stringify(value) });
const readManifest = async (name: string, image: string) => {
  const text = (await readFile(join(root, "test/e2e", name), "utf8"))
    .replaceAll("__KRUN_E2E_IMAGE__", image)
    .replaceAll("__KRUN_E2E_MINIO_IMAGE__", image);
  const path = join(stateDir, name);
  await writeFile(path, text, { mode: 0o600 });
  return path;
};
const registry = (image?: string) => {
  const ids = run(
    "docker",
    ["container", "ls", "-a", "--filter", "name=^kind-registry$", "--format", "{{.ID}}"],
    "registry inventory",
  ).stdout.trim();
  if (!ids) return undefined;
  const inspect: unknown[] = JSON.parse(
    run("docker", ["inspect", "kind-registry"], "registry ownership readback").stdout,
  );
  assertRegistryOwner(inspect[0], owner);
  if (image !== undefined) {
    const actual = z.object({ Config: z.object({ Image: z.string() }) }).parse(inspect[0]);
    if (actual.Config.Image !== image)
      throw new StepFailure("Owned registry image differs from its pinned manifest");
  }
  return inspect[0];
};
const clusters = () =>
  run("kind", ["get", "clusters"], "owned cluster inventory").stdout.split(/\s+/).filter(Boolean);
const eventually = async <T>(
  read: () => Promise<T>,
  judge: (value: T) => "done" | "wait" | "fail",
  label: string,
  timeout = 120_000,
) => {
  const end = performance.now() + timeout;
  let lastReadFailed = false;
  while (performance.now() < end) {
    let value: T;
    try {
      value = await read();
      lastReadFailed = false;
    } catch {
      lastReadFailed = true;
      await setTimeout(200);
      continue;
    }
    const verdict = judge(value);
    if (verdict === "done") return value;
    if (verdict === "fail") throw new StepFailure(`${label} reached an invalid state`);
    await setTimeout(200);
  }
  throw new StepFailure(`${label} timed out${lastReadFailed ? " after a read error" : ""}`);
};

const up = async () => {
  const version = (await readFile(join(root, ".kind-version"), "utf8")).trim();
  if (!run("kind", ["version"], "kind version").stdout.startsWith(`kind ${version} `))
    throw new StepFailure("Install the exact kind version from .kind-version");
  run("docker", ["info", "--format", "{{.ServerVersion}}"], "Docker availability");
  const pins = imageSchema.parse(
    JSON.parse(await readFile(join(root, "test/e2e/images.json"), "utf8")),
  );
  let state = await loadState();
  if (clusters().includes(cluster) && !state)
    throw new StepFailure("Refusing an existing cluster without owned state");
  const existingRegistry = registry(pins.registry);
  state ??= { owner, key: randomBytes(32).toString("hex") };
  state.webhookSecrets ??= [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  state.minioSecrets ??= [randomBytes(16).toString("hex"), randomBytes(32).toString("hex")];
  await saveState(state);
  if (!existingRegistry)
    run(
      "docker",
      [
        "run",
        "--detach",
        "--restart=always",
        "--publish",
        "127.0.0.1:5001:5000",
        "--label",
        `krun.io/e2e-owner=${owner}`,
        "--name",
        "kind-registry",
        pins.registry,
      ],
      "create local owned registry",
    );
  else run("docker", ["start", "kind-registry"], "start local owned registry");
  await eventually(
    async () =>
      (await fetch("http://127.0.0.1:5001/v2/", { signal: AbortSignal.timeout(2000) })).status,
    (status) => (status === 200 ? "done" : "fail"),
    "registry readiness",
    30_000,
  );
  if (!clusters().includes(cluster))
    run(
      "kind",
      [
        "create",
        "cluster",
        "--name",
        cluster,
        "--image",
        pins.node,
        "--config",
        "test/e2e/kind.yaml",
        "--kubeconfig",
        kubeconfig,
        "--wait",
        "180s",
      ],
      "create disposable kind cluster",
      { timeout: 300_000 },
    );
  else
    run(
      "kind",
      ["export", "kubeconfig", "--name", cluster, "--kubeconfig", kubeconfig],
      "export owned kubeconfig",
    );
  await chmod(kubeconfig, 0o600);
  await guardContext();
  const connected = run(
    "docker",
    ["inspect", "--format", "{{json .NetworkSettings.Networks}}", "kind-registry"],
    "registry network readback",
  ).stdout;
  if (!Object.hasOwn(JSON.parse(connected), "kind"))
    run("docker", ["network", "connect", "kind", "kind-registry"], "join registry to kind network");
  const nodes = run("kind", ["get", "nodes", "--name", cluster], "owned node inventory")
    .stdout.trim()
    .split(/\s+/);
  if (nodes.length === 0 || nodes.some((node) => !node.startsWith(`${cluster}-`)))
    throw new StepFailure("Unexpected node inventory");
  for (const node of nodes) {
    if (
      run(
        "docker",
        ["inspect", "--format", "{{.Config.Image}}", node],
        "node image readback",
      ).stdout.trim() !== pins.node
    )
      throw new StepFailure(
        "Owned cluster node image differs from its pinned manifest; run kind-down before upgrading",
      );
    run(
      "docker",
      ["exec", node, "mkdir", "-p", "/etc/containerd/certs.d/localhost:5001"],
      "create node registry config directory",
    );
    run(
      "docker",
      ["exec", "-i", node, "cp", "/dev/stdin", "/etc/containerd/certs.d/localhost:5001/hosts.toml"],
      "write per-node registry mirror",
      { input: '[host."http://kind-registry:5000"]\n' },
    );
  }
  apply(
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "local-registry-hosting", namespace: "kube-public" },
      data: {
        "localRegistryHosting.v1":
          'host: "localhost:5001"\nhelp: "https://kind.sigs.k8s.io/docs/user/local-registry/"\n',
      },
    },
    "publish registry discovery",
  );
  console.log("Building current local image for the disposable cluster");
  run("docker", ["build", "--tag", "krun-test-e2e:local", "."], "build current test image", {
    timeout: 600_000,
  });
  run(
    "docker",
    ["tag", "krun-test-e2e:local", "localhost:5001/krun:e2e"],
    "tag local registry image",
  );
  const pushed = run("docker", ["push", "localhost:5001/krun:e2e"], "push only to local registry");
  state.image = `localhost:5001/krun@${parsePushDigest(pushed.stdout)}`;
  await saveState(state);
  // Reuse D106's checksum-enforced upstream binary fixture, never a fake S3 server.
  run(
    "docker",
    ["build", "-t", "krun-test-e2e-minio:local", "-f", "test/minio/Dockerfile", "test/minio"],
    "build genuine pinned MinIO",
    { timeout: 600_000 },
  );
  run(
    "docker",
    ["tag", "krun-test-e2e-minio:local", "localhost:5001/krun-test-minio:e2e"],
    "tag owned MinIO image",
  );
  const minioPush = run(
    "docker",
    ["push", "localhost:5001/krun-test-minio:e2e"],
    "push only owned MinIO image",
  );
  state.minioImage = `localhost:5001/krun-test-minio@${parsePushDigest(minioPush.stdout)}`;
  await saveState(state);
  const minio = await readManifest("minio.yaml", state.minioImage);
  apply(
    parseAllDocuments(await readFile(minio, "utf8"))[0]?.toJSON(),
    "create owned MinIO namespace",
  );
  for (const namespace of ["krun-test-minio"])
    apply(
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name: "krun-test-minio-credentials", namespace },
        stringData: { accessKey: state.minioSecrets[0], secretKey: state.minioSecrets[1] },
      },
      "apply generated private MinIO credentials",
    );
  kube(["apply", "-f", minio], "deploy genuine restricted MinIO");
  kube(
    ["rollout", "status", "deployment/krun-test-minio", "-n", "krun-test-minio", "--timeout=180s"],
    "await genuine MinIO readiness",
    { timeout: 200_000 },
  );
  kube(
    [
      "delete",
      "job/krun-test-minio-init",
      "-n",
      "krun-test-minio",
      "--ignore-not-found",
      "--wait=true",
      "--timeout=60s",
    ],
    "remove previous owned bucket initializer",
  );
  kube(
    ["apply", "-f", await readManifest("minio-init.yaml", state.image)],
    "initialize real S3 bucket",
  );
  kube(
    [
      "wait",
      "job/krun-test-minio-init",
      "-n",
      "krun-test-minio",
      "--for=condition=complete",
      "--timeout=90s",
    ],
    "await real S3 bucket creation",
  );
  console.log(
    JSON.stringify({ foundation: "prepared", cluster, image: state.image, minio: "ready" }),
  );
};

const helm = (args: string[], operation: string) =>
  run(
    "helm",
    ["--kubeconfig", kubeconfig, "--kube-context", `kind-${cluster}`, ...args],
    operation,
    { timeout: 300_000 },
  );

const install = async (mode: DatabaseMode) => {
  const state = await loadState();
  if (!state?.image || !state.webhookSecrets || !state.minioSecrets)
    throw new StepFailure("Run kind-up before chart installation");
  if (state.mode)
    throw new StepFailure("Uninstall the active owned chart before a fresh mode install");
  await guardContext();
  const layout = chartLayout(mode);
  for (const namespace of [
    layout.namespace,
    layout.jobsNamespace,
    layout.monitoringNamespace,
    layout.outsiderNamespace,
  ]) {
    if (
      kube(
        ["get", "namespace", namespace, "--ignore-not-found", "-o", "name"],
        "check fresh namespace",
      ).stdout.trim()
    )
      throw new StepFailure("Chart acceptance requires fresh owned namespaces");
  }
  state.mode = mode;
  await saveState(state); // Own partial setup before the first resource is created.
  for (const namespace of [layout.namespace, layout.monitoringNamespace, layout.outsiderNamespace])
    apply(
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          labels: {
            "krun.io/e2e-owner": owner,
            ...(namespace === layout.monitoringNamespace
              ? { "krun.io/e2e-monitoring": "true" }
              : {}),
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "v1.33",
          },
        },
      },
      "create fresh restricted test namespace",
    );
  for (const [name, stringData] of [
    [
      "krun-e2e-keys",
      {
        "keys.yaml": JSON.stringify({ keys: [{ name: "e2e", key: state.key, scopes: ["admin"] }] }),
      },
    ],
    [
      "krun-e2e-webhook-keys",
      {
        current: state.webhookSecrets[0],
        previous: state.webhookSecrets[1],
        secret: state.webhookSecrets.join(","),
      },
    ],
    [
      "krun-test-minio-credentials",
      { accessKey: state.minioSecrets[0], secretKey: state.minioSecrets[1] },
    ],
  ] as const)
    apply(
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name, namespace: layout.namespace },
        stringData,
      },
      "create private prerequisite Secret references",
    );
  if (mode === "postgres") {
    const password = randomBytes(32).toString("hex");
    state.postgresPassword = password;
    await saveState(state);
    apply(
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name: "krun-test-postgres", namespace: layout.namespace },
        stringData: {
          password,
          dsn: `postgresql://krun:${password}@krun-test-postgres.${layout.namespace}.svc:5432/krun`,
        },
      },
      "create private disposable database settings",
    );
    for (const doc of parseAllDocuments(
      (await readFile(join(root, "test/e2e/postgres.yaml"), "utf8")).replaceAll(
        "__KRUN_E2E_NAMESPACE__",
        layout.namespace,
      ),
    ))
      apply(doc.toJSON(), "deploy plain restricted Postgres");
    kube(
      [
        "rollout",
        "status",
        "deployment/krun-test-postgres",
        "-n",
        layout.namespace,
        "--timeout=180s",
      ],
      "await disposable Postgres",
      { timeout: 200_000 },
    );
  }
  const values = join(stateDir, `values-${mode}.json`);
  await writeFile(values, JSON.stringify(chartValues(mode, state.image)), { mode: 0o600 });
  helm(
    [
      "install",
      release,
      "deploy/helm/krun",
      "--namespace",
      layout.namespace,
      "--values",
      values,
      "--wait=watcher",
      "--timeout=240s",
    ],
    "install actual chart into fresh restricted namespace",
  );
  kube(
    ["wait", "--for=condition=Established", "crd/functions.krun.io", "--timeout=60s"],
    "await chart-managed Function CRD",
  );
  const fn = parse(
    (await readFile(join(root, "test/e2e/function.yaml"), "utf8")).replaceAll(
      "__KRUN_E2E_IMAGE__",
      state.image,
    ),
  );
  fn.metadata.namespace = layout.namespace;
  apply(fn, "apply foundation Function to chart-installed processes");
  await eventually(
    async () =>
      JSON.parse(
        kube(
          ["get", "function", "foundation", "-n", layout.namespace, "-o", "json"],
          "observe chart foundation Function",
        ).stdout,
      ),
    (fn) => {
      if (fn.status?.observedGeneration !== fn.metadata.generation) return "wait";
      const ready = fn.status?.conditions?.find((c: { type: string }) => c.type === "Ready");
      return ready?.status === "True" ? "done" : ready?.status === "False" ? "fail" : "wait";
    },
    "chart-installed Function readiness",
  );
  console.log(
    JSON.stringify({
      chart: "installed",
      mode,
      namespace: layout.namespace,
      jobsNamespace: layout.jobsNamespace,
      psa: "restricted",
      source: "deploy/helm/krun",
      revision: 1,
    }),
  );
};

const uninstall = async () => {
  const state = await loadState();
  if (!state?.mode) throw new StepFailure("No owned chart mode to uninstall");
  await guardContext();
  const layout = chartLayout(state.mode);
  const releases = JSON.parse(
    helm(["list", "-n", layout.namespace, "-o", "json"], "read owned chart inventory").stdout,
  );
  if (releases.some((r: { name: string }) => r.name === release))
    helm(
      ["uninstall", release, "-n", layout.namespace, "--wait=watcher", "--timeout=120s"],
      "uninstall owned chart",
    );
  for (const namespace of [
    layout.namespace,
    layout.monitoringNamespace,
    layout.outsiderNamespace,
  ]) {
    const text = kube(
      ["get", "namespace", namespace, "--ignore-not-found", "-o", "json"],
      "read owned namespace before cleanup",
    ).stdout;
    if (text.trim()) {
      if (JSON.parse(text).metadata.labels?.["krun.io/e2e-owner"] !== owner)
        throw new StepFailure("Refusing non-owned namespace cleanup");
      kube(
        ["delete", "namespace", namespace, "--wait=true", "--timeout=120s"],
        "remove exact owned mode namespace",
        { timeout: 130_000 },
      );
    }
  }
  for (const namespace of [
    layout.namespace,
    layout.jobsNamespace,
    layout.monitoringNamespace,
    layout.outsiderNamespace,
  ])
    if (
      kube(
        ["get", "namespace", namespace, "--ignore-not-found", "-o", "name"],
        "confirm fresh mode cleanup",
      ).stdout.trim()
    )
      throw new StepFailure("Owned chart namespace cleanup was not confirmed");
  console.log(
    JSON.stringify({ chart: "uninstalled", mode: state.mode, freshNamespacesRemoved: true }),
  );
  state.mode = undefined;
  state.postgresPassword = undefined;
  await saveState(state);
};

const verify = async () => {
  const state = await loadState();
  if (!state?.image || !state.mode)
    throw new StepFailure("Install a chart mode before foundation verification");
  const layout = chartLayout(state.mode);
  await guardContext();
  const pins = imageSchema.parse(
    JSON.parse(await readFile(join(root, "test/e2e/images.json"), "utf8")),
  );
  if (!registry(pins.registry)) throw new StepFailure("The owned local registry is absent");
  const namespace = `krun-test-probe-${randomBytes(5).toString("hex")}`;
  let created = false;
  try {
    apply(
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          labels: {
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "v1.33",
          },
        },
      },
      "create scratch probe namespace",
    );
    created = true;
    for (const name of ["server", "client"])
      apply(
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name, namespace },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name,
                image: state.image,
                command: ["/nodejs/bin/node"],
                args: [
                  "-e",
                  name === "server"
                    ? "process.once('SIGTERM',()=>process.exit(0));require('node:http').createServer((_,r)=>r.end('ok')).listen(8080,'0.0.0.0')"
                    : "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},60000)",
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { cpu: "500m", memory: "128Mi" },
                },
                ...(name === "server"
                  ? { readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1 } }
                  : {}),
              },
            ],
          },
        },
        "create restricted network probe pod",
      );
    kube(
      ["wait", "pod", "--all", "-n", namespace, "--for=condition=Ready", "--timeout=90s"],
      "wait for positive probe preconditions",
    );
    const ip = kube(
      ["get", "pod", "server", "-n", namespace, "-o", "jsonpath={.status.podIP}"],
      "read probe server address",
    ).stdout;
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) throw new StepFailure("Invalid probe server address");
    const url = `http://${ip.includes(":") ? `[${ip}]` : ip}:8080`;
    const client = `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1500)}).then(r=>{if(r.status!==200)process.exit(29);console.log('krun-probe-open')}).catch(e=>{if(e.name==='TimeoutError'){console.log('krun-probe-blocked');process.exit(28)}process.exit(29)})`;
    const observe = () =>
      probeVerdict(
        kube(
          ["exec", "-n", namespace, "client", "--", "/nodejs/bin/node", "-e", client],
          "observe actual pod-to-pod connection",
          { allowFailure: true, timeout: 10_000 },
        ),
      );
    if (observe() !== "open") throw new StepFailure("Positive network control did not connect");
    apply(
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "deny-all", namespace },
        spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
      },
      "apply scratch default deny",
    );
    await eventually(
      async () => observe(),
      (result) => (result === "blocked" ? "done" : "wait"),
      "kind/kindnetd NetworkPolicy enforcement",
      30_000,
    );
    kube(
      ["delete", "networkpolicy", "deny-all", "-n", namespace, "--wait=true"],
      "remove scratch deny for recovery witness",
    );
    await eventually(
      async () => observe(),
      (result) => (result === "open" ? "done" : "wait"),
      "network recovery witness",
      30_000,
    );
    const check =
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const k=JSON.parse(s).key;const r=await fetch('http://127.0.0.1:8080/v1/functions/foundation',{headers:{authorization:'Bearer '+k}});const b=await r.json();if(r.status!==200||b.name!=='functions/foundation')process.exit(1);console.log('krun-foundation-api-ok')})";
    const api = kube(
      [
        "exec",
        "-i",
        "-n",
        layout.namespace,
        layout.gateway,
        "-c",
        "gateway",
        "--",
        "/nodejs/bin/node",
        "-e",
        check,
      ],
      "verify real gateway Function projection",
      { input: JSON.stringify({ key: state.key }) },
    );
    if (api.stdout.trim() !== "krun-foundation-api-ok")
      throw new StepFailure("Unexpected public API verification outcome");
    for (const container of ["gateway", "scheduler"]) {
      const logs = kube(
        [
          "logs",
          "-n",
          layout.namespace,
          container === "gateway" ? layout.gateway : layout.scheduler,
          "-c",
          container,
        ],
        "check process credential privacy",
      ).stdout;
      if (logs.includes(state.key))
        throw new StepFailure("Process logs exposed a generated API credential");
    }
    console.log(
      JSON.stringify({
        enforcement: "open-denied-reopened",
        context: `kind-${cluster}`,
        serving: "ready",
        api: "validated",
        suite: "foundation",
      }),
    );
  } finally {
    if (created)
      kube(
        ["delete", "namespace", namespace, "--wait=true", "--timeout=60s"],
        "clean owned scratch namespace",
      );
  }
};

const down = async () => {
  const state = await loadState();
  const exists = clusters().includes(cluster);
  if (exists && !state) throw new StepFailure("Refusing to delete a cluster without owned state");
  const ownedRegistry = registry();
  if (exists)
    run(
      "kind",
      ["delete", "cluster", "--name", cluster, "--kubeconfig", kubeconfig],
      "delete owned kind cluster",
    );
  if (ownedRegistry)
    run("docker", ["rm", "--force", "--volumes", "kind-registry"], "remove owned local registry");
  if (clusters().includes(cluster) || registry())
    throw new StepFailure("Owned infrastructure cleanup was not confirmed");
  await rm(stateDir, { recursive: true, force: true });
  console.log(JSON.stringify({ clusterRemoved: true, registryRemoved: true }));
};

const diagnostics = async () => {
  if (!(await loadState())) return;
  await guardContext();
  const result = kube(
    ["get", "pods", "-A", "-l", "app.kubernetes.io/name=krun", "-o", "json"],
    "read sanitized pod diagnostics",
    { allowFailure: true },
  );
  if (result.code !== 0) return;
  const pods = z
    .object({
      items: z.array(
        z.object({
          metadata: z.object({ name: z.string() }),
          status: z
            .object({
              phase: z.string().optional(),
              containerStatuses: z
                .array(z.object({ name: z.string(), ready: z.boolean(), restartCount: z.number() }))
                .optional(),
            })
            .optional(),
        }),
      ),
    })
    .parse(JSON.parse(result.stdout));
  console.error(
    JSON.stringify({
      pods: pods.items.map((pod) => ({ name: pod.metadata.name, status: pod.status })),
    }),
  );
};

const command = process.argv[2];
const mode = databaseMode.safeParse(process.argv[3]);
if (
  (command === "install"
    ? process.argv.length !== 4 || !mode.success
    : process.argv.length !== 3) ||
  !["up", "down", "verify", "diagnostics", "install", "uninstall"].includes(command ?? "")
) {
  console.error("Usage: cluster.ts up|down|verify|diagnostics|uninstall|install embedded|postgres");
  process.exitCode = 1;
} else {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let locked = false;
  try {
    await mkdir(lock, { mode: 0o700 });
    locked = true;
    if (command === "install" && mode.success) await install(mode.data);
    else if (command === "uninstall") await uninstall();
    else if (command === "up") await up();
    else if (command === "down") await down();
    else if (command === "verify") await verify();
    else await diagnostics();
  } catch (error) {
    console.error(
      error instanceof StepFailure
        ? error.message
        : "E2E foundation failed; no private diagnostic values are printed",
    );
    try {
      await diagnostics();
    } catch {
      /* Diagnostics must not expose raw credentials or mask the failure. */
    }
    process.exitCode = 1;
  } finally {
    if (locked) await rm(lock, { recursive: true, force: true });
  }
}
