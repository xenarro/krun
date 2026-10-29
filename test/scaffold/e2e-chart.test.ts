import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

it("runs fresh chart installs and the complete scenario runner in both database modes", () => {
  const make = read("Makefile");
  expect(make).toContain("for mode in embedded postgres");
  expect(make).toContain('node test/e2e/cluster.ts install "$$mode"');
  expect(make).toContain("node test/e2e/cluster.ts verify");
  expect(make).toContain("vitest run --config test/e2e/vitest.config.ts");
  expect(make).toContain("node test/e2e/cluster.ts uninstall");
  const source = read("test/e2e/cluster.ts");
  for (const raw of ["krun-embedded.yaml", "jobs-namespace.yaml", "allow-minio.yaml"])
    expect(source).not.toContain(raw);
  expect(source).toContain('"install"');
  expect(source).toContain('"uninstall"');
});

it("installs the same pinned Helm before chart-installed hosted e2e", () => {
  const workflow = parse(read(".github/workflows/ci.yml"));
  const steps = workflow.jobs.kind.steps;
  const setup = steps.findIndex((s: { uses?: string }) => s.uses?.startsWith("azure/setup-helm@"));
  expect(setup).toBeGreaterThan(-1);
  expect(steps[setup].with.version).toBe("v4.3.0");
  expect(setup).toBeLessThan(steps.findIndex((s: { run?: string }) => s.run === "make e2e"));
});

it("uses an ordinary restricted PostgreSQL Deployment, with generated credentials referenced only", () => {
  const docs = parseAllDocuments(read("test/e2e/postgres.yaml")).map((d) => d.toJSON());
  expect(
    docs.some((d) => ["Secret", "StatefulSet", "CustomResourceDefinition"].includes(d.kind)),
  ).toBe(false);
  const deployment = docs.find((d) => d.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod.securityContext.runAsNonRoot).toBe(true);
  expect(pod.securityContext.seccompProfile.type).toBe("RuntimeDefault");
  const postgres = pod.containers[0];
  expect(postgres.image).toMatch(/^postgres:18@sha256:[a-f0-9]{64}$/);
  expect(
    postgres.env.find((e: { name: string }) => e.name === "POSTGRES_PASSWORD").valueFrom
      .secretKeyRef,
  ).toEqual({ name: "krun-test-postgres", key: "password" });
  expect(postgres.securityContext).toEqual({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
});

it("observes public Service HTTP convergence after exact serving Pod readiness without replaying POSTs", () => {
  const source = read("test/e2e/lib/chart-harness.ts");
  expect(source).toContain('"Public Service unauthenticated readiness"');
  expect(source).toContain('method:"GET"');
  expect(source).toContain("r.status===401");
  expect(source).toContain("await publicReady();");
  expect(source).toContain("publicServiceReady: true");
  const wait = source.slice(source.indexOf("const waitReady ="), source.indexOf("const change ="));
  expect(wait.indexOf("await publicReady();")).toBeGreaterThan(
    wait.indexOf("const ready = await eventually("),
  );
  expect(read("test/e2e/lib/harness.ts")).not.toContain("retryPost");
});
