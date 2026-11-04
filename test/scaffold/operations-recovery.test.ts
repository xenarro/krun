import { expect, it } from "vitest";
import { recoveryHelper, replicationTemplate, replicaUrl } from "../e2e/lib/recovery.js";

const image = `localhost:5001/krun@sha256:${"a".repeat(64)}`;
const template = {
  metadata: { labels: { original: "kept" } },
  spec: {
    serviceAccountName: "krun-scheduler",
    initContainers: [
      { name: "litestream-restore", image: "real" },
      { name: "litestream", restartPolicy: "Always" },
      { name: "migrate" },
    ],
    containers: [{ name: "gateway", image }],
  },
};
it("starts a restricted native localhost transport before the actual restore init without altering chart containers", () => {
  const actual = replicationTemplate(template, image);
  expect(actual.spec.initContainers.map((c) => c.name)).toEqual([
    "krun-test-replica-transport",
    "litestream-restore",
    "litestream",
    "migrate",
  ]);
  const transport = actual.spec.initContainers[0];
  expect(transport?.restartPolicy).toBe("Always");
  expect(transport?.securityContext).toMatchObject({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: 65532,
    capabilities: { drop: ["ALL"] },
  });
  expect(actual.spec.containers).toEqual(template.spec.containers);
  expect(template.spec.initContainers).toHaveLength(3);
  expect(replicaUrl).not.toMatch(/@|password|secret|token/i);
});
it("deletes only the exact owned database files through a restricted PVC helper, never host or ambient storage", () => {
  const pod = recoveryHelper(image, "krun-test-embedded", "krun-test-restore-helper");
  expect(pod.metadata.namespace).toBe("krun-test-embedded");
  expect(pod.spec.automountServiceAccountToken).toBe(false);
  expect(pod.spec.securityContext).toMatchObject({ runAsUser: 65532, fsGroup: 65532 });
  expect(pod.spec.volumes).toEqual([
    { name: "data", persistentVolumeClaim: { claimName: "data-e2e-0" } },
  ]);
  expect(pod.spec.containers[0]?.volumeMounts).toEqual([{ name: "data", mountPath: "/data" }]);
  expect(pod.spec.containers[0]?.command.join(" ")).toContain("/data/krun.db");
});
it.each(["postgres", "default", "krun-production"])(
  "refuses destructive helper outside exact disposable namespace %s",
  (namespace) => {
    expect(() => recoveryHelper(image, namespace, "krun-test-restore-helper")).toThrow();
  },
);
it("rejects mutable/foreign image references and non-test helper names", () => {
  expect(() =>
    recoveryHelper("krun:latest", "krun-test-embedded", "krun-test-restore-helper"),
  ).toThrow();
  expect(() => recoveryHelper(image, "krun-test-embedded", "production-helper")).toThrow();
  expect(() =>
    replicationTemplate(
      { ...template, spec: { ...template.spec, initContainers: [{ name: "migrate" }] } },
      image,
    ),
  ).toThrow();
});
