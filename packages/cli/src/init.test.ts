import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";

const cli = fileURLToPath(new URL("../../../bin/krun.js", import.meta.url));
const roots: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "krun-test-init-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, "init", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
      ),
    ),
  });
}
it("generates the complete version-coupled Node project outside the CLI working directory", () => {
  const root = directory();
  const result = run(["--lang", "node", "nested/sample"], root);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  const target = join(root, "nested/sample");
  expect(readdirSync(target).sort()).toEqual(
    [
      ".dockerignore",
      ".gitignore",
      "Dockerfile",
      "README.md",
      "function.yaml",
      "handler.js",
      "handler.test.js",
      "package.json",
    ].sort(),
  );
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  expect(pkg.name).toBe("sample");
  expect(pkg.dependencies).toEqual({ "@krun/sdk": `^${version}` });
  expect(pkg.devDependencies).toBeUndefined();
  expect(pkg.scripts.test).toBe("node --test");
  expect(parse(readFileSync(join(target, "function.yaml"), "utf8"))).toMatchObject({
    metadata: { name: "sample" },
    spec: { image: "REPLACE_WITH_DIGEST", heartbeatTimeout: "5m" },
  });
  expect(readFileSync(join(target, "Dockerfile"), "utf8")).toContain("USER 65532:65532");
  expect(result.stderr).toContain("npm test");
});
for (const name of ["0", "01", "123", "1e3", "true", "false", "null"]) {
  for (const explicit of [false, true]) {
    it(`preserves YAML-looking DNS label ${name} (${explicit ? "--name" : "basename"})`, () => {
      const root = directory();
      const target = explicit ? "sample" : name;
      const result = run(["--lang", "node", ...(explicit ? ["--name", name] : []), target], root);
      expect(result.status, result.stderr).toBe(0);
      expect(parse(readFileSync(join(root, target, "function.yaml"), "utf8")).metadata.name).toBe(
        name,
      );
      expect(JSON.parse(readFileSync(join(root, target, "package.json"), "utf8")).name).toBe(name);
    });
  }
}
it("accepts explicit names and preserves unrelated hidden entries", () => {
  const root = directory();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".notes"), "keep");
  const result = run(["--lang=node", "--name=chosen-name", root], directory());
  expect(result.status, result.stderr).toBe(0);
  expect(parse(readFileSync(join(root, "function.yaml"), "utf8")).metadata.name).toBe(
    "chosen-name",
  );
  expect(readFileSync(join(root, ".notes"), "utf8")).toBe("keep");
});
for (const args of [
  ["t"],
  ["--lang", "go", "t"],
  ["--lang", "node"],
  ["--lang", "node", "a", "b"],
  ["--force", "--lang", "node", "t"],
  ["--lang", "node", "--name=Bad", "t"],
  ["--lang", "node", "--name=-bad", "t"],
  ["--lang", "node", `--name=${"a".repeat(64)}`, "t"],
]) {
  it(`fails invalid arguments before writing: ${args.join(" ")}`, () => {
    const root = directory();
    const result = run(args, root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Try this:");
    expect(readdirSync(root)).toEqual([]);
  });
}
for (const filename of ["function.yaml", "keep.txt", ".gitignore"]) {
  it(`refuses to overwrite ${filename}`, () => {
    const root = directory();
    writeFileSync(join(root, filename), "keep");
    const result = run(["--lang", "node", "--name=safe", root], directory());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(filename);
    expect(readFileSync(join(root, filename), "utf8")).toBe("keep");
    expect(readdirSync(root)).toEqual([filename]);
  });
}
it("rejects a symlink target without altering its destination", () => {
  const root = directory();
  const elsewhere = directory();
  symlinkSync(elsewhere, join(root, "alias"));
  const result = run(["--lang", "node", "alias"], root);
  expect(result.status).toBe(1);
  expect(readdirSync(elsewhere)).toEqual([]);
});
it("packed CLI keeps its executable and all template assets", () => {
  const root = directory();
  const result = spawnSync(
    "pnpm",
    ["--dir", fileURLToPath(new URL("..", import.meta.url)), "pack", "--pack-destination", root],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const archive = readdirSync(root).find((name) => name.endsWith(".tgz"));
  expect(archive).toBeDefined();
  const contents = spawnSync("tar", ["-tzf", join(root, archive ?? "")], { encoding: "utf8" });
  expect(contents.status).toBe(0);
  expect(contents.stdout).toContain("package/dist/main.js");
  for (const name of [
    "handler.js",
    "handler.test.js",
    "package.json",
    "Dockerfile",
    ".dockerignore",
    "gitignore",
    "function.yaml",
    "README.md",
  ])
    expect(contents.stdout).toContain(`package/templates/node/${name}`);
});
it("generated placeholders are rejected by the real validate command", () => {
  const root = directory();
  expect(run(["--lang", "node", "sample"], root).status).toBe(0);
  const result = spawnSync(
    process.execPath,
    [cli, "validate", join(root, "sample/function.yaml")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_")),
      ),
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("REPLACE_WITH_DIGEST");
  expect(result.stdout).toContain("spec.image");
});
it("provides init help without writing or requiring production configuration", () => {
  const root = directory();
  const result = run(["--help"], root);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: krun init");
  expect(readdirSync(root)).toEqual([]);
});
