import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseAllDocuments, stringify } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const chart = join(root, "deploy/helm/krun");
const release = "krun-test-monitoring";
const namespace = "krun-test-monitoring-platform";
const thresholds = {
  queueWaitP95Seconds: 60,
  jobLostPerHour: 1,
  heartbeatTimeoutsPerHour: 5,
  quotaRejectionsPerMinute: 1,
};
const render = (mode: string, metrics: Record<string, unknown> = {}) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      release,
      chart,
      "--namespace",
      namespace,
      "--set-json",
      JSON.stringify({
        apiKeys: { existingSecret: "krun-test-unused" },
        db: { mode, postgres: { existingSecret: "krun-test-unused" } },
        gateway: { replicas: 1 },
        metrics,
      }),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout)
    .filter((doc) => doc.contents !== null)
    .map((doc) => {
      expect(doc.errors).toEqual([]);
      return doc.toJSON();
    });
};
const expectedRules = (t = thresholds) => [
  [
    "KrunNoLeader",
    "max(krun_scheduler_leader) == 0 or absent(krun_scheduler_leader)",
    "2m",
    "critical",
  ],
  ["KrunFunctionsNotSynced", "min(krun_functions_synced) == 0", "2m", "critical"],
  [
    "KrunJobLost",
    `sum(increase(krun_runs_failed_total{reason="job_lost"}[1h])) > ${t.jobLostPerHour}`,
    "0m",
    "warning",
  ],
  [
    "KrunHeartbeatTimeouts",
    `sum(increase(krun_runs_failed_total{reason="heartbeat_timeout"}[1h])) > ${t.heartbeatTimeoutsPerHour}`,
    "0m",
    "warning",
  ],
  ["KrunDeliveriesDead", 'increase(krun_deliveries_total{state="dead"}[1h]) > 0', "0m", "warning"],
  [
    "KrunQuotaRejections",
    `sum(rate(krun_quota_rejections_total[5m])) * 60 > ${t.quotaRejectionsPerMinute}`,
    "10m",
    "warning",
  ],
  [
    "KrunQueueWaitHigh",
    `histogram_quantile(0.95, sum(rate(krun_queue_wait_seconds_bucket[10m])) by (le)) > ${t.queueWaitP95Seconds}`,
    "10m",
    "warning",
  ],
];
const documentedNames = (file: string) =>
  [...readFileSync(join(root, file), "utf8").matchAll(/^\| `(Krun[A-Za-z]+)` \|/gm)]
    .map((match) => match[1])
    .sort();

