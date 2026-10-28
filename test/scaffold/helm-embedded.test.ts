import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const values = parse(readFileSync(`${chart}/values.yaml`, "utf8"));
const image = `litestream/litestream@sha256:${"ab".repeat(32)}`;
const enabled = [
  "db.embedded.litestream.enabled=true",
  `db.embedded.litestream.image=${image}`,
  "db.embedded.litestream.existingSecret=krun-test-backup",
];
const render = (sets: string[] = [], release = "krun-test-embedded") => {
  const result = spawnSync(
    "helm",
    [
      "template",
      release,
      chart,
      "--namespace",
      "krun-test-platform",
      "--set",
      "apiKeys.existingSecret=krun-test-keys",
      "--set",
      "db.mode=embedded",
      "--set",
      "gateway.replicas=1",
      ...sets.flatMap((s) => ["--set", s]),
    ],
    { encoding: "utf8" },
  );
  const documents =
    result.status === 0
      ? parseAllDocuments(result.stdout)
          .filter((d) => d.contents !== null)
          .map((d) => {
            expect(d.errors).toEqual([]);
            return d.toJSON();
          })
      : [];
  return { ...result, documents };
};
const state = (sets: string[] = []) => {
  const result = render(sets);
  expect(result.status, result.stderr).toBe(0);
  const sts = result.documents.find((d) => d.kind === "StatefulSet");
  expect(sts).toBeDefined();
  return { sts, pod: sts.spec.template.spec, documents: result.documents };
};
it.each(["embedded", "postgres"])(
  "binds %s serving processes to the actual release namespace",
  (mode) => {
    const result = render([`db.mode=${mode}`, "db.postgres.existingSecret=krun-test-db"]);
    expect(result.status).toBe(0);
    for (const d of result.documents.filter((d) => ["StatefulSet", "Deployment"].includes(d.kind)))
      for (const c of d.spec.template.spec.containers)
        expect(c.env).toContainEqual({ name: "KRUN_NAMESPACE", value: "krun-test-platform" });
  },
);

const security = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  seccompProfile: { type: "RuntimeDefault" },
};

