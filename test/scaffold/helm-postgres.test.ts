import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const values = parse(readFileSync(`${chart}/values.yaml`, "utf8"));
const render = (sets: string[] = []) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-postgres",
      chart,
      "--namespace",
      "krun-test-platform",
      "--set",
      "apiKeys.existingSecret=krun-test-keys",
      "--set",
      "db.postgres.existingSecret=krun-test-db",
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
const hooks = () => {
  const result = render();
  expect(result.status).toBe(0);
  const job = result.documents.find((d) => d.kind === "Job");
  const account = result.documents.find(
    (d) => d.kind === "ServiceAccount" && d.metadata.name === "krun-migrate",
  );
  expect(job).toBeDefined();
  expect(account).toBeDefined();
  return { job, account };
};
const security = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  seccompProfile: { type: "RuntimeDefault" },
};

it("renders two serving Deployments and exactly one Postgres migration hook Job,not a StatefulSet", () => {
  const { documents } = render();
  expect(documents.filter((d) => d.kind === "Deployment")).toHaveLength(2);
  expect(documents.filter((d) => d.kind === "StatefulSet")).toHaveLength(0);
  expect(documents.filter((d) => d.kind === "Job")).toHaveLength(1);
});
it("orders the migration ServiceAccount before the Job and retains failed-hook diagnostics", () => {
  const { job, account } = hooks();
  for (const [resource, weight] of [
    [account, "-5"],
    [job, "0"],
  ] as const) {
    expect(resource.metadata.annotations).toEqual({
      "helm.sh/hook": "pre-install,pre-upgrade",
      "helm.sh/hook-weight": weight,
      "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
    });
    expect(resource.metadata.namespace).toBe("krun-test-platform");
    expect(resource.metadata.labels["app.kubernetes.io/instance"]).toBe("krun-test-postgres");
    expect(resource.metadata.labels["app.kubernetes.io/component"]).toBe("migrate");
  }
});
it("bounds migration retries and completion and dispatches the actual migrate command", () => {
  const { job, account } = hooks();
  expect(account.automountServiceAccountToken).toBe(false);
  expect(job.spec.backoffLimit).toBe(1);
  expect(job.spec.activeDeadlineSeconds).toBe(240);
  const pod = job.spec.template;
  expect(pod.spec.restartPolicy).toBe("Never");
  expect(pod.spec.serviceAccountName).toBe("krun-migrate");
  expect(pod.spec.automountServiceAccountToken).toBe(false);
  expect(pod.metadata.labels).toEqual({
    "app.kubernetes.io/name": "krun",
    "app.kubernetes.io/instance": "krun-test-postgres",
    "app.kubernetes.io/component": "migrate",
  });
  expect(pod.spec.containers).toHaveLength(1);
  expect(pod.spec.containers[0].args).toEqual(["migrate"]);
  expect(pod.spec.containers[0].command).toBeUndefined();
});
it("applies restricted nonroot hardening,read-only root and writable tmp to the hook", () => {
  const { job } = hooks();
  const pod = job.spec.template.spec;
  const c = pod.containers[0];
  expect(pod.securityContext).toEqual(security);
  expect(c.securityContext).toEqual({
    ...security,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
  expect(pod.volumes).toEqual([{ name: "tmp", emptyDir: {} }]);
  expect(c.volumeMounts).toEqual([{ name: "tmp", mountPath: "/tmp" }]);
  expect(c.resources).toEqual(values.scheduler.resources);
  expect(c.resources.limits.cpu).toBeUndefined();
  expect(pod.terminationGracePeriodSeconds).toBe(30);
  expect(pod.priorityClassName).toBeUndefined();
});
it("uses Job exit/completion rather than probes to a nonexistent migrate admin listener", () => {
  const { job } = hooks();
  const c = job.spec.template.spec.containers[0];
  expect(c.ports).toBeUndefined();
  expect(c.readinessProbe).toBeUndefined();
  expect(c.livenessProbe).toBeUndefined();
  expect(c.startupProbe).toBeUndefined();
});
it("references the existing DB Secret without adding credentials,keys,tokens or RBAC", () => {
  const { job } = hooks();
  const env = job.spec.template.spec.containers[0].env;
  const names = new Set<string>();
  for (const item of env) names.add(item.name);
  expect(names.size).toBe(env.length);
  expect(env).toContainEqual({ name: "KRUN_DB_MODE", value: "postgres" });
  expect(env).toContainEqual({
    name: "KRUN_DB_DSN",
    valueFrom: { secretKeyRef: { name: "krun-test-db", key: "dsn" } },
  });
  for (const name of names)
    expect(
      name.startsWith("KRUN_DB_") ||
        Object.keys(values.config).some(
          (key) => name === `KRUN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`,
        ),
    ).toBe(true);
  for (const d of render().documents) {
    expect(["ClusterRole", "ClusterRoleBinding", "Secret", "ConfigMap", "Function"]).not.toContain(
      d.kind,
    );
    if (d.kind === "Role") expect(d.metadata.name).not.toBe("krun-migrate");
    if (d.kind === "RoleBinding")
      for (const subject of d.subjects) expect(subject.name).not.toBe("krun-migrate");
  }
});
it("maps every config value to exactly one quoted env on all three krun containers", () => {
  const { documents } = render();
  let count = 0;
  for (const resource of documents) {
    if (!["Deployment", "Job"].includes(resource.kind)) continue;
    for (const c of resource.spec.template.spec.containers) {
      count++;
      const env = new Map<string, unknown>();
      for (const item of c.env) {
        expect(env.has(item.name)).toBe(false);
        env.set(item.name, item);
      }
      for (const [key, value] of Object.entries(values.config)) {
        const name = `KRUN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
        expect(env.get(name)).toEqual({ name, value: String(value) });
      }
    }
  }
  expect(count).toBe(3);
});
it("shares scheduler resource and common lifecycle/image overrides with the hook", () => {
  const result = render([
    "image.tag=krun-test-hooks",
    "scheduler.resources.requests.cpu=250m",
    "priorityClassName=krun-test-priority",
    "config.logLevel=debug",
  ]);
  expect(result.status).toBe(0);
  const job = result.documents.find((d) => d.kind === "Job");
  expect(job).toBeDefined();
  expect(job.spec.template.spec.priorityClassName).toBe("krun-test-priority");
  const c = job.spec.template.spec.containers[0];
  expect(c.image).toBe("ghcr.io/xenarro/krun:krun-test-hooks");
  expect(c.resources.requests.cpu).toBe("250m");
  expect(c.env).toContainEqual({ name: "KRUN_LOG_LEVEL", value: "debug" });
});
it.each(["gateway", "scheduler"])(
  "retains both section13 admin probes and resources on the serving %s container",
  (role) => {
    const resource = render().documents.find(
      (d) => d.kind === "Deployment" && d.metadata.labels["app.kubernetes.io/component"] === role,
    );
    expect(resource).toBeDefined();
    const c = resource.spec.template.spec.containers[0];
    expect(c.resources).toEqual(values[role].resources);
    expect(c.readinessProbe).toEqual({
      httpGet: { path: "/readyz", port: "admin" },
      periodSeconds: 5,
      timeoutSeconds: 3,
      failureThreshold: 3,
    });
    expect(c.livenessProbe).toEqual({
      httpGet: { path: "/healthz", port: "admin" },
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
    });
    expect(c.startupProbe).toBeUndefined();
  },
);
it.each(["", "   "])(
  "rejects a missing Postgres existingSecret reference %j even without CRD output",
  (secret) => {
    const result = render(["crds.install=false", `db.postgres.existingSecret=${secret}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("db.postgres.existingSecret");
  },
);
it("omits both migration hooks in embedded common-resource mode", () => {
  const result = render(["db.mode=embedded", "gateway.replicas=1"]);
  expect(result.status).toBe(0);
  expect(result.documents.filter((d) => d.kind === "Job")).toHaveLength(0);
  expect(
    result.documents.some((d) => d.kind === "ServiceAccount" && d.metadata.name === "krun-migrate"),
  ).toBe(false);
});
