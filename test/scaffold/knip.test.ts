import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("Knip accepts used code and rejects an unused entry export", () => {
  const directory = mkdtempSync(join(tmpdir(), "krun-knip-"));
  try {
    writeFileSync(join(directory, "knip.json"), readFileSync(join(root, "knip.json")));
    writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
    mkdirSync(join(directory, "bin"));
    const entry = join(directory, "bin/krun.js");
    writeFileSync(entry, 'console.log("used");\n');
    const run = () =>
      spawnSync(process.execPath, [join(root, "node_modules/knip/bin/knip.js")], {
        cwd: directory,
        encoding: "utf8",
        timeout: 15_000,
      });
    const clean = run();
    expect(clean.error).toBeUndefined();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    writeFileSync(entry, "export const unused = 1;\n");
    const unused = run();
    expect(unused.error).toBeUndefined();
    expect(unused.status).not.toBe(0);
    expect(unused.stdout).toContain("unused");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
