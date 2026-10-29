import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { GatewayEnv, SchedulerEnv } from "../../packages/shared/src/config/index.js";
import { chartLayout, chartValues, type DatabaseMode } from "../e2e/lib/chart.js";
import { largeResult, privatePodManifest } from "../e2e/lib/object-store.js";

const read = (name: string) => readFileSync(new URL(`../e2e/${name}`, import.meta.url), "utf8");
const documents = (name: string) => parseAllDocuments(read(name)).map((doc) => doc.toJSON());
const rendered = (mode: DatabaseMode) => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "e2e",
      "deploy/helm/krun",
      "--namespace",
      chartLayout(mode).namespace,
      "--set-json",
      JSON.stringify(chartValues(mode, `localhost:5001/krun@sha256:${"a".repeat(64)}`)),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout)
    .map((doc) => doc.toJSON())
    .filter(Boolean);
};
const id = "0192f000-0000-7000-8000-000000000001";
const accessKeyId = randomBytes(16).toString("hex");
const signed = `http://krun-test-minio.krun-test-minio.svc.cluster.local:9000/krun-test-results/runs/${id}/result.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${accessKeyId}%2F20261028%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261028T000000Z&X-Amz-SignedHeaders=host&X-Amz-Expires=120&X-Amz-Signature=${"a".repeat(64)}`;
const pod = () => ({
  metadata: { labels: { "krun.io/run-id": id } },
  spec: {
    containers: [
      {
        name: "function",
        env: [
          { name: "KRUN_RUN_ID", value: id },
          { name: "KRUN_RESULT_UPLOAD_URL", value: signed },
          { name: "KRUN_TOKEN", valueFrom: { secretKeyRef: { name: `krun-${id}`, key: "token" } } },
        ],
      },
    ],
  },
});

it("keeps author source paths traversable under the non-root runtime image", () => {
  const dockerfile = read("functions/Dockerfile.large-result");
  const knip = JSON.parse(readFileSync(new URL("../../knip.json", import.meta.url), "utf8"));
  expect(knip.workspaces["."].entry).toContain("test/e2e/functions/large_result.ts");
  expect(dockerfile).toContain(
    "COPY --chmod=0555 lib/large-result.ts /fixture/lib/large-result.ts",
  );
  expect(dockerfile).toContain(
    "COPY --chmod=0555 functions/large_result.ts /fixture/functions/large_result.ts",
  );
});

it("produces exactly one MiB of UTF-8 JSON with the actual opaque input", () => {
  const input = { marker: "private-😀", nested: [false, null, "é"] };
  const body = largeResult(input);
  expect(Buffer.byteLength(body)).toBe(1024 * 1024);
  expect(JSON.parse(body).input).toEqual(input);
  expect(JSON.parse(body).padding).toMatch(/^x+$/);
  expect(largeResult(input)).toBe(body);
});

it("permits only the required per-Run PUT URL field, not an unrestricted Pod URL exception", () => {
  const observed: string[] = [];
  const content = privatePodManifest(JSON.stringify(pod()), (url) => observed.push(url));
  expect(observed).toEqual([signed]);
  expect(content).not.toContain("X-Amz-");
  expect(content).toContain('"secretKeyRef"');
  const extra = { ...pod(), metadata: { ...pod().metadata, annotations: { leaked: signed } } };
  expect(() => privatePodManifest(JSON.stringify(extra))).toThrow(
    "Invalid native upload URL witness",
  );
});

it.each(["foreign-host", "foreign-run", "duplicate", "wrong-container", "missing"])(
  "refuses %s native PUT URL evidence without exposing its value",
  (mutation) => {
    const value = pod();
    const container = value.spec.containers[0];
    if (!container) throw new Error("Missing test Function container");
    const env = container.env[1];
    if (!env) throw new Error("Missing test upload environment");
    if (mutation === "foreign-host")
      env.value = signed.replace("krun-test-minio.krun-test-minio", "foreign.krun-test-minio");
    if (mutation === "foreign-run") env.value = signed.replace(id, id.replace(/1$/, "2"));
    if (mutation === "duplicate") container.env.push({ ...env });
    if (mutation === "wrong-container") container.name = "sidecar";
    if (mutation === "missing") container.env.splice(1, 1);
    expect(() => privatePodManifest(JSON.stringify(value))).toThrow(
      "Invalid native upload URL witness",
    );
  },
);

