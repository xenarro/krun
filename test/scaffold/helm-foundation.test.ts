import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const render = (sets: string[] = [], keys = "krun-test-api-keys") => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-foundation",
      chart,
      "--namespace",
      "krun-test-platform",
      "--set",
      `apiKeys.existingSecret=${keys}`,
      "--set",
      "db.postgres.existingSecret=krun-test-db",
      ...sets.flatMap((value) => ["--set", value]),
    ],
    { encoding: "utf8" },
  );
  return {
    ...result,
    documents:
      result.status === 0
        ? parseAllDocuments(result.stdout)
            .filter((d) => d.contents !== null)
            .map((d) => {
              expect(d.errors).toEqual([]);
              return d.toJSON();
            })
        : [],
  };
};

it("ships the complete section13 values without additional knobs", () => {
  const spec = readFileSync(new URL("../../SPEC.md", import.meta.url), "utf8");
  const section = spec.slice(spec.indexOf("## 13. Deployment"));
  const expected = parse(
    section.slice(
      section.indexOf("```yaml") + 7,
      section.indexOf("```", section.indexOf("```yaml") + 7),
    ),
  );
  expect(parse(readFileSync(`${chart}/values.yaml`, "utf8"))).toEqual(expected);
});

it.each(["postgres", "embedded"])(
  "renders the %s common resources without secret or owner-resource creation",
  (mode) => {
    const result = render([`db.mode=${mode}`, "gateway.replicas=1"]);
    expect(result.status).toBe(0);
    expect(result.documents.length).toBeGreaterThan(3);
    expect(result.documents.some((d) => ["Secret", "ConfigMap", "Function"].includes(d.kind))).toBe(
      false,
    );
    expect(result.stdout).not.toMatch(/\bsubPath:/);
    const services = result.documents.filter((d) => d.kind === "Service");
    expect(services.map((d) => d.metadata.name).sort()).toEqual([
      "krun-gateway-internal",
      "krun-test-foundation",
    ]);
    expect(
      services.flatMap((d) => d.spec.ports.map((p: { port: number }) => p.port)).sort(),
    ).toEqual([8080, 8081]);
    for (const service of services) {
      expect(service.spec.selector).toEqual({
        "app.kubernetes.io/name": "krun",
        "app.kubernetes.io/instance": "krun-test-foundation",
        "krun.io/gateway": "true",
      });
      expect(service.metadata.namespace).toBe("krun-test-platform");
    }
    const accounts = result.documents.filter(
      (d) => d.kind === "ServiceAccount" && !d.metadata.annotations?.["helm.sh/hook"],
    );
    expect(accounts.map((d) => d.metadata.name).sort()).toEqual(
      mode === "embedded" ? ["krun-scheduler"] : ["krun-gateway", "krun-scheduler"],
    );
  },
);

it.each([false, true])("keeps the generated CRD under install=%s", (install) => {
  const result = render([`crds.install=${install}`]);
  expect(result.status).toBe(0);
  expect(result.documents.filter((d) => d.kind === "CustomResourceDefinition")).toHaveLength(
    install ? 1 : 0,
  );
});
it.each([false, true])("keeps the generated CRD annotation under keep=%s", (keep) => {
  const result = render([`crds.keep=${keep}`]);
  expect(result.status).toBe(0);
  const crd = result.documents.find((d) => d.kind === "CustomResourceDefinition");
  expect(crd.metadata.annotations?.["helm.sh/resource-policy"]).toBe(keep ? "keep" : undefined);
});
it.each([true, false])("fails clearly without API keys even when CRD install=%s", (install) => {
  const result = render([`crds.install=${install}`], "");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("apiKeys.existingSecret");
});
it("rejects whitespace-only API-key references", () => {
  const result = render([], "   ");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("apiKeys.existingSecret");
});

it.each([1, 2, 3])("gates the gateway PDB correctly at replicas=%s", (replicas) => {
  const result = render([`gateway.replicas=${replicas}`]);
  expect(result.status).toBe(0);
  const pdbs = result.documents.filter((d) => d.kind === "PodDisruptionBudget");
  expect(pdbs).toHaveLength(replicas > 1 ? 1 : 0);
  if (pdbs[0]) {
    expect(pdbs[0].spec.minAvailable).toBe(1);
    expect(pdbs[0].spec.selector.matchLabels["app.kubernetes.io/component"]).toBe("gateway");
  }
});