for (const mode of ["postgres", "embedded"]) {
  for (const podMonitor of [false, true]) {
    for (const prometheusRule of [false, true]) {
      it(`gates each monitoring kind independently in ${mode}, monitor=${podMonitor}, rules=${prometheusRule}`, () => {
        const docs = render(mode, {
          podMonitor: { enabled: podMonitor, labels: { release: "krun-test-prometheus" } },
          prometheusRule: { enabled: prometheusRule, labels: { release: "krun-test-prometheus" } },
        });
        expect(docs.filter((doc) => doc.kind === "PodMonitor")).toHaveLength(podMonitor ? 1 : 0);
        expect(docs.filter((doc) => doc.kind === "PrometheusRule")).toHaveLength(
          prometheusRule ? 1 : 0,
        );
      });
    }
  }

  it(`selects only same-release serving pods and actual named admin ports in ${mode}`, () => {
    const docs = render(mode, { podMonitor: { enabled: true } });
    const monitor = docs.find((doc) => doc.kind === "PodMonitor");
    expect(monitor).toBeDefined();
    expect(monitor.apiVersion).toBe("monitoring.coreos.com/v1");
    expect(monitor.metadata.name).toBe(release);
    expect(monitor.metadata.namespace).toBe(namespace);
    const ports = mode === "embedded" ? ["admin", "admin-sched"] : ["admin"];
    expect(monitor.spec).toEqual({
      selector: {
        matchLabels: { "app.kubernetes.io/name": "krun", "app.kubernetes.io/instance": release },
      },
      podMetricsEndpoints: ports.map((port) => ({ port, path: "/metrics" })),
    });
    const workloads = docs.filter((doc) => ["StatefulSet", "Deployment"].includes(doc.kind));
    expect(workloads).toHaveLength(mode === "embedded" ? 1 : 2);
    for (const workload of workloads) {
      expect(workload.spec.template.metadata.labels).toMatchObject(
        monitor.spec.selector.matchLabels,
      );
      const adminPorts = workload.spec.template.spec.containers.flatMap(
        (container: { ports: { name: string; containerPort: number }[] }) =>
          container.ports.filter((port) => ports.includes(port.name)),
      );
      expect(adminPorts.map((port: { name: string }) => port.name).sort()).toEqual(ports);
    }
  });

  for (const kind of ["PodMonitor", "PrometheusRule"]) {
    it(`merges ${kind} selection labels without duplicate or overridden identity keys in ${mode}`, () => {
      const key = kind === "PodMonitor" ? "podMonitor" : "prometheusRule";
      const doc = render(mode, {
        [key]: {
          enabled: true,
          labels: {
            release: "krun-test-prometheus",
            "app.kubernetes.io/name": "unrelated",
            "app.kubernetes.io/instance": "other-release",
          },
        },
      }).find((doc) => doc.kind === kind);
      expect(doc).toBeDefined();
      expect(doc.metadata.labels).toMatchObject({
        release: "krun-test-prometheus",
        "app.kubernetes.io/name": "krun",
        "app.kubernetes.io/instance": release,
        "app.kubernetes.io/managed-by": "Helm",
      });
      expect(doc.metadata.namespace).toBe(namespace);
      expect(doc.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
    });
  }

  for (const t of [
    thresholds,
    {
      queueWaitP95Seconds: 0,
      jobLostPerHour: 0,
      heartbeatTimeoutsPerHour: 0,
      quotaRejectionsPerMinute: 0,
    },
    {
      queueWaitP95Seconds: 0.5,
      jobLostPerHour: 1.25,
      heartbeatTimeoutsPerHour: 2.5,
      quotaRejectionsPerMinute: 0.25,
    },
    {
      queueWaitP95Seconds: 123,
      jobLostPerHour: 4,
      heartbeatTimeoutsPerHour: 7,
      quotaRejectionsPerMinute: 2,
    },
  ]) {
    it(`renders exact SPEC rules with thresholds ${JSON.stringify(t)} and passes real promtool in ${mode}`, () => {
      const doc = render(mode, { prometheusRule: { enabled: true, thresholds: t } }).find(
        (doc) => doc.kind === "PrometheusRule",
      );
      expect(doc).toBeDefined();
      expect(doc.apiVersion).toBe("monitoring.coreos.com/v1");
      expect(doc.spec.groups).toHaveLength(1);
      const rules = doc.spec.groups[0].rules;
      expect(doc.spec.groups[0].name).toBe("krun");
      expect(
        rules.map(
          (rule: { alert: string; expr: string; for: string; labels: { severity: string } }) => [
            rule.alert,
            rule.expr,
            rule.for,
            rule.labels.severity,
          ],
        ),
      ).toEqual(expectedRules(t));
      const names = rules.map((rule: { alert: string }) => rule.alert).sort();
      expect(names).toHaveLength(7);
      expect(names).toEqual(documentedNames("SPEC.md"));
      expect(names).toEqual(documentedNames("docs/OPERATIONS.md"));
      const directory = mkdtempSync(join(tmpdir(), "krun-test-promtool-"));
      try {
        const file = join(directory, "rules.yaml");
        writeFileSync(file, stringify(doc.spec));
        const checked = spawnSync("promtool", ["check", "rules", file], { encoding: "utf8" });
        expect(checked.status, checked.error?.message ?? checked.stderr).toBe(0);
        expect(checked.stdout).toContain("7 rules found");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it(`adds only the two requested kinds without changing workloads or network permissions in ${mode}`, () => {
    const normal = render(mode);
    const enabled = render(mode, {
      podMonitor: { enabled: true },
      prometheusRule: { enabled: true },
    });
    expect(enabled.filter((doc) => !["PodMonitor", "PrometheusRule"].includes(doc.kind))).toEqual(
      normal,
    );
    expect(enabled).toHaveLength(normal.length + 2);
  });
}
