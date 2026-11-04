import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
it("keeps untrusted release validation read-only and publication separately owner-gated", async () => {
  const workflow = parse(await readFile(`${root}.github/workflows/release.yml`, "utf8"));
  expect(workflow.on.pull_request).toBeDefined();
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs["dry-run"].permissions).toEqual({ contents: "read" });
  expect(workflow.jobs["dry-run"].timeoutMinutes).toBeUndefined();
  expect(workflow.jobs["dry-run"]["timeout-minutes"]).toBeGreaterThan(0);
  expect(workflow.jobs.release.environment).toBe("release");
  expect(workflow.jobs.release.if).toContain("github.event_name == 'push'");
  expect(workflow.jobs.release.permissions).toEqual({
    contents: "write",
    packages: "write",
    "id-token": "write",
  });
  const dry = JSON.stringify(workflow.jobs["dry-run"]);
  expect(dry).not.toMatch(/secrets\.|id-token|packages.*write|publish --|docker push|helm push/);
  for (const job of Object.values(workflow.jobs) as {
    steps: { uses?: string; run?: string }[];
  }[]) {
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      if (step.run) expect(step.run).not.toContain("${{");
    }
  }
  const ownership = JSON.parse(await readFile(`${root}release-ownership.json`, "utf8"));
  expect(ownership.repository).toBe("xenarro/krun");
  expect(ownership.workflow).toBe("release.yml");
  expect(ownership.environment).toBe("release");
  expect(ownership.verifiedByOwner).toBe(false);
  expect(ownership.evidence).toEqual([]);
});
it("requires real artifact checks rather than suppressing strict export errors", async () => {
  const dry = await readFile(`${root}scripts/release-dry-run.ts`, "utf8");
  expect(dry).toContain("prepareNodeArtifacts");
  expect(dry).toContain("publint");
  expect(dry).toContain("attw");
  expect(dry).toContain("--pack");
  expect(dry).not.toContain("--ignore-rules");
  expect(dry).not.toContain("--profile");
  expect(dry).toContain('"uv"');
  expect(dry).toContain('"helm"');
  expect(dry).toContain('"docker"');
});
