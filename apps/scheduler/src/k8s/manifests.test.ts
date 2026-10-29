import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSchedulerConfig } from "@krun/shared/dist/config/index.js";
import { functionResourceSchema } from "@krun/shared/dist/functions/schema.js";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { Effect, Result } from "effect";
import { expect, it } from "vitest";
import { privatePodManifest } from "../../../../test/e2e/lib/object-store.js";
import { buildJob, buildSecret, ManifestInvalid } from "./manifests.js";

const run = {
  id: "0192f000-0000-7000-8000-000000000041",
  function_name: "echo",
  created_by: "Owner.Test_1",
};
const resource = (spec = {}) =>
  functionResourceSchema.parse({
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: { name: "echo" },
    spec: {
      image: `registry.example.invalid/echo@sha256:${"a".repeat(64)}`,
      inputSchema: {},
      ...spec,
    },
  });
const config = Effect.runSync(
  parseSchedulerConfig({
    KRUN_DB_MODE: "embedded",
    KRUN_NAMESPACE: "krun-test",
    KRUN_JOBS_NAMESPACE: "krun-test-builders",
    KRUN_TTL_AFTER_FINISHED: "600",
  }),
);
const rich = resource({
  serviceAccountName: "krun-job-custom",
  runAsUser: 1234,
  runAsGroup: 2345,
  activeDeadlineSeconds: 123,
  heartbeatTimeout: "1m",
  secretRefs: ["function-config", "database-config"],
  env: [{ name: "APP_MODE", value: "example" }],
  imagePullSecrets: [{ name: "registry" }],
  nodeSelector: { "kubernetes.io/os": "linux", pool: "functions" },
  resources: {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "1", memory: "128Mi", "ephemeral-storage": "1Gi" },
  },
});
const upload = "https://example.invalid/runs/example/result.json";
const golden = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const wire = (value: unknown, type: string) =>
  JSON.parse(JSON.stringify(ObjectSerializer.serialize(value, type, "")));

it("matches the independent complete Job and redacted Secret goldens through the native client serializer", () => {
  const job = Result.getOrThrow(buildJob({ run, function: rich, config, resultUploadUrl: upload }));
  expect(job).toEqual(golden("job"));
  expect(wire(job, "V1Job")).toEqual(golden("job"));
  const token = randomBytes(32).toString("base64url");
  const secret = Result.getOrThrow(buildSecret({ run, config, token }));
  expect(Buffer.from(secret.data?.token ?? "", "base64").toString() === token).toBe(true);
  const redacted = { ...wire(secret, "V1Secret"), data: { token: "[REDACTED]" } };
  expect(redacted).toEqual(golden("secret"));
  expect(secret.metadata?.ownerReferences).toBeUndefined();
  expect(job.metadata?.ownerReferences).toBeUndefined();
  expect(JSON.stringify(job).includes(token)).toBe(false);
});

