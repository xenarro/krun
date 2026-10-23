import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("root lint ignores nested evidence configurations without ignoring product defects", () => {
  const directory = mkdtempSync(join(tmpdir(), "krun-lint-scope-"));
  try {
    for (const file of ["package.json", "biome.json", "tsconfig.json", "tsconfig.base.json"]) {
      writeFileSync(join(directory, file), readFileSync(join(root, file)));
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    const nested = join(directory, ".agent-state/krun/evidence/review/snapshot");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "biome.json"), '{"root": true}\n');
    const source = join(directory, "test/scaffold");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "fixture.test.ts"), "export {};\n");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lint = () =>
      spawnSync(manifest.scripts.lint, {
        cwd: directory,
        shell: true,
        env: {
          ...process.env,
          PATH: `${join(root, "node_modules/.bin")}${delimiter}${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 20_000,
      });
    const clean = lint();
    expect(clean.error).toBeUndefined();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    writeFileSync(join(source, "fixture.test.ts"), "debugger;\n");
    const invalid = lint();
    expect(invalid.error).toBeUndefined();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("noDebugger");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
