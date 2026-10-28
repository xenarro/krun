import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const values = parse(readFileSync(`${chart}/values.yaml`, "utf8"));
const render = (sets: string[] = [], mode = "postgres") => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-namespace",
      chart,
      "--namespace",
      "krun-test-platform",
      "--set",
      "apiKeys.existingSecret=krun-test-keys",
      "--set",
      "db.postgres.existingSecret=krun-test-db",
      "--set",
      `db.mode=${mode}`,
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
const accepted = (sets: string[] = [], mode = "postgres") => {
  const result = render(sets, mode);
  expect(result.status, result.stderr).toBe(0);
  return result.documents;
};
for (const mode of ["postgres", "embedded"]) {
  it(`renders the jobs namespace PSA version and keep annotation in ${mode}`, () => {
    const docs = accepted([], mode);
    const ns = docs.find((d) => d.kind === "Namespace");
    expect(ns).toBeDefined();
    expect(ns.metadata.name).toBe("krun-jobs");
    expect(ns.metadata.namespace).toBeUndefined();
    expect(ns.metadata.annotations).toEqual({ "helm.sh/resource-policy": "keep" });
    for (const key of ["enforce", "warn", "audit"]) {
      expect(ns.metadata.labels[`pod-security.kubernetes.io/${key}`]).toBe("restricted");
      expect(ns.metadata.labels[`pod-security.kubernetes.io/${key}-version`]).toBe("v1.33");
    }
    expect(docs.filter((d) => d.kind === "Namespace")).toHaveLength(1);
  });
  it(`renders exact LimitRange and ResourceQuota including ephemeral storage in ${mode}`, () => {
    const docs = accepted([], mode);
    const limits = docs.find((d) => d.kind === "LimitRange");
    const quota = docs.find((d) => d.kind === "ResourceQuota");
    expect(limits).toBeDefined();
    expect(quota).toBeDefined();
    expect(limits.metadata.namespace).toBe("krun-jobs");
    expect(quota.metadata.namespace).toBe("krun-jobs");
    expect(limits.spec.limits).toEqual([{ type: "Container", ...values.jobsNamespace.limitRange }]);
    expect(quota.spec.hard).toEqual(values.jobsNamespace.quota);
    for (const key of ["defaultRequest", "default", "max"])
      expect(limits.spec.limits[0][key]).toHaveProperty("ephemeral-storage");
    expect(quota.spec.hard).toHaveProperty("requests.ephemeral-storage", "100Gi");
    for (const resource of [limits, quota])
      expect(resource.metadata.annotations?.["helm.sh/resource-policy"]).toBeUndefined();
  });
  it(`keeps job SA and optional admission objects when namespace creation is disabled in ${mode}`, () => {
    const docs = accepted(["jobsNamespace.create=false", "config.maxRunning=300"], mode);
    for (const kind of ["Namespace", "LimitRange", "ResourceQuota", "NetworkPolicy"])
      expect(docs.filter((d) => d.kind === kind)).toEqual([]);
    const account = docs.find(
      (d) => d.kind === "ServiceAccount" && d.metadata.name === "krun-job-default",
    );
    expect(account).toBeDefined();
    expect(account.metadata.namespace).toBe("krun-jobs");
    expect(account.automountServiceAccountToken).toBe(false);
    expect(account.secrets).toBeUndefined();
    expect(docs.filter((d) => d.kind === "ValidatingAdmissionPolicy")).toHaveLength(1);
    expect(docs.filter((d) => d.kind === "ValidatingAdmissionPolicyBinding")).toHaveLength(1);
  });
  it(`validates quota only when chart-owned, with equality accepted in ${mode}`, () => {
    const bad = render(["config.maxRunning=201", "crds.install=false"], mode);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("config.maxRunning");
    expect(bad.stderr).toContain("jobsNamespace.quota.pods");
    expect(render(["config.maxRunning=200"], mode).status).toBe(0);
    expect(render(["config.maxRunning=301", "jobsNamespace.quota.pods=300"], mode).status).not.toBe(
      0,
    );
    expect(render(["config.maxRunning=300", "jobsNamespace.quota.pods=300"], mode).status).toBe(0);
  });
  it.each([
    ["1k", 1000],
    ["2e2", 200],
    ["2E+2", 200],
    ["2000e-1", 200],
    [".2k", 200],
    ["+0001.000k", 1000],
    ["200000m", 200],
    ["200000000u", 200],
    ["200000000000n", 200],
    ["1Ki", 1024],
    ["1.5Ki", 1536],
    ["1Mi", 1048576],
    ["9007199254740991", 9007199254740991],
    ["9007199254740991e0", 9007199254740991],
    ["8796093022207.9990234375Ki", 9007199254740991],
    ["199.9999999999", 200],
    ["200.0000000000", 200],
    ["0.1953125Ki", 200],
  ])(
    `compares count quantity %s semantically without rewriting it in ${mode}`,
    (quantity, capacity) => {
      const quota = `jobsNamespace.quota.pods=${quantity}`;
      const sets = [quota, `config.maxRunning=${capacity}`];
      const docs = accepted(sets, mode);
      expect(docs.find((d) => d.kind === "ResourceQuota").spec.hard.pods).toBe(quantity);
      const lower = render([quota, `config.maxRunning=${capacity - 1}`], mode);
      expect(lower.status, lower.stderr).toBe(0);
      const over = render([quota, `config.maxRunning=${BigInt(capacity) + 1n}`], mode);
      expect(over.status).not.toBe(0);
      expect(over.stderr).toContain("config.maxRunning exceeds jobsNamespace.quota.pods");
      expect(
        render([...sets, "jobsNamespace.create=false", "config.maxRunning=9999999999999999"], mode)
          .status,
      ).toBe(0);
    },
  );
  it(`accepts zero concurrency at a zero or positive quota in ${mode}`, () => {
    for (const quantity of ["0", "-0", "0k", "0e100", "0Ki", "1n", "200"])
      expect(
        render([`jobsNamespace.quota.pods=${quantity}`, "config.maxRunning=0"], mode).status,
      ).toBe(0);
  });
  it(`accepts large SI and binary quantities without arithmetic overflow in ${mode}`, () => {
    for (const quantity of ["1G", "1T", "1P", "1E", "1Gi", "1Ti", "1Pi", "1Ei", "1e100"])
      expect(
        render([`jobsNamespace.quota.pods=${quantity}`, "config.maxRunning=300"], mode).status,
      ).toBe(0);
    for (const quantity of ["0", "-1k", "1m", "1e-100"])
      expect(render([`jobsNamespace.quota.pods=${quantity}`], mode).status).not.toBe(0);
  });
  it(`checks webhooks and object storage even with create/CRD disabled in ${mode}`, () => {
    const common = ["crds.install=false", "jobsNamespace.create=false"];
    for (const secret of ["", "   "]) {
      const bad = render(
        [...common, "webhooks.allowedHosts[0]=hooks.example", `webhooks.existingSecret=${secret}`],
        mode,
      );
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("webhooks.existingSecret");
    }
    const storage = [
      "objectStorage.enabled=true",
      "objectStorage.endpoint=https://store.example",
      "objectStorage.bucket=krun-test",
      "objectStorage.existingSecret=krun-test-store",
    ];
    for (const key of ["endpoint", "bucket", "existingSecret"])
      for (const value of ["", "   "]) {
        const bad = render([...common, ...storage, `objectStorage.${key}=${value}`], mode);
        expect(bad.status).not.toBe(0);
        expect(bad.stderr).toContain(`objectStorage.${key}`);
      }
    expect(
      render(
        [
          ...common,
          ...storage,
          "webhooks.allowedHosts[0]=hooks.example",
          "webhooks.existingSecret=krun-test-hook",
        ],
        mode,
      ).status,
    ).toBe(0);
  });
}
it("omits only Namespace keep when keep=false, without changing CRD keep", () => {
  const docs = accepted(["jobsNamespace.keep=false"]);
  expect(
    docs.find((d) => d.kind === "Namespace").metadata.annotations?.["helm.sh/resource-policy"],
  ).toBeUndefined();
  expect(
    docs.find((d) => d.kind === "CustomResourceDefinition").metadata.annotations[
      "helm.sh/resource-policy"
    ],
  ).toBe("keep");
});
it("honors namespace, PSA version and all quantity-map overrides without new value keys", () => {
  const docs = accepted([
    "jobsNamespace.name=krun-test-custom",
    "jobsNamespace.podSecurityVersion=v1.36",
    "jobsNamespace.limitRange.max.ephemeral-storage=15Gi",
    "jobsNamespace.quota.requests\\.ephemeral-storage=80Gi",
    "jobsNamespace.limitRange.defaultRequest.cpu=150m",
  ]);
  expect(docs.find((d) => d.kind === "Namespace").metadata.name).toBe("krun-test-custom");
  expect(
    docs.find((d) => d.kind === "Namespace").metadata.labels[
      "pod-security.kubernetes.io/enforce-version"
    ],
  ).toBe("v1.36");
  expect(docs.find((d) => d.kind === "LimitRange").spec.limits[0].max["ephemeral-storage"]).toBe(
    "15Gi",
  );
  expect(docs.find((d) => d.kind === "LimitRange").spec.limits[0].defaultRequest.cpu).toBe("150m");
  expect(docs.find((d) => d.kind === "ResourceQuota").spec.hard["requests.ephemeral-storage"]).toBe(
    "80Gi",
  );
  expect(
    docs.find((d) => d.kind === "ValidatingAdmissionPolicyBinding").spec.matchResources
      .namespaceSelector.matchLabels["kubernetes.io/metadata.name"],
  ).toBe("krun-test-custom");
});
it.each([true, false])("admissionPolicy=%s is independent of namespace creation", (enabled) => {
  for (const create of [true, false]) {
    const docs = accepted([
      `jobsNamespace.create=${create}`,
      `jobsNamespace.admissionPolicy=${enabled}`,
    ]);
    for (const kind of ["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"])
      expect(docs.filter((d) => d.kind === kind)).toHaveLength(enabled ? 1 : 0);
  }
});
it("renders fixed cluster-scoped digest policy for Jobs and Pods, create and update, regular and init images", () => {
  const docs = accepted();
  const policy = docs.find((d) => d.kind === "ValidatingAdmissionPolicy");
  const binding = docs.find((d) => d.kind === "ValidatingAdmissionPolicyBinding");
  expect(policy).toBeDefined();
  expect(binding).toBeDefined();
  for (const r of [policy, binding]) {
    expect(r.apiVersion).toBe("admissionregistration.k8s.io/v1");
    expect(r.metadata.name).toBe("krun-jobs-digest");
    expect(r.metadata.namespace).toBeUndefined();
  }
  expect(policy.spec.failurePolicy).toBe("Fail");
  expect(policy.spec.matchConstraints.resourceRules).toEqual([
    {
      apiGroups: ["batch"],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["jobs"],
    },
    { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["pods"] },
  ]);
  expect(policy.spec.variables).toEqual([
    {
      name: "spec",
      expression: "request.resource.resource == 'jobs' ? object.spec.template.spec : object.spec",
    },
  ]);
  expect(policy.spec.validations[0].expression).toContain("variables.spec.containers.all");
  expect(policy.spec.validations[0].expression).toContain("variables.spec.initContainers.all");
  expect(policy.spec.validations[0].expression).toContain("has(variables.spec.initContainers)");
  expect(policy.spec.validations[0].expression).toContain("@sha256:");
  expect(binding.spec.policyName).toBe("krun-jobs-digest");
  expect(binding.spec.validationActions).toEqual(["Deny"]);
  expect(binding.spec.matchResources.namespaceSelector.matchLabels).toEqual({
    "kubernetes.io/metadata.name": "krun-jobs",
  });
});
it("creates no credentials, Function, cluster-wide RBAC or network policy ahead of its task", () => {
  for (const d of accepted())
    expect([
      "Secret",
      "ConfigMap",
      "Function",
      "ClusterRole",
      "ClusterRoleBinding",
      "NetworkPolicy",
    ]).not.toContain(d.kind);
});
