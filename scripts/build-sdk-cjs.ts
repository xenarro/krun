import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "krun-test-sdk-cjs-"));
try {
  const source = await readFile(join(root, "sdk/node/src/index.ts"), "utf8");
  if (source.split("import.meta.url").length !== 2)
    throw new Error("Expected one SDK metadata file URL");
  await writeFile(
    join(work, "index.cts"),
    source.replace("import.meta.url", 'require("node:url").pathToFileURL(__filename).href'),
  );
  const base = JSON.parse(await readFile(join(root, "tsconfig.base.json"), "utf8"));
  await writeFile(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        ...base.compilerOptions,
        target: "es2022",
        verbatimModuleSyntax: false,
        declaration: true,
        rootDir: work,
        outDir: join(root, "sdk/node/dist"),
        typeRoots: [join(root, "node_modules/@types")],
      },
      files: [join(work, "index.cts")],
    }),
  );
  const result = spawnSync("pnpm", ["exec", "tsc", "-p", join(work, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) throw new Error("SDK CommonJS artifact build failed");
} finally {
  await rm(work, { recursive: true, force: true });
}
