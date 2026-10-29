import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { chartValues } from "../e2e/lib/chart.js";
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

it("uses the chart for both isolated restricted modes without parallel raw policy/workload definitions", () => {
  for (const mode of ["embedded", "postgres"] as const) {
    const values = chartValues(mode, `localhost:5001/krun@sha256:${"a".repeat(64)}`);
    expect(values.db.mode).toBe(mode);
    expect(values.jobsNamespace.name).toBe(`krun-test-${mode}-jobs`);
    expect(values.jobsNamespace.keep).toBe(false);
    expect(values.crds).toEqual({ install: true, keep: false });
    expect(values.scheduler.replicas).toBe(mode === "postgres" ? 2 : 1);
    expect(values.objectStorage.egress).toEqual([
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "krun-test-minio" } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "krun-test-minio" } },
      },
    ]);
  }
  const source = read("test/e2e/cluster.ts");
  expect(source).toContain('"deploy/helm/krun"');
  expect(source).not.toContain("krun-embedded.yaml");
});

it("keeps mandatory infrastructure verification outside the zero-scenario runner", () => {
  const make = read("Makefile");
  expect(make).toContain("node test/e2e/cluster.ts up");
  expect(make).toContain("node test/e2e/cluster.ts verify");
  expect(make).toContain("vitest run --config test/e2e/vitest.config.ts");
  expect(read("test/e2e/vitest.config.ts")).toContain("passWithNoTests: false");
});

it("lets owned PID1 probe servers and clients exit cooperatively without extending cleanup budgets", () => {
  const stop = "process.once('SIGTERM',()=>process.exit(0));";
  const source = read("test/e2e/cluster.ts");
  expect(source).toContain(`${stop}require('node:http')`);
  expect(source).toContain(`${stop}setInterval`);
  expect(read("test/e2e/lib/chart-harness.ts")).toContain(`${stop}setInterval`);
  expect(source).toContain('"--timeout=60s"');
  expect(source).not.toContain('"--grace-period=0"');
});