it.each([
  "unknown-private",
  "duplicate-expiry",
  "secret-signature",
  "secret-access-key",
  "expired-range",
  "wrong-date",
  "wrong-region",
  "wrong-operation",
])("rejects %s before excluding or observing the capability", (mutation) => {
  const secret = randomBytes(32).toString("hex");
  const marker = randomBytes(24).toString("hex");
  const value = pod();
  const container = value.spec.containers[0];
  const entry = container?.env[1];
  if (!entry) throw new Error("Missing native upload fixture");
  const url = new URL(signed);
  if (mutation === "unknown-private") url.searchParams.set("unintended-private", secret);
  if (mutation === "duplicate-expiry") url.searchParams.append("X-Amz-Expires", marker);
  if (mutation === "secret-signature") url.searchParams.set("X-Amz-Signature", secret);
  if (mutation === "secret-access-key")
    url.searchParams.set("X-Amz-Credential", `${secret}/20261028/us-east-1/s3/aws4_request`);
  if (mutation === "expired-range") url.searchParams.set("X-Amz-Expires", "604801");
  if (mutation === "wrong-date") url.searchParams.set("X-Amz-Date", "20260230T000000Z");
  if (mutation === "wrong-region")
    url.searchParams.set("X-Amz-Credential", `${accessKeyId}/20261028/foreign/s3/aws4_request`);
  if (mutation === "wrong-operation") url.searchParams.set("x-id", "GetObject");
  entry.value = url.href;
  let observed = false;
  let message = "";
  try {
    privatePodManifest(
      JSON.stringify(value),
      () => {
        observed = true;
      },
      {
        accessKeyId,
        forbidden: new Set([accessKeyId, secret, marker]),
        capabilities: new Set(),
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : "unknown";
  }
  expect(message === "Invalid native upload URL witness").toBe(true);
  expect(observed).toBe(false);
});

it("accepts and rechecks a validated capability without exempting private signature material", () => {
  const forbidden = new Set([accessKeyId, randomBytes(32).toString("hex")]);
  const capabilities = new Set<string>();
  const observe = (url: string) => {
    const signature = new URL(url).searchParams.get("X-Amz-Signature");
    if (!signature) throw new Error("Missing test signature");
    capabilities.add(url);
    capabilities.add(signature);
    forbidden.add(url);
    forbidden.add(signature);
  };
  for (let pass = 0; pass < 2; pass++) {
    const content = privatePodManifest(JSON.stringify(pod()), observe, {
      accessKeyId,
      forbidden,
      capabilities,
    });
    expect(content.includes("X-Amz-")).toBe(false);
  }
});

it("rejects account credentials and account Secret references in the Function Pod", () => {
  for (const env of [
    { name: "KRUN_S3_ACCESS_KEY", value: "fixture-access" },
    {
      name: "unrelated",
      valueFrom: { secretKeyRef: { name: "krun-test-minio-credentials", key: "secretKey" } },
    },
  ]) {
    const value = pod();
    const container = value.spec.containers[0];
    if (!container) throw new Error("Missing test Function container");
    container.env.push(env);
    expect(() => privatePodManifest(JSON.stringify(value))).toThrow(
      "Invalid native upload URL witness",
    );
  }
});

it.each(["embedded", "postgres"] as const)(
  "keeps chart %s jobs default deny and only namespace+Pod+TCP9000 MinIO egress",
  (mode) => {
    const docs = rendered(mode);
    const deny = docs.find((doc) => doc.metadata.name === "krun-jobs-deny-all");
    expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
    const allow = docs.find((doc) => doc.metadata.name === "krun-jobs-allow-object-storage");
    expect(allow.kind).toBe("NetworkPolicy");
    expect(allow.metadata.namespace).toBe(chartLayout(mode).jobsNamespace);
    expect(allow.spec).toEqual({
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "krun-test-minio" },
              },
              podSelector: { matchLabels: { "app.kubernetes.io/name": "krun-test-minio" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 9000 }],
        },
      ],
    });
  },
);

