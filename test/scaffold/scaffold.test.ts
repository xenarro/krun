import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dispatcher = join(root, "bin/krun.js");
const packages = [
  "packages/shared",
  "packages/sdk-node",
  "packages/cli",
  "apps/gateway",
  "apps/scheduler",
];

function run(args: string[], cwd = root) {
  return spawnSync(process.execPath, [dispatcher, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("scaffold acceptance", () => {
  // migrate has real database/exit-code coverage in shared's migration suite.
  it.each(["gateway", "scheduler"])(
    "dispatches finite %s without production configuration",
    (command) => {
      const result = run([command], tmpdir());
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(command);
      expect(result.stderr).toBe("");
    },
  );

  it("dispatches validate help without production configuration", () => {
    const result = run(["validate", "--help"], tmpdir());
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Usage: krun validate [--help] <path>...");
    expect(result.stderr).toBe("");
  });

  it.each([[], ["unknown"], ["constructor"], ["__proto__"]])(
    "rejects unknown command %j",
    (...args) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    },
  );

  it("offers help without loading an application", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gateway|scheduler|migrate|validate");
    expect(result.stderr).toBe("");
  });

  it("forwards only the arguments after the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "krun-dispatch-"));
    try {
      const capture = join(dir, "capture.mjs");
      const loader = join(dir, "loader.mjs");
      writeFileSync(capture, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(
        loader,
        `import { registerHooks } from 'node:module';\nregisterHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); return resolved.url.endsWith('/packages/cli/dist/validate.js') ? { url: ${JSON.stringify(pathToFileURL(capture).href)}, shortCircuit: true } : resolved; } });\n`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", loader, dispatcher, "validate", "a.yaml", "b.yaml"],
        { cwd: dir, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["a.yaml", "b.yaml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps production dependencies free of Redis", () => {
    const tree: unknown = JSON.parse(
      execFileSync("pnpm", ["list", "--recursive", "--prod", "--depth", "Infinity", "--json"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      }),
    );
    function inspect(value: unknown): void {
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        expect(key).not.toBe("redis");
        inspect(child);
      }
    }
    inspect(tree);
  });

  it("emits only production source and leaves SDK runtime dependencies empty", () => {
    for (const path of packages) {
      const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
      expect(manifest.type).toBe("module");
      const files = readdirSync(join(root, path, "dist"), { recursive: true }).map(String);
      expect(files.some((file) => file.endsWith(".js"))).toBe(true);
      expect(files.some((file) => file.includes(".test.") || file.includes("vitest.config"))).toBe(
        false,
      );
    }
    const sdk = JSON.parse(readFileSync(join(root, "packages/sdk-node/package.json"), "utf8"));
    expect(sdk.dependencies).toBeUndefined();
    expect(sdk.engines.node).toBe(">=22");
  });
});