it("omits every unset optional and preserves the mandated default hardening and env order", () => {
  const job = Result.getOrThrow(buildJob({ run, function: resource(), config }));
  const pod = job.spec?.template.spec;
  const container = pod?.containers[0];
  expect(job.spec?.backoffLimit).toBe(0);
  expect(pod?.terminationGracePeriodSeconds).toBe(30);
  expect(pod?.automountServiceAccountToken).toBe(false);
  expect(pod?.securityContext).toEqual({
    runAsNonRoot: true,
    runAsUser: 65532,
    runAsGroup: 65532,
    seccompProfile: { type: "RuntimeDefault" },
  });
  expect(pod?.tolerations).toEqual([
    {
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 60,
    },
    {
      key: "node.kubernetes.io/unreachable",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 60,
    },
  ]);
  for (const key of ["hostUsers", "imagePullSecrets", "nodeSelector"])
    expect(Object.hasOwn(pod ?? {}, key)).toBe(false);
  for (const key of ["resources", "envFrom"])
    expect(Object.hasOwn(container ?? {}, key)).toBe(false);
  expect(container?.env?.map((e) => e.name)).toEqual([
    "HOME",
    "KRUN_RUN_ID",
    "KRUN_FUNCTION",
    "KRUN_GATEWAY_URL",
    "KRUN_TOKEN",
    "KRUN_MAX_RESULT_BYTES",
  ]);
  expect(container?.securityContext).toEqual({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
  expect(pod?.volumes).toEqual([{ name: "tmp", emptyDir: {} }]);
});

for (const hostUsers of [true, false])
  it(`renders hostUsers only as false, configured ${hostUsers}`, () => {
    const actual = Result.getOrThrow(
      buildJob({
        run,
        function: rich,
        config: { ...config, KRUN_JOB_HOST_USERS: hostUsers },
        resultUploadUrl: upload,
      }),
    );
    const expected = golden("job");
    if (!hostUsers) expected.spec.template.spec.hostUsers = false;
    expect(wire(actual, "V1Job")).toEqual(expected);
  });

for (const [heartbeatTimeout, seconds] of [
  ["30001ms", "30.001"],
  ["30s", "30"],
  ["1h", "3600"],
  ["9007199254740991ms", "9007199254740.991"],
])
  it(`preserves heartbeat ${heartbeatTimeout} in seconds`, () => {
    const job = Result.getOrThrow(
      buildJob({
        run,
        function: resource({ heartbeatTimeout }),
        config: { ...config, KRUN_MAX_RESULT_BYTES: 0 },
      }),
    );
    expect(job.spec?.template.spec?.containers[0]?.env).toContainEqual({
      name: "KRUN_HEARTBEAT_TIMEOUT",
      value: seconds,
    });
    expect(job.spec?.template.spec?.containers[0]?.env).toContainEqual({
      name: "KRUN_MAX_RESULT_BYTES",
      value: "0",
    });
  });

it("returns independent snapshots without mutating or aliasing Function data or resource labels", () => {
  const fn = structuredClone(rich);
  const before = JSON.stringify(fn);
  const first = Result.getOrThrow(buildJob({ run, function: fn, config }));
  const second = Result.getOrThrow(buildJob({ run, function: fn, config }));
  first.metadata!.labels!["krun.io/function"] = "changed";
  first.spec!.template.spec!.containers[0]!.env!.at(-1)!.value = "changed";
  first.spec!.template.spec!.nodeSelector!.pool = "changed";
  first.spec!.template.spec!.containers[0]!.resources!.requests!.cpu = "changed";
  expect(JSON.stringify(fn)).toBe(before);
  expect(second.metadata?.labels?.["krun.io/function"]).toBe("echo");
  expect(first.spec?.template.metadata?.labels?.["krun.io/function"]).toBe("echo");
  expect(second.spec?.template.spec?.nodeSelector?.pool).toBe("functions");
});

for (const changed of [
  { id: "not-a-run" },
  { id: run.id.toUpperCase() },
  { function_name: "x".repeat(64) },
  { created_by: "bad/name" },
  { created_by: "x".repeat(64) },
])
  it(`rejects invalid identity field ${Object.keys(changed)[0]} with bounded diagnostics`, () => {
    const result = buildJob({ run: { ...run, ...changed }, function: rich, config });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ManifestInvalid);
      expect(JSON.stringify(result.failure).includes(Object.values(changed)[0] ?? "")).toBe(false);
    }
  });

it("rejects mismatched Functions and malformed tokens without retaining their data", () => {
  expect(
    Result.isFailure(buildJob({ run, function: { ...rich, metadata: { name: "other" } }, config })),
  ).toBe(true);
  const token = randomBytes(4).toString("base64url");
  const result = buildSecret({ run, config, token });
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(JSON.stringify(result.failure).includes(token)).toBe(false);
});

it("adapts absent resource quantities without undefined Kubernetes dictionary values", () => {
  const fn = resource({
    resources: { requests: { memory: "64Mi", cpu: undefined }, limits: undefined },
  });
  const job = Result.getOrThrow(buildJob({ run, function: fn, config }));
  expect(job.spec?.template.spec?.containers[0]?.resources).toEqual({
    requests: { memory: "64Mi" },
  });
  expect(wire(job, "V1Job").spec.template.spec.containers[0].resources).toEqual({
    requests: { memory: "64Mi" },
  });
});
it("accepts maximum label lengths and never copies private Run fields", () => {
  const full = {
    ...run,
    function_name: "a".repeat(63),
    created_by: "A".repeat(63),
    input: { privateInput: true },
    result: { privateResult: true },
  };
  const job = Result.getOrThrow(
    buildJob({ run: full, function: { ...rich, metadata: { name: full.function_name } }, config }),
  );
  expect(job.metadata?.name?.length).toBe(41);
  expect(job.metadata?.labels?.["krun.io/created-by"]).toBe(full.created_by);
  expect(JSON.stringify(job).includes("privateInput")).toBe(false);
  expect(JSON.stringify(job).includes("privateResult")).toBe(false);
});
it("fails closed on invalid namespaces, heartbeat duration and Secret identity", () => {
  expect(
    Result.isFailure(
      buildJob({
        run,
        function: rich,
        config: { ...config, KRUN_JOBS_NAMESPACE: "invalid/namespace" },
      }),
    ),
  ).toBe(true);
  expect(
    Result.isFailure(
      buildJob({
        run,
        function: { ...rich, spec: { ...rich.spec, heartbeatTimeout: "not-a-duration" } },
        config,
      }),
    ),
  ).toBe(true);
  expect(
    Result.isFailure(
      buildSecret({
        run: { ...run, id: "not-a-run" },
        config,
        token: randomBytes(32).toString("base64url"),
      }),
    ),
  ).toBe(true);
});