it("deploys the genuine checksum-pinned fixture as a restricted non-root server, never production storage", () => {
  const docs = documents("minio.yaml");
  expect(docs.find((doc) => doc.kind === "Namespace").metadata.name).toBe("krun-test-minio");
  const spec = docs.find((doc) => doc.kind === "Deployment").spec.template.spec;
  expect(spec.automountServiceAccountToken).toBe(false);
  expect(spec.securityContext.runAsUser).toBe(65532);
  expect(spec.containers[0].image).toBe("__KRUN_E2E_MINIO_IMAGE__");
  expect(spec.containers[0].args).toContain("--quiet");
  expect(spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
  for (const name of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
    const env = spec.containers[0].env.find((entry: { name: string }) => entry.name === name);
    expect(env.value).toBeUndefined();
    expect(env.valueFrom.secretKeyRef.name).toBe("krun-test-minio-credentials");
  }
  expect(docs.find((doc) => doc.kind === "Service").spec.type).toBeUndefined();
});

it.each(["embedded", "postgres"] as const)(
  "configures both %s chart process graphs with explicit generated S3 Secret refs",
  (mode) => {
    const containers = rendered(mode)
      .filter((doc) => ["Deployment", "StatefulSet"].includes(doc.kind))
      .flatMap((doc) => doc.spec.template.spec.containers);
    expect(containers).toHaveLength(2);
    for (const container of containers) {
      const values = Object.fromEntries(
        container.env.map((entry: { name: string; value?: string }) => [
          entry.name,
          entry.value ?? "krun-test-placeholder",
        ]),
      );
      const schema = container.name === "gateway" ? GatewayEnv : SchedulerEnv;
      const parsed = schema.safeParse(values);
      expect(parsed.success).toBe(true);
      if (!parsed.success)
        throw new Error("Native process fixture violates canonical configuration");
      expect(parsed.data.KRUN_S3_ACCESS_KEY).toBe("krun-test-placeholder");
      expect(parsed.data.KRUN_S3_SECRET_KEY).toBe("krun-test-placeholder");
      const env = Object.fromEntries(
        container.env.map((entry: { name: string }) => [entry.name, entry]),
      );
      expect(env.KRUN_S3_ENDPOINT.value).toBe(
        "http://krun-test-minio.krun-test-minio.svc.cluster.local:9000",
      );
      expect(env.KRUN_S3_BUCKET.value).toBe("krun-test-results");
      expect(env.KRUN_S3_REGION.value).toBe("us-east-1");
      for (const name of ["KRUN_S3_ACCESS_KEY", "KRUN_S3_SECRET_KEY"]) {
        expect(env[name].value).toBeUndefined();
        expect(env[name].valueFrom.secretKeyRef.name).toBe("krun-test-minio-credentials");
      }
    }
  },
);

it("does not confuse the fresh postgres jobs namespace with a platform Secret reference", () => {
  const original = pod();
  const value = {
    ...original,
    metadata: { ...original.metadata, namespace: "krun-test-postgres-jobs" },
  };
  expect(() => privatePodManifest(JSON.stringify(value))).not.toThrow();
});

for (const secretName of ["krun-e2e-keys", "krun-e2e-webhook-keys", "krun-test-postgres"]) {
  for (const location of ["function-env", "init-env", "envFrom", "volume", "projected-volume"]) {
    it(`rejects platform Secret reference ${secretName} in ${location} without rejecting the per-Run Secret`, () => {
      const original = pod();
      const reference = {
        name: "UNRELATED",
        valueFrom: { secretKeyRef: { name: secretName, key: "credential" } },
      };
      const candidate = {
        ...original,
        spec: {
          ...original.spec,
          containers: original.spec.containers.map((container) => ({
            ...container,
            env: [...container.env, ...(location === "function-env" ? [reference] : [])],
            ...(location === "envFrom" ? { envFrom: [{ secretRef: { name: secretName } }] } : {}),
          })),
          ...(location === "init-env"
            ? { initContainers: [{ name: "init", env: [reference] }] }
            : {}),
          ...(location === "volume"
            ? { volumes: [{ name: "platform", secret: { secretName } }] }
            : {}),
          ...(location === "projected-volume"
            ? {
                volumes: [
                  { name: "platform", projected: { sources: [{ secret: { name: secretName } }] } },
                ],
              }
            : {}),
        },
      };
      expect(() => privatePodManifest(JSON.stringify(candidate))).toThrow(
        "Invalid native upload URL witness",
      );
      expect(() => privatePodManifest(JSON.stringify(original))).not.toThrow();
    });
  }
}