it("renders actual hardened postgres pod templates with stable disjoint selectors", () => {
  const result = render([
    "priorityClassName=krun-test-priority",
    "terminationGracePeriodSeconds=47",
  ]);
  expect(result.status).toBe(0);
  const workloads = result.documents.filter((d) => d.kind === "Deployment");
  expect(workloads).toHaveLength(2);
  for (const workload of workloads) {
    const role = workload.metadata.labels["app.kubernetes.io/component"];
    const pod = workload.spec.template;
    expect(pod.metadata.labels["app.kubernetes.io/name"]).toBe("krun");
    expect(pod.metadata.labels["app.kubernetes.io/instance"]).toBe("krun-test-foundation");
    expect(pod.metadata.labels["krun.io/gateway"]).toBe(role === "gateway" ? "true" : undefined);
    expect(workload.spec.selector.matchLabels).toEqual({
      "app.kubernetes.io/name": "krun",
      "app.kubernetes.io/instance": "krun-test-foundation",
      "app.kubernetes.io/component": role,
    });
    expect(pod.spec.serviceAccountName).toBe(`krun-${role}`);
    expect(pod.spec.priorityClassName).toBe("krun-test-priority");
    expect(pod.spec.terminationGracePeriodSeconds).toBe(47);
    expect(pod.spec.automountServiceAccountToken).toBe(true);
    expect(pod.spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const c = pod.spec.containers[0];
    expect(c.args).toEqual([role]);
    expect(c.image).toBe("ghcr.io/xenarro/krun:0.0.0");
    expect(c.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      seccompProfile: { type: "RuntimeDefault" },
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(c.resources).toEqual({
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { memory: "512Mi" },
    });
    expect(c.volumeMounts).toContainEqual({ name: "tmp", mountPath: "/tmp" });
    expect(pod.spec.volumes).toContainEqual({ name: "tmp", emptyDir: {} });
    expect(c.startupProbe).toBeUndefined();
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
    const env = Object.fromEntries(
      c.env.map((e: { name: string; value?: string; valueFrom?: unknown }) => [e.name, e]),
    );
    expect(env.KRUN_MAX_RUNNING.value).toBe("100");
    expect(env.KRUN_S3_PRESIGN_TTL.value).toBe("");
    expect(env.KRUN_GATEWAY_INTERNAL_URL.value).toBe(
      "http://krun-gateway-internal.krun-test-platform.svc:8081",
    );
    expect(env.KRUN_DB_DSN.value).toBeUndefined();
    expect(env.KRUN_DB_DSN.valueFrom.secretKeyRef).toEqual({ name: "krun-test-db", key: "dsn" });
    if (role === "scheduler") {
      expect(workload.spec.strategy).toEqual({
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      });
      expect(env.KRUN_POD_NAME.valueFrom.fieldRef.fieldPath).toBe("metadata.name");
    } else {
      expect(pod.spec.topologySpreadConstraints).toEqual([
        {
          maxSkew: 1,
          topologyKey: "kubernetes.io/hostname",
          whenUnsatisfiable: "ScheduleAnyway",
          labelSelector: workload.spec.selector,
        },
      ]);
      expect(c.volumeMounts).toContainEqual({
        name: "api-keys",
        mountPath: "/etc/krun",
        readOnly: true,
      });
      expect(pod.spec.volumes).toContainEqual({
        name: "api-keys",
        secret: {
          secretName: "krun-test-api-keys",
          items: [{ key: "keys.yaml", path: "keys.yaml" }],
        },
      });
    }
  }
});
it("honors explicit image tag and resource overrides without selector drift", () => {
  const result = render([
    "image.tag=krun-test-tag",
    "gateway.resources.requests.cpu=250m",
    "scheduler.replicas=2",
  ]);
  expect(result.status).toBe(0);
  const deployments = result.documents.filter((d) => d.kind === "Deployment");
  expect(deployments).toHaveLength(2);
  for (const d of deployments) {
    expect(d.spec.template.spec.containers[0].image).toBe("ghcr.io/xenarro/krun:krun-test-tag");
    expect(d.spec.selector.matchLabels).not.toHaveProperty("app.kubernetes.io/version");
  }
  expect(
    deployments.find((d) => d.metadata.labels["app.kubernetes.io/component"] === "gateway").spec
      .template.spec.containers[0].resources.requests.cpu,
  ).toBe("250m");
});

it("maps every config default to one quoted environment value on both processes", () => {
  const values = parse(readFileSync(`${chart}/values.yaml`, "utf8"));
  const result = render();
  expect(result.status).toBe(0);
  const deployments = result.documents.filter((d) => d.kind === "Deployment");
  expect(deployments).toHaveLength(2);
  for (const deployment of deployments) {
    const env = deployment.spec.template.spec.containers[0].env;
    expect(new Set(env.map((item: { name: string }) => item.name)).size).toBe(env.length);
    for (const [key, value] of Object.entries(values.config)) {
      const name = `KRUN_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
      expect(env.filter((item: { name: string }) => item.name === name)).toEqual([
        { name, value: String(value) },
      ]);
    }
  }
});

it("omits an empty priority class and preserves the default grace period", () => {
  const result = render();
  expect(result.status).toBe(0);
  for (const deployment of result.documents.filter((d) => d.kind === "Deployment")) {
    expect(deployment.spec.template.spec.priorityClassName).toBeUndefined();
    expect(deployment.spec.template.spec.terminationGracePeriodSeconds).toBe(30);
    expect(deployment.spec.template.spec.containers[0].resources.limits.cpu).toBeUndefined();
  }
});

it.each(["apiKeys.existingSecret", "db.postgres.existingSecret"])(
  "names %s without printing a referenced value",
  (key) => {
    const result = render([`${key}=`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(key);
  },
);

it("rejects unknown database modes instead of silently omitting workloads", () => {
  const result = render(["db.mode=invalid"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("db.mode");
});

it.each(["true", "null"])("keeps the valid release/namespace label %s a string", (name) => {
  const output = spawnSync(
    "helm",
    [
      "template",
      name,
      chart,
      "--namespace",
      name,
      "--set",
      "apiKeys.existingSecret=krun-test-keys",
      "--set",
      "db.postgres.existingSecret=krun-test-db",
    ],
    { encoding: "utf8" },
  );
  expect(output.status).toBe(0);
  const docs = parseAllDocuments(output.stdout)
    .filter((d) => d.contents !== null)
    .map((d) => d.toJSON());
  expect(docs.length).toBeGreaterThan(3);
  for (const doc of docs)
    if (doc.kind !== "CustomResourceDefinition") expect(doc.metadata.namespace).toBe(name);
  expect(docs.some((d) => d.kind === "Service" && d.metadata.name === name)).toBe(true);
});

for (const mode of ["postgres", "embedded"]) {
  it.each([
    ["krun-test-names", "krun-test-names"],
    ["true", "true"],
    ["krun.test", "krun-krun-test"],
    ["gateway.internal", "krun-krun-gateway-internal"],
    ["krun-gateway-internal", "krun-krun-gateway-internal"],
    ["123", "krun-123"],
    ["1".repeat(53), `krun-${"1".repeat(53)}`],
  ])(
    `keeps distinct DNS-label-safe Service identities in ${mode} for %s`,
    (release, publicName) => {
      const output = spawnSync(
        "helm",
        [
          "template",
          release,
          chart,
          "--namespace",
          "krun-test-names",
          "--set",
          "apiKeys.existingSecret=krun-test-keys",
          "--set",
          "db.postgres.existingSecret=krun-test-db",
          "--set",
          `db.mode=${mode}`,
          "--set",
          "gateway.replicas=1",
        ],
        { encoding: "utf8" },
      );
      expect(output.status).toBe(0);
      const docs = parseAllDocuments(output.stdout)
        .filter((d) => d.contents !== null)
        .map((d) => d.toJSON());
      const identities = docs.map(
        (d) =>
          `${d.apiVersion.includes("/") ? d.apiVersion.split("/")[0] : ""}/${d.kind}/${d.metadata.namespace ?? ""}/${d.metadata.name}`,
      );
      expect(new Set(identities).size).toBe(identities.length);
      const services = docs.filter((d) => d.kind === "Service");
      expect(services).toHaveLength(2);
      for (const service of services) {
        expect(service.metadata.name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
        expect(service.metadata.name.length).toBeLessThanOrEqual(63);
        expect(service.spec.selector["app.kubernetes.io/instance"]).toBe(release);
      }
      expect(services.find((d) => d.spec.ports[0].port === 8080).metadata.name).toBe(publicName);
      expect(services.find((d) => d.spec.ports[0].port === 8081).metadata.name).toBe(
        "krun-gateway-internal",
      );
    },
  );
}