const privacyId = "0192f000-0000-7000-8000-000000000001";
const privacyAccessKeyId = randomBytes(16).toString("hex");
const privacySigned = `http://krun-test-minio.krun-test-minio.svc.cluster.local:9000/krun-test-results/runs/${privacyId}/result.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${privacyAccessKeyId}%2F20261028%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261028T000000Z&X-Amz-SignedHeaders=host&X-Amz-Expires=120&X-Amz-Signature=${"a".repeat(64)}`;
const privacyPod = () => ({
  metadata: { labels: { "krun.io/run-id": privacyId } },
  spec: {
    containers: [
      {
        name: "function",
        image: `registry.example.invalid/privacy@sha256:${"a".repeat(64)}`,
        env: [
          { name: "KRUN_RUN_ID", value: privacyId },
          { name: "KRUN_RESULT_UPLOAD_URL", value: privacySigned },
          {
            name: "KRUN_TOKEN",
            valueFrom: { secretKeyRef: { name: `krun-${privacyId}`, key: "token" } },
          },
        ],
      },
    ],
  },
});

const nativePrivacyPod = (spec: object = {}) => {
  const original = privacyPod();
  return JSON.parse(
    JSON.stringify(
      ObjectSerializer.serialize(
        {
          ...original,
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            ...original.metadata,
            name: "krun-test-reference",
            namespace: "krun-test-postgres-jobs",
          },
          spec: { ...original.spec, restartPolicy: "Never", ...spec },
        },
        "V1Pod",
        "",
      ),
    ),
  );
};
const platformSecretNames = [
  "krun-test-minio-credentials",
  "krun-test-postgres",
  "krun-e2e-keys",
  "krun-e2e-webhook-keys",
];
for (const secretName of platformSecretNames) {
  for (const location of ["imagePullSecrets", "nodePublishSecretRef"] as const) {
    it(`rejects native-serialized ${location} platform reference ${secretName} before capability observation`, () => {
      const value = nativePrivacyPod(
        location === "imagePullSecrets"
          ? { imagePullSecrets: [{ name: secretName }] }
          : {
              volumes: [
                {
                  name: "platform",
                  csi: {
                    driver: "example.invalid/csi",
                    nodePublishSecretRef: { name: secretName },
                  },
                },
              ],
            },
      );
      const reference =
        location === "imagePullSecrets"
          ? value.spec.imagePullSecrets[0].name
          : value.spec.volumes[0].csi.nodePublishSecretRef.name;
      expect(reference === secretName).toBe(true);
      let observed = false;
      expect(() =>
        privatePodManifest(JSON.stringify(value), () => {
          observed = true;
        }),
      ).toThrow("Invalid native upload URL witness");
      expect(observed).toBe(false);
    });
  }
}
it("retains native per-Run references in both additional fields and the legitimate namespace substring", () => {
  const name = `krun-${privacyId}`;
  const value = nativePrivacyPod({
    imagePullSecrets: [{ name }],
    volumes: [
      { name: "run", csi: { driver: "example.invalid/csi", nodePublishSecretRef: { name } } },
    ],
  });
  expect(value.metadata.namespace).toBe("krun-test-postgres-jobs");
  expect(value.spec.imagePullSecrets[0].name).toBe(name);
  expect(value.spec.volumes[0].csi.nodePublishSecretRef.name).toBe(name);
  expect(() => privatePodManifest(JSON.stringify(value))).not.toThrow();
});
it("does not mistake native non-Secret name/driver fields for a platform reference", () => {
  for (const name of platformSecretNames) {
    const value = nativePrivacyPod({
      volumes: [
        { name: "data", configMap: { name } },
        { name: "csi", csi: { driver: name } },
      ],
    });
    value.metadata.name = name;
    expect(value.spec.volumes[0].configMap.name).toBe(name);
    expect(value.spec.volumes[1].csi.driver).toBe(name);
    expect(() => privatePodManifest(JSON.stringify(value))).not.toThrow();
  }
});
