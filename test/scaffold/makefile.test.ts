import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("defines all PLAN target names", () => {
  const source = readFileSync(join(root, "Makefile"), "utf8");
  for (const target of [
    "build",
    "test",
    "lint",
    "check",
    "generate",
    "docker",
    "kind-up",
    "kind-down",
    "e2e",
    "helm-lint",
  ]) {
    expect(source).toMatch(new RegExp(`^${target}:`, "m"));
  }
});

it("generation does nothing when absent and propagates a present generator failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "krun-generate-"));
  try {
    writeFileSync(join(dir, "Makefile"), readFileSync(join(root, "Makefile")));
    const absent = spawnSync("make", ["generate"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    expect(absent.status).toBe(0);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/gen-crd.ts"), "process.exit(7);\n");
    const failed = spawnSync("make", ["generate"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("Error 7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
