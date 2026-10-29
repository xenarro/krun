import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const platform = "krun-test-rbac-platform";
const jobs = "krun-test-rbac-jobs";
const render = (mode: string, create: boolean, namespace = platform, jobsNamespace = jobs) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-rbac",
      chart,
      "--namespace",
      namespace,
      "--set",
      "apiKeys.existingSecret=krun-test-keys",
      "--set",
      "db.postgres.existingSecret=krun-test-db",
      "--set",
      `db.mode=${mode}`,
      "--set",
      "gateway.replicas=1",
      "--set",
      `jobsNamespace.create=${create}`,
      "--set-string",
      `jobsNamespace.name=${jobsNamespace}`,
      "--set",
      `config.maxRunning=${create ? 100 : 300}`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout)
    .filter((d) => d.contents !== null)
    .map((d) => {
      expect(d.errors).toEqual([]);
      return d.toJSON();
    });
};
const rule = (apiGroup: string, resource: string, verbs: string[], resourceNames?: string[]) => ({
  apiGroups: [apiGroup],
  resources: [resource],
  verbs,
  ...(resourceNames ? { resourceNames } : {}),
});
const binding = (name: string, namespace: string, accountName = name) => ({
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
  subjects: [{ kind: "ServiceAccount", name: accountName, namespace }],
});
for (const mode of ["postgres", "embedded"]) {
  for (const create of [true, false]) {
    const label = `${mode}, create=${create}`;
    it(`renders exact scheduler jobs grants and cross-namespace subject: ${label}`, () => {
      const docs = render(mode, create);
      const roles = docs.filter((d) => d.kind === "Role" && d.metadata.namespace === jobs);
      expect(roles.map((d) => d.metadata.name).sort()).toEqual([
        "krun-job-viewer",
        "krun-scheduler-jobs",
      ]);
      expect(roles.find((d) => d.metadata.name === "krun-scheduler-jobs").rules).toEqual([
        rule("batch", "jobs", ["create", "get", "list", "watch", "delete"]),
        rule("", "pods", ["get", "list", "watch"]),
        rule("", "pods/log", ["get"]),
        rule("", "secrets", ["create", "get", "list", "delete"]),
      ]);
      const bindings = docs.filter(
        (d) => d.kind === "RoleBinding" && d.metadata.namespace === jobs,
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0].metadata.name).toBe("krun-scheduler-jobs");
      expect(bindings[0]).toMatchObject(binding("krun-scheduler-jobs", platform, "krun-scheduler"));
    });
    it(`restricts Lease get/update by name and leaves only create unnamed: ${label}`, () => {
      const docs = render(mode, create);
      const scheduler = docs.find(
        (d) =>
          d.kind === "Role" &&
          d.metadata.namespace === platform &&
          d.metadata.name === "krun-scheduler",
      );
      expect(scheduler).toBeDefined();
      expect(scheduler.rules).toEqual([
        rule("coordination.k8s.io", "leases", ["get", "update"], ["krun-scheduler"]),
        rule("coordination.k8s.io", "leases", ["create"]),
        rule("krun.io", "functions", ["get", "list", "watch"]),
        rule("krun.io", "functions/status", ["patch"]),
      ]);
      const bound = docs.find(
        (d) =>
          d.kind === "RoleBinding" &&
          d.metadata.namespace === platform &&
          d.metadata.name === "krun-scheduler",
      );
      expect(bound).toMatchObject(binding("krun-scheduler", platform));
    });
    it(`renders gateway read-only access only with the postgres gateway account: ${label}`, () => {
      const docs = render(mode, create);
      for (const kind of ["Role", "RoleBinding", "ServiceAccount"]) {
        const found = docs.filter((d) => d.kind === kind && d.metadata.name === "krun-gateway");
        expect(found).toHaveLength(mode === "postgres" ? 1 : 0);
        if (mode === "postgres") expect(found[0].metadata.namespace).toBe(platform);
      }
      if (mode === "postgres") {
        expect(
          docs.find((d) => d.kind === "Role" && d.metadata.name === "krun-gateway").rules,
        ).toEqual([rule("krun.io", "functions", ["get", "list", "watch"])]);
        expect(
          docs.find((d) => d.kind === "RoleBinding" && d.metadata.name === "krun-gateway"),
        ).toMatchObject(binding("krun-gateway", platform));
      }
    });
    it(`renders unbound author/viewer roles and no extra or cluster-wide grants: ${label}`, () => {
      const docs = render(mode, create);
      const viewer = docs.find((d) => d.kind === "Role" && d.metadata.name === "krun-job-viewer");
      expect(viewer).toBeDefined();
      expect(viewer.metadata.namespace).toBe(jobs);
      expect(viewer.rules).toEqual([
        rule("", "pods", ["get", "list"]),
        rule("", "pods/log", ["get"]),
        rule("batch", "jobs", ["get", "list"]),
      ]);
      const author = docs.find(
        (d) => d.kind === "Role" && d.metadata.name === "krun-function-author",
      );
      expect(author).toBeDefined();
      expect(author.metadata.namespace).toBe(platform);
      expect(author.rules).toEqual([
        rule("krun.io", "functions", [
          "get",
          "list",
          "watch",
          "create",
          "update",
          "patch",
          "delete",
        ]),
      ]);
      const roles = docs.filter((d) => d.kind === "Role");
      const bindings = docs.filter((d) => d.kind === "RoleBinding");
      expect(roles).toHaveLength(mode === "postgres" ? 5 : 4);
      expect(bindings).toHaveLength(mode === "postgres" ? 3 : 2);
      expect(
        new Set(
          [...roles, ...bindings].map(
            (d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`,
          ),
        ).size,
      ).toBe(roles.length + bindings.length);
      for (const d of [...roles, ...bindings]) {
        expect(d.apiVersion).toBe("rbac.authorization.k8s.io/v1");
        expect(d.metadata.labels["app.kubernetes.io/instance"]).toBe("krun-test-rbac");
        expect(d.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
        expect(d.metadata.annotations?.["helm.sh/resource-policy"]).toBeUndefined();
      }
      for (const d of docs)
        expect([
          "ClusterRole",
          "ClusterRoleBinding",
          "Secret",
          "ConfigMap",
          "Function",
        ]).not.toContain(d.kind);
      for (const d of bindings) {
        expect(d.roleRef.name).not.toBe("krun-function-author");
        expect(d.roleRef.name).not.toBe("krun-job-viewer");
        for (const s of d.subjects)
          expect(["krun-job-default", "krun-migrate", "default"]).not.toContain(s.name);
      }
      if (!create) {
        for (const kind of ["Namespace", "LimitRange", "ResourceQuota"])
          expect(docs.filter((d) => d.kind === kind)).toEqual([]);
        expect(
          docs.filter((d) => d.kind === "NetworkPolicy" && d.metadata.namespace === jobs),
        ).toEqual([]);
        expect(
          docs.find((d) => d.kind === "ServiceAccount" && d.metadata.name === "krun-job-default")
            .automountServiceAccountToken,
        ).toBe(false);
      }
    });
  }
}
it.each(["postgres", "embedded"])(
  "keeps scheduler RBAC identities distinct when namespaces coincide in %s",
  (mode) => {
    const docs = render(mode, false, platform, platform);
    const grants = docs.filter((d) => ["Role", "RoleBinding"].includes(d.kind));
    expect(
      new Set(grants.map((d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`)).size,
    ).toBe(grants.length);
    const schedulerRoles = docs.filter(
      (d) => d.kind === "Role" && d.metadata.name.startsWith("krun-scheduler"),
    );
    expect(schedulerRoles.map((d) => d.metadata.name).sort()).toEqual([
      "krun-scheduler",
      "krun-scheduler-jobs",
    ]);
    const jobRole = schedulerRoles.find((d) => d.metadata.name === "krun-scheduler-jobs");
    expect(jobRole.rules).toEqual([
      rule("batch", "jobs", ["create", "get", "list", "watch", "delete"]),
      rule("", "pods", ["get", "list", "watch"]),
      rule("", "pods/log", ["get"]),
      rule("", "secrets", ["create", "get", "list", "delete"]),
    ]);
    const bound = grants.filter(
      (d) => d.kind === "RoleBinding" && d.subjects[0].name === "krun-scheduler",
    );
    expect(bound.map((d) => d.roleRef.name).sort()).toEqual([
      "krun-scheduler",
      "krun-scheduler-jobs",
    ]);
    expect(bound.every((d) => d.subjects[0].namespace === platform)).toBe(true);
  },
);
it.each(["true", "null"])(
  "quotes both namespace identities in RBAC including the keyword %s",
  (name) => {
    for (const mode of ["postgres", "embedded"]) {
      const docs = render(mode, false, name, `krun-test-${name}-jobs`);
      for (const d of docs.filter((d) => d.kind === "RoleBinding")) {
        expect(d.subjects[0].namespace).toBe(name);
        expect(d.metadata.namespace).toBe(
          d.metadata.namespace === name ? name : `krun-test-${name}-jobs`,
        );
      }
      const jobsDocs = render(mode, false, platform, name);
      expect(
        jobsDocs.find((d) => d.kind === "Role" && d.metadata.name === "krun-job-viewer").metadata
          .namespace,
      ).toBe(name);
    }
  },
);
