import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

it("wires read-only SHA-pinned CI without untrusted shell interpolation", () => {
  const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  expect(workflow).toContain("push:");
  expect(workflow).toContain("pull_request:");
  expect(workflow).not.toContain("pull_request_target:");
  expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
  expect(workflow).not.toMatch(/:\s*write\b/);
  expect(workflow).toContain("persist-credentials: false");
  for (const match of workflow.matchAll(/uses:\s*(\S+)/g)) {
    expect(match[1]).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
  }
  expect(workflow).not.toContain("continue-on-error");
  expect(workflow).not.toMatch(/run:.*\$\{\{/);
  for (const command of [
    "make check",
    "make generate",
    "git diff --exit-code",
    "make docker",
    "make helm-lint",
    "pnpm audit --prod --audit-level=critical",
  ]) {
    expect(workflow).toContain(command);
  }
  expect(workflow).toContain("severity: CRITICAL");
  expect(workflow).toContain('ignore-unfixed: "true"');
  expect(workflow).toContain('exit-code: "1"');
  expect(workflow).toContain("node-version-file: .node-version");
  expect(workflow).toContain("process.getuid()");
  expect(workflow).toContain("node scripts/smoke-gateway.ts krun:local");
  expect(workflow).toContain("gateway --help");
});

it("runs Knip in make check and keeps dependency updates reviewable", () => {
  const makefile = readFileSync(new URL("Makefile", root), "utf8");
  expect(makefile).toContain("pnpm exec knip");
  const config = JSON.parse(readFileSync(new URL("renovate.json", root), "utf8"));
  expect(config.enabledManagers).toEqual(
    expect.arrayContaining(["npm", "dockerfile", "github-actions"]),
  );
  expect(config.packageRules).toContainEqual(
    expect.objectContaining({ matchUpdateTypes: ["major"], dependencyDashboardApproval: true }),
  );
});