it("renders one single-replica StatefulSet with two real serving processes and no Postgres workloads", () => {
  const { sts, pod, documents } = state();
  expect(sts.spec.replicas).toBe(1);
  expect(sts.metadata.namespace).toBe("krun-test-platform");
  expect(pod.containers.map((c: { name: string }) => c.name)).toEqual(["gateway", "scheduler"]);
  expect(pod.containers.map((c: { args: string[] }) => c.args)).toEqual([
    ["gateway"],
    ["scheduler"],
  ]);
  expect(documents.filter((d) => ["Deployment", "Job"].includes(d.kind))).toEqual([]);
  expect(
    documents.some(
      (d) =>
        d.kind === "ServiceAccount" && ["krun-gateway", "krun-migrate"].includes(d.metadata.name),
    ),
  ).toBe(false);
  expect(sts.spec.template.metadata.labels["krun.io/gateway"]).toBe("true");
});
it.each(["gateway", "scheduler"])(
  "rejects embedded %s replicas above one even when CRD is disabled",
  (role) => {
    const result = render([`${role}.replicas=2`, "crds.install=false"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${role}.replicas`);
  },
);
it.each(["image", "existingSecret"])(
  "rejects enabled Litestream without %s, including whitespace",
  (key) => {
    for (const value of ["", "   "]) {
      const result = render([
        ...enabled,
        `db.embedded.litestream.${key}=${value}`,
        "crds.install=false",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`db.embedded.litestream.${key}`);
    }
  },
);
it("ignores disabled Litestream settings and runs only real migrate before serving", () => {
  const { pod } = state();
  expect(pod.initContainers.map((c: { name: string }) => c.name)).toEqual(["migrate"]);
  expect(pod.initContainers[0].args).toEqual(["migrate"]);
  expect(pod.initContainers[0].command).toBeUndefined();
});
it("orders restore, native sidecar and migrate, never a regular Litestream container", () => {
  const { pod } = state(enabled);
  expect(pod.initContainers.map((c: { name: string }) => c.name)).toEqual([
    "litestream-restore",
    "litestream",
    "migrate",
  ]);
  expect(pod.initContainers[1].restartPolicy).toBe("Always");
  expect(pod.initContainers[0].restartPolicy).toBeUndefined();
  expect(pod.initContainers[2].restartPolicy).toBeUndefined();
  expect(pod.initContainers.slice(0, 2).map((c: { image: string }) => c.image)).toEqual([
    image,
    image,
  ]);
  expect(pod.initContainers[1].args).toEqual([
    "replicate",
    "/data/krun.db",
    values.db.embedded.litestream.url,
  ]);
});
it("removes only orphan WAL/SHM and passes the restore URL as data, not shell source", () => {
  const { pod } = state([
    ...enabled,
    "db.embedded.litestream.url=s3://bucket/a;touch /tmp/krun-test-injected",
  ]);
  const restore = pod.initContainers[0];
  expect(restore.command).toEqual(["/bin/sh", "-ec"]);
  expect(restore.args[0]).toContain("if [ ! -f /data/krun.db ]; then");
  expect(restore.args[0]).toContain("rm -f /data/krun.db-wal /data/krun.db-shm");
  expect(restore.args[0]).toContain(
    'litestream restore -if-replica-exists -if-db-not-exists -o /data/krun.db "$1"',
  );
  expect(restore.args[0]).not.toContain("s3://");
  expect(restore.args[2]).toBe("s3://bucket/a;touch /tmp/krun-test-injected");
});
it("mounts one RWO PVC at /data on all processes with fsGroup ownership", () => {
  const { sts, pod } = state(enabled);
  expect(pod.securityContext).toEqual({
    ...security,
    fsGroup: 65532,
    fsGroupChangePolicy: "OnRootMismatch",
  });
  expect(sts.spec.volumeClaimTemplates).toEqual([
    {
      metadata: { name: "data" },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } },
    },
  ]);
  for (const c of [...pod.containers, ...pod.initContainers]) {
    expect(c.volumeMounts).toContainEqual({ name: "data", mountPath: "/data" });
    expect(c.volumeMounts).toContainEqual({ name: "tmp", mountPath: "/tmp" });
    expect(c.securityContext).toEqual({
      ...security,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  }
});
it("sets storageClassName only for a nonempty class and respects requested capacity", () => {
  const { sts } = state(["db.embedded.storageClass=krun-test-local", "db.embedded.storage=2Gi"]);
  expect(sts.spec.volumeClaimTemplates[0].spec.storageClassName).toBe("krun-test-local");
  expect(sts.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("2Gi");
  expect(state().sts.spec.volumeClaimTemplates[0].spec).not.toHaveProperty("storageClassName");
});
it("gives each serving container its own named admin port and exact probes/resources", () => {
  const { pod } = state();
  for (const c of pod.containers) {
    const admin = c.name === "gateway" ? "admin" : "admin-sched";
    expect(c.ports).toContainEqual({
      name: admin,
      containerPort: c.name === "gateway" ? 9090 : 9091,
    });
    expect(c.readinessProbe).toEqual({
      httpGet: { path: "/readyz", port: admin },
      periodSeconds: 5,
      timeoutSeconds: 3,
      failureThreshold: 3,
    });
    expect(c.livenessProbe).toEqual({
      httpGet: { path: "/healthz", port: admin },
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    });
    expect(c.startupProbe).toBeUndefined();
    expect(c.resources).toEqual(values[c.name].resources);
    expect(c.resources.limits.cpu).toBeUndefined();
  }
  expect(pod.containers[0].ports).toEqual([
    { name: "http", containerPort: 8080 },
    { name: "internal", containerPort: 8081 },
    { name: "admin", containerPort: 9090 },
  ]);
  expect(pod.containers[1].env).toContainEqual({ name: "KRUN_ADMIN_LISTEN_ADDR", value: ":9091" });
});
it("sets every quoted config key and embedded DB path exactly once on all krun containers", () => {
  const { pod } = state();
  for (const c of [...pod.containers, pod.initContainers[0]]) {
    const names = c.env.map((e: { name: string }) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(c.env).toContainEqual({ name: "KRUN_DB_MODE", value: "embedded" });
    expect(c.env).toContainEqual({ name: "KRUN_DB_PATH", value: "/data/krun.db" });
    expect(names).not.toContain("KRUN_DB_DSN");
    for (const [key, value] of Object.entries(values.config))
      expect(c.env).toContainEqual({
        name: `KRUN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`,
        value: String(value),
      });
  }
});
it("uses the scheduler account but explicitly projects API access only into the two apps", () => {
  const { pod, documents } = state(enabled);
  expect(pod.serviceAccountName).toBe("krun-scheduler");
  expect(pod.automountServiceAccountToken).toBe(false);
  const token = pod.volumes.find((v: { name: string }) => v.name === "kube-api-access");
  expect(token.projected.sources).toEqual([
    { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
    { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
    {
      downwardAPI: {
        items: [
          { path: "namespace", fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" } },
        ],
      },
    },
  ]);
  for (const c of pod.containers)
    expect(c.volumeMounts).toContainEqual({
      name: "kube-api-access",
      mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
      readOnly: true,
    });
  for (const c of pod.initContainers) {
    expect(
      c.volumeMounts.some((m: { name: string }) =>
        ["kube-api-access", "api-keys"].includes(m.name),
      ),
    ).toBe(false);
    expect(c.readinessProbe).toBeUndefined();
    expect(c.livenessProbe).toBeUndefined();
  }
  expect(
    documents.some(
      (d) =>
        d.kind === "RoleBinding" &&
        d.subjects.some((s: { name: string }) => s.name === "krun-gateway"),
    ),
  ).toBe(false);
});
it("references exactly the two Litestream Secret keys only on restore and replicate", () => {
  const { pod } = state(enabled);
  for (const c of pod.initContainers.slice(0, 2)) {
    expect(c.env).toEqual(
      ["LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY"].map((key) => ({
        name: key,
        valueFrom: { secretKeyRef: { name: "krun-test-backup", key } },
      })),
    );
    expect(c.envFrom).toBeUndefined();
    expect(c.resources).toEqual(values.scheduler.resources);
  }
  for (const c of [...pod.containers, pod.initContainers[2]])
    expect(c.env.some((e: { name: string }) => e.name.startsWith("LITESTREAM_"))).toBe(false);
  expect(pod.containers[0].volumeMounts).toContainEqual({
    name: "api-keys",
    mountPath: "/etc/krun",
    readOnly: true,
  });
  expect(pod.containers[1].volumeMounts.some((m: { name: string }) => m.name === "api-keys")).toBe(
    false,
  );
});
it.each([
  "krun-test-embedded",
  "gateway.internal",
  "krun-gateway-internal",
  "true",
  "123",
  "a".repeat(44) + "-headless",
  "1" + "a".repeat(52),
])("uses a distinct DNS-label-safe headless Service for release %s", (release) => {
  const result = render([], release);
  expect(result.status, result.stderr).toBe(0);
  const sts = result.documents.find((d) => d.kind === "StatefulSet");
  expect(sts).toBeDefined();
  const services = result.documents.filter((d) => d.kind === "Service");
  expect(services).toHaveLength(3);
  expect(new Set(services.map((s) => s.metadata.name)).size).toBe(3);
  const service = services.find((s) => s.spec.clusterIP === "None");
  expect(service.metadata.name).toBe(sts.spec.serviceName);
  expect(service.metadata.name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
  expect(service.metadata.name.length).toBeLessThanOrEqual(63);
  expect(service.spec.ports).toBeUndefined();
  expect(service.spec.selector).toEqual({
    "app.kubernetes.io/name": "krun",
    "app.kubernetes.io/instance": release,
  });
});
it("shares image,priority,grace and resources overrides and never renders owned credential resources", () => {
  const { pod, documents } = state([
    "image.tag=krun-test-embedded",
    "priorityClassName=krun-test-priority",
    "terminationGracePeriodSeconds=45",
    "scheduler.resources.requests.cpu=250m",
  ]);
  expect(pod.priorityClassName).toBe("krun-test-priority");
  expect(pod.terminationGracePeriodSeconds).toBe(45);
  for (const c of [...pod.containers, ...pod.initContainers])
    expect(c.image).toBe("ghcr.io/xenarro/krun:krun-test-embedded");
  expect(pod.containers[1].resources.requests.cpu).toBe("250m");
  expect(pod.initContainers[0].resources.requests.cpu).toBe("250m");
  for (const d of documents)
    expect(["Secret", "ConfigMap", "Function", "ClusterRole", "ClusterRoleBinding"]).not.toContain(
      d.kind,
    );
});
