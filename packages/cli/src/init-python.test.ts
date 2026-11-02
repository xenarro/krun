import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { parse } from "yaml";
import { InitFiles, InitFilesLive, InitPrompt, InitTerminal, initCommand } from "./init-command.js";

const cli = fileURLToPath(new URL("../../../bin/krun.js", import.meta.url));
const roots: string[] = [];
const files = [
  ".dockerignore",
  ".gitignore",
  "Dockerfile",
  "README.md",
  "function.yaml",
  "handler.py",
  "pyproject.toml",
  "tests",
  "tests/test_handler.py",
].sort();
function directory() {
  const root = mkdtempSync(join(tmpdir(), "krun-test-init-python-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, "init", "--lang", "python", ...args], {
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
it("generates the complete version-coupled Python project with nested tests", () => {
  const cwd = directory();
  const result = run(["nested/sample"], cwd);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("uv run pytest");
  expect(result.stderr).not.toContain("npm");
  const target = join(cwd, "nested/sample");
  expect(readdirSync(target, { recursive: true }).sort()).toEqual(files);
  const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const project = readFileSync(join(target, "pyproject.toml"), "utf8");
  expect(project).toContain('name = "krun-function-sample"');
  expect(project).toContain('requires-python = ">=3.11"');
  expect(project).toContain(`dependencies = ["krun~=${version}"]`);
  expect(project).toContain('[dependency-groups]\ndev = ["pytest"]');
  expect(parse(readFileSync(join(target, "function.yaml"), "utf8"))).toMatchObject({
    metadata: { name: "sample" },
    spec: { image: "REPLACE_WITH_DIGEST", heartbeatTimeout: "5m" },
  });
  const docker = readFileSync(join(target, "Dockerfile"), "utf8");
  expect(docker).toContain("USER 65532:65532");
  expect(docker).toContain('CMD ["python", "handler.py"]');
  expect(docker.indexOf("COPY . .")).toBeLessThan(docker.indexOf("uv sync"));
  expect(docker).toContain("uv sync --locked --no-dev --no-install-project");
  expect(docker).toContain("PYTHONDONTWRITEBYTECODE=1");
  expect(readFileSync(join(target, "handler.py"), "utf8")).toContain('if __name__ == "__main__":');
  for (const file of [".gitignore", ".dockerignore"]) {
    const text = readFileSync(join(target, file), "utf8");
    expect(text).toContain(".venv/");
    expect(text).not.toContain("vendor");
  }
});
for (const name of ["0", "01", "123", "1e3", "true", "false", "null"]) {
  for (const explicit of [false, true]) {
    it(`preserves Python scalar-like function name ${name} (${explicit ? "--name" : "basename"})`, () => {
      const root = directory();
      const target = explicit ? "sample" : name;
      const result = run([...(explicit ? ["--name", name] : []), target], root);
      expect(result.status, result.stderr).toBe(0);
      expect(parse(readFileSync(join(root, target, "function.yaml"), "utf8")).metadata.name).toBe(
        name,
      );
      expect(readFileSync(join(root, target, "pyproject.toml"), "utf8")).toContain(
        `name = "krun-function-${name}"`,
      );
    });
  }
}
for (const name of ["function.yaml", "pyproject.toml", "tests", ".gitignore"]) {
  it(`refuses Python target conflict ${name} and preserves the existing entry`, () => {
    const root = directory();
    writeFileSync(join(root, name), "keep");
    const result = run(["--name=safe", root], directory());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(readdirSync(root)).toEqual([name]);
    expect(readFileSync(join(root, name), "utf8")).toBe("keep");
  });
}
it("preserves unrelated Python target dotfiles", () => {
  const root = directory();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".keep"), "keep");
  expect(run(["--name=safe", root], directory()).status).toBe(0);
  expect(readFileSync(join(root, ".keep"), "utf8")).toBe("keep");
});
it.effect("TTY Python selection uses its template and Python next steps", () =>
  Effect.gen(function* () {
    const cwd = directory();
    const lines: string[] = [];
    let prompts = 0;
    yield* initCommand(["sample"]).pipe(
      Effect.provide(
        Layer.mergeAll(
          InitFilesLive,
          Layer.succeed(InitPrompt, {
            language: Effect.sync(() => {
              prompts++;
              return "python" as const;
            }),
          }),
          Layer.succeed(InitTerminal, {
            cwd,
            isTTY: true,
            output: (_stream, text) =>
              Effect.sync(() => {
                lines.push(text);
              }),
          }),
        ),
      ),
    );
    expect(prompts).toBe(1);
    expect(lines.join("\n")).toContain("uv run pytest");
    expect(readdirSync(join(cwd, "sample"), { recursive: true }).sort()).toEqual(files);
  }),
);
it.effect("nested template rollback removes owned directories but preserves user dotfiles", () =>
  Effect.gen(function* () {
    const cwd = directory();
    writeFileSync(join(cwd, ".keep"), "keep");
    const error = yield* Effect.gen(function* () {
      const fs = yield* InitFiles;
      return yield* fs.publish(
        cwd,
        new Map([
          ["tests/test_handler.py", "pass"],
          ["function.yaml", "kind: NotAFunction"],
        ]),
      );
    }).pipe(Effect.provide(InitFilesLive), Effect.flip);
    expect(error.message).toBe("Generated function.yaml does not satisfy the starter schema.");
    expect(readdirSync(cwd)).toEqual([".keep"]);
  }),
);
it("packed CLI includes every Python template asset", () => {
  const root = directory();
  const packed = spawnSync(
    "pnpm",
    ["--dir", fileURLToPath(new URL("..", import.meta.url)), "pack", "--pack-destination", root],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const archive = readdirSync(root).find((name) => name.endsWith(".tgz"));
  expect(archive).toBeDefined();
  const listing = spawnSync("tar", ["-tzf", join(root, archive ?? "")], { encoding: "utf8" });
  expect(listing.status).toBe(0);
  for (const name of files.filter((name) => name !== "tests"))
    expect(listing.stdout).toContain(
      `package/templates/python/${name === ".gitignore" ? "gitignore" : name}`,
    );
});
it("Python placeholder is rejected by the actual validator", () => {
  const root = directory();
  expect(run(["sample"], root).status).toBe(0);
  const result = spawnSync(
    process.execPath,
    [cli, "validate", join(root, "sample/function.yaml")],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("REPLACE_WITH_DIGEST");
  expect(result.stdout).toContain("spec.image");
});
