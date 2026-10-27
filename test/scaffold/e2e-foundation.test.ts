import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import {
  assertRegistryOwner,
  contextArgs,
  parsePushDigest,
  probeVerdict,
} from "../e2e/lib/contracts.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

it("pins the same policy-enforcing kind version locally and in CI", () => {
  expect(read(".kind-version").trim()).toBe("v0.33.0");
  const images = JSON.parse(read("test/e2e/images.json"));
  expect(images.node).toMatch(/^kindest\/node:v1\.37\.0@sha256:[a-f0-9]{64}$/);
  expect(images.registry).toMatch(/^registry:2@sha256:[a-f0-9]{64}$/);
  const config = parse(read("test/e2e/kind.yaml"));
  expect(config.containerdConfigPatches.join("\n")).toContain(
    'config_path = "/etc/containerd/certs.d"',
  );
  const workflow = parse(read(".github/workflows/ci.yml"));
  const job = workflow.jobs.kind;
  expect(job["timeout-minutes"]).toBeGreaterThan(0);
  const installer = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("helm/kind-action@"),
  );
  expect(installer.uses).toBe("helm/kind-action@1544676c07bb3570fcb70166beaa07c4528fd4aa");
  expect(installer.with.version_file).toBe(".kind-version");
  expect(installer.with.install_only).toBe(true);
  expect(job.steps.some((step: { run?: string }) => step.run === "make e2e")).toBe(true);
  expect(
    job.steps.some(
      (step: { run?: string; if?: string }) =>
        step.run === "make kind-down" && step.if === "always()",
    ),
  ).toBe(true);
});

it("uses an explicit isolated kubeconfig and owned context, never ambient selection", () => {
  expect(contextArgs("/owned/krun-test/kubeconfig")).toEqual([
    "--kubeconfig",
    "/owned/krun-test/kubeconfig",
    "--context",
    "kind-krun-test-e2e",
  ]);
});

it("takes the deployed digest only from the local push acknowledgement", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  expect(parsePushDigest(`layer: Pushed\ne2e: digest: ${digest} size: 1234\n`)).toBe(digest);
  for (const invalid of [
    digest,
    `sha256:${"a".repeat(63)}`,
    `e2e: digest: ${digest} size: 1\ne2e: digest: ${digest} size: 1`,
  ])
    expect(() => parsePushDigest(invalid)).toThrow();
});

it("never treats arbitrary probe or kubectl failures as policy enforcement", () => {
  expect(probeVerdict({ code: 0, stdout: "krun-probe-open\n" })).toBe("open");
  expect(probeVerdict({ code: 28, stdout: "krun-probe-blocked\n" })).toBe("blocked");
  for (const failure of [
    { code: 1, stdout: "" },
    { code: 28, stdout: "" },
    { code: 0, stdout: "" },
    { code: null, stdout: "" },
  ])
    expect(() => probeVerdict(failure)).toThrow();
});

it("refuses to adopt or delete another registry at the fixed recipe name", () => {
  const registry = {
    Config: { Labels: { "krun.io/e2e-owner": "owned" } },
    HostConfig: { PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "5001" }] } },
  };
  expect(() => assertRegistryOwner(registry, "owned")).not.toThrow();
  expect(() => assertRegistryOwner(registry, "other")).toThrow();
  expect(() =>
    assertRegistryOwner({ ...registry, HostConfig: { PortBindings: {} } }, "owned"),
  ).toThrow();
});

it("keeps raw job isolation and embedded workload security explicit", () => {
  const jobs = parseAllDocuments(read("test/e2e/jobs-namespace.yaml")).map((doc) => doc.toJSON());
  const namespace = jobs.find((doc) => doc.kind === "Namespace");
  expect(namespace.metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  expect(namespace.metadata.labels["pod-security.kubernetes.io/enforce-version"]).toBe("v1.33");
  const deny = jobs.find(
    (doc) => doc.kind === "NetworkPolicy" && doc.metadata.name === "krun-jobs-deny-all",
  );
  expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  const account = jobs.find((doc) => doc.kind === "ServiceAccount");
  expect(account.automountServiceAccountToken).toBe(false);
  const workload = parseAllDocuments(read("test/e2e/krun-embedded.yaml"))
    .map((doc) => doc.toJSON())
    .find((doc) => doc.kind === "Deployment");
  expect(
    workload.spec.template.spec.containers.map((container: { name: string }) => container.name),
  ).toEqual(["gateway", "scheduler"]);
  expect(workload.spec.template.spec.initContainers[0].args).toEqual(["migrate"]);
  expect(workload.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
  for (const container of workload.spec.template.spec.containers) {
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  }
  const scheduler = workload.spec.template.spec.containers[1];
  expect(
    scheduler.env.find((env: { name: string }) => env.name === "KRUN_POD_NAME").valueFrom.fieldRef
      .fieldPath,
  ).toBe("metadata.name");
  expect(
    workload.spec.template.spec.volumes.find((volume: { name: string }) => volume.name === "data")
      .emptyDir,
  ).toEqual({});
});

it("keeps mandatory infrastructure verification outside the zero-scenario runner", () => {
  const make = read("Makefile");
  expect(make).toContain("node test/e2e/cluster.ts up");
  expect(make).toContain("node test/e2e/cluster.ts verify");
  expect(make).toContain("vitest run --config test/e2e/vitest.config.ts");
  expect(read("test/e2e/vitest.config.ts")).toContain("passWithNoTests: false");
});
