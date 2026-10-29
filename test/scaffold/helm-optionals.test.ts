import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const platform = "krun-test-optional-platform";
const render = (
  mode: string,
  values: Record<string, unknown> = {},
  release = "krun-test-optionals",
) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      release,
      chart,
      "--namespace",
      platform,
      "--set-json",
      JSON.stringify({
        apiKeys: { existingSecret: "krun-test-unused" },
        db: { mode, postgres: { existingSecret: "krun-test-unused" } },
        gateway: { replicas: 1 },
        ...values,
      }),
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
const processes = (docs: ReturnType<typeof render>) =>
  docs
    .filter((d) => ["Deployment", "StatefulSet"].includes(d.kind))
    .flatMap((d) => d.spec.template.spec.containers);
const env = (container: { env: { name: string; value?: string }[] }, prefix: string) =>
  container.env.filter((v) => v.name.startsWith(prefix));
const parentRefs = [
  { name: "krun-test-edge", namespace: "krun-test-ingress", sectionName: "https", port: 443 },
  { group: "gateway.networking.k8s.io", kind: "Gateway", name: "krun-test-local" },
];
const hostnames = ["api.example.test", "*.krun.example.test"];
const endpoint = "https://collector.example.test:4318/otel?source=krun";

for (const mode of ["postgres", "embedded"]) {
  it(`leaves optional route, telemetry and host-user override absent by default in ${mode}`, () => {
    const docs = render(mode);
    expect(docs.filter((d) => d.kind === "HTTPRoute")).toEqual([]);
    expect(processes(docs)).toHaveLength(2);
    for (const process of processes(docs)) {
      expect(env(process, "OTEL_")).toEqual([]);
      expect(env(process, "KRUN_JOB_HOST_USERS")).toEqual([]);
    }
  });

  it(`does not render a disabled route even with configured references in ${mode}`, () => {
    const docs = render(mode, {
      gatewayApi: { httpRoute: { enabled: false, parentRefs, hostnames } },
    });
    expect(docs.filter((d) => d.kind === "HTTPRoute")).toEqual([]);
  });

  for (const release of ["krun-test-optionals", "krun.test.route", "true", "k".repeat(53)]) {
    it(`routes only to the actual public Service for ${release} in ${mode}`, () => {
      const docs = render(
        mode,
        {
          gatewayApi: { httpRoute: { enabled: true, parentRefs, hostnames } },
        },
        release,
      );
      const routes = docs.filter((d) => d.kind === "HTTPRoute");
      expect(routes).toHaveLength(1);
      const route = routes[0];
      expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
      expect(route.metadata.name).toBe(release);
      expect(route.metadata.namespace).toBe(platform);
      expect(route.metadata.labels["app.kubernetes.io/instance"]).toBe(release);
      expect(route.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
      const service = docs.find(
        (d) => d.kind === "Service" && d.spec.ports?.some((p: { port: number }) => p.port === 8080),
      );
      expect(service).toBeDefined();
      expect(service.spec.selector["krun.io/gateway"]).toBe("true");
      expect(route.spec).toEqual({
        parentRefs,
        hostnames,
        rules: [{ backendRefs: [{ name: service.metadata.name, port: 8080 }] }],
      });
      expect(
        docs.some((d) => ["Gateway", "GatewayClass", "ReferenceGrant", "Ingress"].includes(d.kind)),
      ).toBe(false);
    });
  }

  it(`keeps default references empty and omits empty hostnames when enabled in ${mode}`, () => {
    const docs = render(mode, { gatewayApi: { httpRoute: { enabled: true } } });
    const route = docs.find((d) => d.kind === "HTTPRoute");
    expect(route).toBeDefined();
    expect(route.spec.parentRefs).toEqual([]);
    expect(route.spec.hostnames).toBeUndefined();
    expect(route.spec.rules).toEqual([
      { backendRefs: [{ name: "krun-test-optionals", port: 8080 }] },
    ]);
  });

  it(`does not enable OTEL merely by changing the sampling ratio in ${mode}`, () => {
    const docs = render(mode, { observability: { tracesSampleRatio: "0" } });
    for (const process of processes(docs)) expect(env(process, "OTEL_")).toEqual([]);
  });

  for (const ratio of [undefined, "0", "1", "0.25", 0, 1]) {
    it(`wires string-valued OTEL endpoint and ratio ${ratio} to both processes in ${mode}`, () => {
      const docs = render(mode, {
        observability: {
          otlpEndpoint: endpoint,
          ...(ratio === undefined ? {} : { tracesSampleRatio: ratio }),
        },
      });
      expect(processes(docs)).toHaveLength(2);
      for (const process of processes(docs)) {
        expect(env(process, "OTEL_")).toEqual([
          { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: endpoint },
          { name: "OTEL_SERVICE_NAME", value: `krun-${process.name}` },
          { name: "OTEL_TRACES_SAMPLER", value: "parentbased_traceidratio" },
          { name: "OTEL_TRACES_SAMPLER_ARG", value: String(ratio ?? "0.1") },
        ]);
        expect(env(process, "KRUN_OTEL_")).toEqual([]);
        expect(new Set(process.env.map((v: { name: string }) => v.name)).size).toBe(
          process.env.length,
        );
      }
      for (const doc of docs.filter((d) => ["Job", "StatefulSet"].includes(d.kind))) {
        for (const process of [
          ...(doc.spec.template.spec.initContainers ?? []),
          ...(doc.kind === "Job" ? doc.spec.template.spec.containers : []),
        ])
          expect(env(process, "OTEL_")).toEqual([]);
      }
    });
  }

  for (const create of [true, false]) {
    for (const enabled of [true, false]) {
      it(`sets only scheduler KRUN_JOB_HOST_USERS with userNamespaces=${enabled}, create=${create} in ${mode}`, () => {
        const docs = render(mode, { jobsNamespace: { create, userNamespaces: enabled } });
        for (const process of processes(docs)) {
          expect(env(process, "KRUN_JOB_HOST_USERS")).toEqual(
            enabled && process.name === "scheduler"
              ? [{ name: "KRUN_JOB_HOST_USERS", value: "false" }]
              : [],
          );
        }
        for (const doc of docs.filter((d) =>
          ["Deployment", "StatefulSet", "Job"].includes(d.kind),
        )) {
          expect(doc.spec.template.spec.hostUsers).toBeUndefined();
        }
      });
    }
  }

  for (const enabled of [true, false]) {
    for (const create of [true, false]) {
      it(`gates digest admission independently under enabled=${enabled}, create=${create} in ${mode}`, () => {
        const docs = render(mode, { jobsNamespace: { create, admissionPolicy: enabled } });
        const policies = docs.filter((d) => d.kind === "ValidatingAdmissionPolicy");
        const bindings = docs.filter((d) => d.kind === "ValidatingAdmissionPolicyBinding");
        expect(policies).toHaveLength(enabled ? 1 : 0);
        expect(bindings).toHaveLength(enabled ? 1 : 0);
        if (enabled) {
          expect(policies[0].spec.failurePolicy).toBe("Fail");
          expect(bindings[0].spec).toEqual({
            policyName: "krun-jobs-digest",
            validationActions: ["Deny"],
            matchResources: {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "krun-jobs" } },
            },
          });
        }
      });
    }
  }

  if (mode === "embedded") {
    it("does not inject OTEL or host-user options into restore, migration or native Litestream containers", () => {
      const docs = render(mode, {
        db: {
          mode,
          embedded: {
            litestream: {
              enabled: true,
              image: "litestream/litestream:0.3.13",
              existingSecret: "krun-test-unused",
            },
          },
        },
        jobsNamespace: { userNamespaces: true },
        observability: { otlpEndpoint: endpoint },
      });
      const init = docs.find((d) => d.kind === "StatefulSet").spec.template.spec.initContainers;
      expect(init.map((c: { name: string }) => c.name)).toEqual([
        "litestream-restore",
        "litestream",
        "migrate",
      ]);
      for (const process of init) {
        expect(env(process, "OTEL_")).toEqual([]);
        expect(env(process, "KRUN_JOB_HOST_USERS")).toEqual([]);
      }
    });
  }

  it(`combines optional features without widening network permissions or adding extra resources in ${mode}`, () => {
    const normal = render(mode);
    const enabled = render(mode, {
      gatewayApi: { httpRoute: { enabled: true, parentRefs, hostnames } },
      observability: { otlpEndpoint: endpoint, tracesSampleRatio: "0" },
      jobsNamespace: { userNamespaces: true },
    });
    expect(enabled.filter((d) => d.kind === "NetworkPolicy")).toEqual(
      normal.filter((d) => d.kind === "NetworkPolicy"),
    );
    expect(enabled.filter((d) => d.kind === "HTTPRoute")).toHaveLength(1);
    expect(enabled).toHaveLength(normal.length + 1);
  });
}
