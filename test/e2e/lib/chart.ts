import { z } from "zod";

export const databaseMode = z.enum(["embedded", "postgres"]);
export type DatabaseMode = z.infer<typeof databaseMode>;
export const release = "e2e";
export const chartLayout = (mode: DatabaseMode) => ({
  namespace: `krun-test-${mode}`,
  jobsNamespace: `krun-test-${mode}-jobs`,
  monitoringNamespace: `krun-test-${mode}-monitoring`,
  outsiderNamespace: `krun-test-${mode}-outsider`,
  gateway: mode === "embedded" ? `statefulset/${release}` : `deployment/${release}-gateway`,
  scheduler: mode === "embedded" ? `statefulset/${release}` : `deployment/${release}-scheduler`,
});

// No secret contents enter values, Helm argv, rendered chart resources or logs.
export const chartValues = (mode: DatabaseMode, image: string) => {
  const parsed = z
    .string()
    .regex(/^localhost:5001\/krun@sha256:[a-f0-9]{64}$/)
    .parse(image);
  const layout = chartLayout(mode);
  return {
    image: { repository: "localhost:5001/krun", tag: `e2e@${parsed.split("@")[1]}` },
    db: { mode, postgres: { existingSecret: "krun-test-postgres" } },
    apiKeys: { existingSecret: "krun-e2e-keys" },
    gateway: { replicas: mode === "embedded" ? 1 : 2 },
    scheduler: { replicas: mode === "embedded" ? 1 : 2 },
    crds: { install: true, keep: false },
    jobsNamespace: { name: layout.jobsNamespace, keep: false },
    networkPolicy: { metricsFrom: { matchLabels: { "krun.io/e2e-monitoring": "true" } } },
    objectStorage: {
      enabled: true,
      endpoint: "http://krun-test-minio.krun-test-minio.svc.cluster.local:9000",
      bucket: "krun-test-results",
      region: "us-east-1",
      existingSecret: "krun-test-minio-credentials",
      egress: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "krun-test-minio" } },
          podSelector: { matchLabels: { "app.kubernetes.io/name": "krun-test-minio" } },
        },
      ],
    },
    webhooks: {
      allowedHosts: [`krun-test-webhook-*.${layout.namespace}.svc.cluster.local`],
      allowedCIDRs: ["10.244.0.0/16", "10.96.0.0/16"],
      existingSecret: "krun-e2e-webhook-keys",
    },
  };
};
