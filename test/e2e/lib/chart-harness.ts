import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { chartLayout, databaseMode, release } from "./chart.js";
import { contextArgs, probeVerdict } from "./contracts.js";
import { eventually } from "./wait.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const directory = join(tmpdir(), `krun-test-e2e-${owner}`);
const assert = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const decode = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(label);
  return result.data;
};

export const chartAcceptance = () => {
  const state = decode(
    z.object({
      owner: z.literal(owner),
      mode: databaseMode,
      image: z.string().regex(/^localhost:5001\/krun@sha256:[a-f0-9]{64}$/),
    }),
    JSON.parse(readFileSync(join(directory, "state.json"), "utf8")),
    "Missing owned chart acceptance state",
  );
  const layout = chartLayout(state.mode);
  const kubeconfig = join(directory, "kubeconfig");
  const config = decode(
    z.object({
      "current-context": z.literal("kind-krun-test-e2e"),
      clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
    }),
    parse(readFileSync(kubeconfig, "utf8")),
    "Foreign chart acceptance configuration",
  );
  assert(
    ["127.0.0.1", "localhost"].includes(new URL(config.clusters[0]?.cluster.server ?? "").hostname),
    "Non-loopback chart acceptance configuration",
  );
  const client = { namespace: layout.monitoringNamespace, pod: "krun-test-client" };
  const children: ChildProcess[] = [];
  const run = (
    executable: string,
    args: string[],
    label: string,
    input?: string,
    allowFailure = false,
  ) => {
    const result = spawnSync(executable, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    if (!allowFailure && (result.error || result.status !== 0))
      throw new Error(`${label} failed; private output withheld`);
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const kube = (args: string[], label: string, input?: string, allowFailure = false) =>
    run("kubectl", [...contextArgs(kubeconfig), ...args], label, input, allowFailure);
  const helmArgs = [
    "--kubeconfig",
    kubeconfig,
    "--kube-context",
    "kind-krun-test-e2e",
    "--namespace",
    layout.namespace,
  ];
  const apply = (resource: unknown) =>
    kube(["apply", "-f", "-"], "Create owned restricted probe", JSON.stringify(resource));
  const pods = (component?: string) =>
    decode(
      z.object({
        items: z.array(
          z.object({
            metadata: z.object({
              name: z.string(),
              uid: z.string(),
              labels: z.record(z.string(), z.string()),
              deletionTimestamp: z.string().optional(),
            }),
            spec: z.object({
              containers: z.array(
                z.object({
                  name: z.string(),
                  env: z
                    .array(z.object({ name: z.string(), value: z.string().optional() }))
                    .optional(),
                }),
              ),
            }),
            status: z
              .object({
                podIP: z.string().optional(),
                conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
              })
              .optional(),
          }),
        ),
      }),
      JSON.parse(
        kube(
          [
            "get",
            "pods",
            "-n",
            layout.namespace,
            "-l",
            `app.kubernetes.io/instance=${release},app.kubernetes.io/name=krun${component ? `,app.kubernetes.io/component=${component}` : ",app.kubernetes.io/component in (embedded,gateway,scheduler)"}`,
            "-o",
            "json",
          ],
          "Read chart-owned serving Pods",
        ).stdout,
      ),
      "Invalid serving Pod projection",
    ).items;
  const probe = (namespace: string, host: string, port: number) =>
    probeVerdict(
      kube(
        [
          "exec",
          "-i",
          "-n",
          namespace,
          "krun-test-client",
          "--",
          "/nodejs/bin/node",
          "--input-type=module",
          "-e",
          `import net from "node:net";import {readFileSync} from "node:fs";const p=JSON.parse(readFileSync(0,"utf8"));const s=net.connect(p);s.setTimeout(1500);s.once("connect",()=>{console.log("krun-probe-open");s.destroy()});s.once("timeout",()=>{console.log("krun-probe-blocked");s.destroy();process.exitCode=28});s.once("error",()=>{process.exitCode=29});`,
        ],
        "Observe chart data-plane connection",
        JSON.stringify({ host, port }),
        true,
      ),
    );
  const requireProbe = async (
    namespace: string,
    host: string,
    port: number,
    result: "open" | "blocked",
  ) =>
    eventually(
      async () => probe(namespace, host, port),
      (value) => (value === result ? "done" : "wait"),
      `Chart ${result} network witness`,
      30_000,
    );
  const metrics = (host: string, port: number) =>
    kube(
      [
        "exec",
        "-i",
        "-n",
        client.namespace,
        client.pod,
        "--",
        "/nodejs/bin/node",
        "--input-type=module",
        "-e",
        `import {readFileSync} from "node:fs";const p=JSON.parse(readFileSync(0,"utf8"));try{const r=await fetch("http://"+p.host+":"+p.port+"/metrics",{signal:AbortSignal.timeout(3000)});if(r.status!==200)process.exitCode=1;else process.stdout.write(await r.text())}catch{process.exitCode=1}`,
      ],
      "Scrape actual selected admin endpoint",
      JSON.stringify({ host, port }),
    ).stdout;
  const leader = async (excluded = new Set<string>()) =>
    eventually(
      async () => {
        const current = pods("scheduler").filter((p) => !p.metadata.deletionTimestamp);
        if (
          current.length !== 2 ||
          current.some(
            (p) => !p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
          )
        )
          return undefined;
        const gauges = current.map((p) => {
          const match = metrics(
            decode(z.ipv4(), p.status?.podIP, "Missing valid scheduler Pod IP"),
            9090,
          ).match(/^krun_scheduler_leader ([01])$/m);
          assert(match, "Scheduler leader gauge is absent or invalid");
          return { pod: p.metadata.name, uid: p.metadata.uid, value: Number(match?.[1]) };
        });
        const lease = decode(
          z.object({
            metadata: z.object({ uid: z.string() }),
            spec: z.object({ holderIdentity: z.string() }),
          }),
          JSON.parse(
            kube(
              ["get", "lease", "krun-scheduler", "-n", layout.namespace, "-o", "json"],
              "Read actual scheduler Lease",
            ).stdout,
          ),
          "Invalid scheduler Lease",
        );
        const elected = gauges.find((g) => g.value === 1);
        if (
          gauges.reduce((sum, g) => sum + g.value, 0) !== 1 ||
          elected?.pod !== lease.spec.holderIdentity ||
          current.some((p) => excluded.has(p.metadata.uid))
        )
          return undefined;
        return { leaseUid: lease.metadata.uid, holder: lease.spec.holderIdentity, gauges };
      },
      (value) => (value ? "done" : "wait"),
      "Exactly one Ready scheduler leader and matching Lease",
      120_000,
    );
  const status = () =>
    JSON.parse(
      run(
        "helm",
        [...helmArgs, "status", release, "-o", "json"],
        "Read actual Helm execution status",
      ).stdout,
    );
  const hook = () => {
    const result = status().hooks?.find((h: { name: string }) => h.name === `${release}-migrate`);
    const receipt = decode(
      z.object({
        last_run: z.object({
          phase: z.literal("Succeeded"),
          started_at: z.string(),
          completed_at: z.string(),
        }),
      }),
      result,
      "Migration hook lacks successful native execution receipt",
    );
    assert(
      Number.isFinite(Date.parse(receipt.last_run.started_at)) &&
        Date.parse(receipt.last_run.completed_at) >= Date.parse(receipt.last_run.started_at),
      "Invalid migration execution interval",
    );
    assert(
      !kube(
        [
          "get",
          "job",
          `${release}-migrate`,
          "-n",
          layout.namespace,
          "--ignore-not-found",
          "-o",
          "name",
        ],
        "Verify successful hook Job deletion",
      ).stdout.trim(),
      "Successful migration hook was not cleaned",
    );
    return receipt.last_run;
  };
  const publicReady = () =>
    eventually(
      async () =>
        probeVerdict(
          kube(
            [
              "exec",
              "-i",
              "-n",
              client.namespace,
              client.pod,
              "--",
              "/nodejs/bin/node",
              "--input-type=module",
              "-e",
              `import {readFileSync} from "node:fs";const p=JSON.parse(readFileSync(0,"utf8"));try{const r=await fetch("http://"+p.host+":8080/v1/functions",{method:"GET",signal:AbortSignal.timeout(3000)});if(r.status===401)console.log("krun-probe-open");else process.exitCode=29}catch(e){if(e.name==="TimeoutError"){console.log("krun-probe-blocked");process.exitCode=28}else process.exitCode=29}`,
            ],
            "Public Service unauthenticated readiness",
            JSON.stringify({ host: `${release}.${layout.namespace}.svc` }),
            true,
          ),
        ),
      (value) => (value === "open" ? "done" : "wait"),
      "Public Service HTTP convergence after serving Pod readiness",
      30_000,
    );
  const waitReady = async (excluded = new Set<string>()) => {
    for (const workload of new Set([layout.gateway, layout.scheduler]))
      kube(
        ["rollout", "status", workload, "-n", layout.namespace, "--timeout=180s"],
        "Await actual chart workload rollout",
      );
    // Deployment rollout acknowledgement may precede old Pod deletion. Keep the
    // strict Ready/count/identity condition, but observe its actual convergence.
    const ready = await eventually(
      async () => pods(),
      (current) =>
        current.length === (state.mode === "embedded" ? 1 : 4) &&
        current.every(
          (p) =>
            !p.metadata.deletionTimestamp &&
            !excluded.has(p.metadata.uid) &&
            p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
        )
          ? "done"
          : "wait",
      "Exact Ready serving Pod set after chart rollout",
    );
    // A Ready replacement Pod does not prove kube-proxy/Service convergence.
    // Observe only a GET before allowing the caller's single mutating POST.
    await publicReady();
    console.log(
      JSON.stringify({
        scenario: "chart",
        mode: state.mode,
        publicServiceReady: true,
        unauthenticatedStatus: 401,
      }),
    );
    return ready;
  };
  const change = (operation: "upgrade" | "rollback") => {
    const args =
      operation === "upgrade"
        ? [
            "upgrade",
            release,
            "deploy/helm/krun",
            "--reuse-values",
            "--set",
            "config.logLevel=debug",
          ]
        : ["rollback", release, "1"];
    const child = spawn("helm", [...helmArgs, ...args, "--wait=watcher", "--timeout=240s"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.resume();
    child.stderr?.resume();
    let active = true;
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", () => {
        active = false;
        reject(new Error(`Chart ${operation} process failed`));
      });
      child.once("exit", (code) => {
        active = false;
        code === 0
          ? resolve()
          : reject(new Error(`Chart ${operation} failed; private output withheld`));
      });
    });
    // Retain failure for the awaited call without an unhandled rejection while observing rollout.
    void done.catch(() => undefined);
    return { done, active: () => active };
  };
  return {
    mode: state.mode,
    client,
    async start() {
      assert(status().version === 1, "Chart acceptance requires fresh Helm revision one");
      for (const namespace of [
        layout.namespace,
        layout.jobsNamespace,
        layout.monitoringNamespace,
        layout.outsiderNamespace,
      ]) {
        const ns = JSON.parse(
          kube(["get", "namespace", namespace, "-o", "json"], "Read actual namespace PSA").stdout,
        );
        assert(
          ns.metadata.labels["pod-security.kubernetes.io/enforce"] === "restricted",
          "Acceptance namespace lacks enforced restricted PSA",
        );
      }
      for (const namespace of [
        layout.monitoringNamespace,
        layout.outsiderNamespace,
        layout.jobsNamespace,
      ]) {
        apply({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "krun-test-client", namespace },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "client",
                image: state.image,
                command: [
                  "/nodejs/bin/node",
                  "-e",
                  "process.once('SIGTERM',()=>process.exit(0));setInterval(()=>{},60000)",
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
              },
            ],
          },
        });
        kube(
          [
            "wait",
            "pod/krun-test-client",
            "-n",
            namespace,
            "--for=condition=Ready",
            "--timeout=90s",
          ],
          "Await positive network probe preconditions",
        );
      }
      await waitReady();
      if (state.mode === "postgres") {
        hook();
        await leader();
      }
    },
    async policies() {
      const internal = `krun-gateway-internal.${layout.namespace}.svc`;
      const publicHost = `${release}.${layout.namespace}.svc`;
      await requireProbe(layout.outsiderNamespace, publicHost, 8080, "open");
      await requireProbe(layout.jobsNamespace, internal, 8081, "open");
      await requireProbe(layout.jobsNamespace, publicHost, 8080, "blocked");
      await requireProbe(layout.outsiderNamespace, internal, 8081, "blocked");
      const targets = pods();
      for (const pod of targets) {
        const host = decode(z.ipv4(), pod.status?.podIP, "Missing valid serving Pod IP");
        if (pod.metadata.labels["krun.io/gateway"] === "true") {
          await requireProbe(layout.jobsNamespace, host, 8081, "open");
          await requireProbe(layout.jobsNamespace, host, 8080, "blocked");
        }
        for (const container of pod.spec.containers) {
          const port = container.name === "scheduler" && state.mode === "embedded" ? 9091 : 9090;
          await requireProbe(layout.monitoringNamespace, host, port, "open");
          assert(
            metrics(host, port).includes("krun_"),
            "Selected admin endpoint lacks krun metrics",
          );
          await requireProbe(layout.outsiderNamespace, host, port, "blocked");
        }
      }
      assert(
        targets.filter((p) => p.metadata.labels["krun.io/gateway"] === "true").length ===
          (state.mode === "embedded" ? 1 : 2),
        "Actual gateway Pods do not match chart 8081 policy",
      );
      kube(
        ["label", "namespace", layout.monitoringNamespace, "krun.io/e2e-monitoring-"],
        "Remove only owned monitoring selection",
      );
      try {
        for (const pod of targets)
          for (const container of pod.spec.containers)
            await requireProbe(
              layout.monitoringNamespace,
              decode(z.ipv4(), pod.status?.podIP, "Missing valid serving Pod IP"),
              container.name === "scheduler" && state.mode === "embedded" ? 9091 : 9090,
              "blocked",
            );
      } finally {
        kube(
          [
            "label",
            "namespace",
            layout.monitoringNamespace,
            "krun.io/e2e-monitoring=true",
            "--overwrite",
          ],
          "Restore exact monitoring selection",
        );
      }
      for (const pod of targets)
        for (const container of pod.spec.containers)
          await requireProbe(
            layout.monitoringNamespace,
            decode(z.ipv4(), pod.status?.podIP, "Missing valid serving Pod IP"),
            container.name === "scheduler" && state.mode === "embedded" ? 9091 : 9090,
            "open",
          );
      const minio = "krun-test-minio.krun-test-minio.svc.cluster.local";
      await requireProbe(layout.jobsNamespace, minio, 9000, "open");
      const policy = JSON.parse(
        kube(
          [
            "get",
            "networkpolicy",
            "krun-jobs-allow-object-storage",
            "-n",
            layout.jobsNamespace,
            "-o",
            "json",
          ],
          "Read exact chart storage egress",
        ).stdout,
      );
      const restore = {
        apiVersion: policy.apiVersion,
        kind: policy.kind,
        metadata: {
          name: policy.metadata.name,
          namespace: policy.metadata.namespace,
          labels: policy.metadata.labels,
          annotations: policy.metadata.annotations,
        },
        spec: policy.spec,
      };
      kube(
        [
          "delete",
          "networkpolicy",
          policy.metadata.name,
          "-n",
          layout.jobsNamespace,
          "--wait=true",
        ],
        "Remove only chart storage allow for negative witness",
      );
      try {
        await requireProbe(layout.jobsNamespace, minio, 9000, "blocked");
      } finally {
        kube(
          ["create", "-f", "-"],
          "Restore exact chart-owned storage allow",
          JSON.stringify(restore),
        );
      }
      await requireProbe(layout.jobsNamespace, minio, 9000, "open");
      console.log(
        JSON.stringify({
          scenario: "chart",
          mode: state.mode,
          internal8081: "jobs-only",
          public8080: "blocked-from-jobs",
          actualGatewayPolicyMatches: true,
          selectedAdminPorts: "open-denied-reopened",
          outsiderAdmin: "blocked",
          chartMinioEgress: "open-denied-reopened",
        }),
      );
    },
    admission() {
      const pod = {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65532,
          runAsGroup: 65532,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "control",
            image: state.image,
            command: ["/nodejs/bin/node", "-e", "process.exit(0)"],
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          },
        ],
      };
      const job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: "krun-test-digest-control", namespace: layout.jobsNamespace },
        spec: { template: { spec: pod } },
      };
      kube(
        ["create", "--dry-run=server", "-f", "-"],
        "Positive digest Job admission",
        JSON.stringify(job),
      );
      const tag = {
        ...job,
        metadata: { ...job.metadata, name: "krun-test-tag-denied" },
        spec: {
          template: {
            spec: {
              ...pod,
              containers: [{ ...pod.containers[0], image: "localhost:5001/krun:e2e" }],
            },
          },
        },
      };
      for (const dry of [true, false]) {
        const denied = kube(
          ["create", ...(dry ? ["--dry-run=server"] : []), "-f", "-"],
          "Native hand-created tag-only Job denial",
          JSON.stringify(tag),
          true,
        );
        assert(
          denied.code !== 0 && denied.stderr.includes("krun-jobs-digest"),
          "Tag-only Job lacks actual chart digest-policy denial",
        );
      }
      assert(
        !kube(
          [
            "get",
            "job",
            tag.metadata.name,
            "-n",
            layout.jobsNamespace,
            "--ignore-not-found",
            "-o",
            "name",
          ],
          "Read back rejected Job absence",
        ).stdout.trim(),
        "Rejected tag-only Job exists",
      );
      console.log(
        JSON.stringify({
          scenario: "chart",
          mode: state.mode,
          digestPinnedJobAdmitted: true,
          tagOnlyJobRejectedByChartPolicy: true,
          rejectedJobAbsent: true,
        }),
      );
    },
    leader,
    hook,
    waitReady,
    change,
    async rolling(oldUids: Set<string>, active: () => boolean) {
      await eventually(
        async () => pods(),
        (current) => {
          assert(active(), "Helm change completed before the during-rollout submission witness");
          return current.some((p) => !oldUids.has(p.metadata.uid)) &&
            current.some((p) => oldUids.has(p.metadata.uid))
            ? "done"
            : "wait";
        },
        "Observed new and old serving Pods during actual rollout",
        120_000,
      );
    },
    assertLogLevel(level: string) {
      assert(
        pods().every((pod) =>
          pod.spec.containers.every(
            (container) =>
              container.env?.find((entry) => entry.name === "KRUN_LOG_LEVEL")?.value === level,
          ),
        ),
        "Chart rollout logLevel does not match requested revision",
      );
    },
    async close() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await eventually(
            async () => child.exitCode !== null || child.signalCode !== null,
            (done) => (done ? "done" : "wait"),
            "Owned Helm child termination",
            10_000,
          );
        }
      for (const namespace of [
        layout.monitoringNamespace,
        layout.outsiderNamespace,
        layout.jobsNamespace,
      ])
        kube(
          [
            "delete",
            "pod",
            "krun-test-client",
            "-n",
            namespace,
            "--ignore-not-found",
            "--wait=true",
            "--timeout=60s",
          ],
          "Clean exact owned chart probes",
        );
    },
  };
};
