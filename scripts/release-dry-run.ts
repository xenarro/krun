import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { assertArtifactInventory, prepareNodeArtifacts } from "./release-artifacts.ts";
import { releaseFiles, releaseVersion, stampVersion } from "./stamp-version.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "krun-test-release-"));
const checkout = join(work, "checkout");
const artifacts = join(work, "artifacts");
await mkdir(checkout);
await mkdir(artifacts);
await mkdir(join(work, "logs"));
let sequence = 0;
const command = (exe: string, args: string[], label: string, cwd = checkout, input?: string) => {
  const result = spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    input,
    env: process.env,
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = join(work, "logs", `${++sequence}-${label.replace(/[^a-zA-Z0-9-]/g, "-")}`);
  writeFileSync(`${log}.stdout`, result.stdout ?? "");
  writeFileSync(`${log}.stderr`, result.stderr ?? "");
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed`);
  }
  return result.stdout;
};
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
let image: string | undefined;
try {
  const number = z
    .string()
    .regex(/^[1-9]\d*$/)
    .parse(process.env.RELEASE_PR_NUMBER ?? process.argv[2] ?? "1");
  // Stable numeric synthetic SemVer is also valid PEP440 and a Docker tag.
  // It is never uploaded or published by this script.
  const version = releaseVersion(process.env.RELEASE_VERSION || `0.0.${number}`);
  const commit = command("git", ["rev-parse", "HEAD"], "source identity", root).trim();
  const sourceDirty =
    command("git", ["status", "--porcelain"], "source worktree identity", root).trim().length > 0;
  const paths = command(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    "source inventory",
    root,
  )
    .split("\0")
    .filter(Boolean);
  const sourceHashes: Record<string, string> = {};
  for (const name of paths) {
    if (/(^|\/)\.(env|npmrc|pypirc)(\.|$)/.test(name)) continue;
    sourceHashes[name] = await hashFile(join(root, name));
    await mkdir(dirname(join(checkout, name)), { recursive: true });
    await cp(join(root, name), join(checkout, name), { recursive: false, dereference: false });
  }
  const changelog = await readFile(join(checkout, "CHANGELOG.md"), "utf8");
  if (!/^## \[0\.1\.0\]/m.test(changelog)) throw new Error("Missing target release changelog");
  command("pnpm", ["install", "--frozen-lockfile"], "guarded frozen release install");
  const before = await Promise.all(releaseFiles.map((name) => hashFile(join(checkout, name))));
  await stampVersion(checkout, version);
  command("pnpm", ["-r", "build"], "release build");
  const packages = await prepareNodeArtifacts(checkout, join(work, "packages"));
  for (const [name, directory] of [
    ["sdk", packages.sdkDirectory],
    ["cli", packages.cliDirectory],
  ] as const) {
    command("pnpm", ["run", "release:lint", directory], `${name} publint`);
    command("pnpm", ["run", "release:types", "--pack", directory], `${name} strict attw --pack`);
    command(
      "pnpm",
      ["--dir", directory, "pack", "--pack-destination", artifacts],
      `${name} package`,
    );
  }
  command("uv", ["build", "sdk/python", "--out-dir", artifacts], "Python wheel and sdist");
  await rm(join(artifacts, ".gitignore"), { force: true });
  command("helm", ["package", "deploy/helm/krun", "--destination", artifacts], "Helm package");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  const archives = await readdir(artifacts);
  const sdkArchive = archives.find((name) => name.startsWith("krun-sdk-") && name.endsWith(".tgz"));
  const cliArchive = archives.find((name) => name.startsWith("krun-cli-") && name.endsWith(".tgz"));
  if (!sdkArchive || !cliArchive) throw new Error("Missing packed Node artifacts");
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "krun-test-release-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@krun/sdk": `file:${join(artifacts, sdkArchive)}`,
        "@krun/cli": `file:${join(artifacts, cliArchive)}`,
      },
    }),
  );
  const policy = parse(await readFile(join(checkout, "pnpm-workspace.yaml"), "utf8"));
  policy.packages = [];
  // The patched validator is inside the CLI artifact. Do not try to apply
  // workspace patch declarations to a consumer graph without those packages.
  // All release-age, script-denial and peer-install controls are retained.
  delete policy.patchedDependencies;
  await writeFile(join(consumer, "pnpm-workspace.yaml"), stringify(policy));
  await cp(join(checkout, "patches"), join(consumer, "patches"), { recursive: true });
  command("pnpm", ["install"], "standalone guarded CLI and SDK install", consumer);
  for (const [mode, code] of [
    ["module", 'import { run } from "@krun/sdk"; if(typeof run!=="function")process.exit(1)'],
    ["commonjs", 'if(typeof require("@krun/sdk").run!=="function")process.exit(1)'],
  ] as const)
    command(
      process.execPath,
      ["--input-type", mode, "-e", code],
      `${mode} installed SDK`,
      consumer,
    );
  const cli = join(consumer, "node_modules/@krun/cli/dist/main.js");
  command(process.execPath, [cli, "--help"], "installed CLI help", consumer);
  for (const language of ["node", "python"]) {
    command(
      process.execPath,
      [cli, "init", "--lang", language, `krun-test-release-${language}`],
      `${language} installed CLI template`,
      consumer,
    );
  }
  const functionPath = join(consumer, "krun-test-release-node/function.yaml");
  const fn = parse(await readFile(functionPath, "utf8"));
  fn.spec.image = `example.test/krun-test-function@sha256:${"a".repeat(64)}`;
  await writeFile(functionPath, stringify(fn));
  command(
    process.execPath,
    [cli, "validate", functionPath],
    "installed CLI vendored schema",
    consumer,
  );
  const wheel = archives.find((name) => name.endsWith(".whl"));
  if (!wheel) throw new Error("Missing Python wheel");
  command("uv", ["venv", join(work, "venv")], "installed wheel environment");
  command(
    "uv",
    [
      "pip",
      "install",
      "--python",
      join(work, "venv/bin/python"),
      "--no-deps",
      join(artifacts, wheel),
    ],
    "installed wheel",
  );
  command(
    join(work, "venv/bin/python"),
    [
      "-c",
      "import krun,importlib.metadata as m; assert callable(krun.run); assert not m.requires('krun')",
    ],
    "dependency-free installed Python SDK",
  );
  const candidateImage = `krun-test-release:${version}`;
  if (
    command(
      "docker",
      ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
      "release image inventory",
    )
      .split("\n")
      .includes(candidateImage)
  )
    throw new Error("Refusing an existing release test image");
  command(
    "docker",
    [
      "build",
      "--build-arg",
      `KRUN_VERSION=${version}`,
      "--build-arg",
      `KRUN_COMMIT=${commit}`,
      "--tag",
      candidateImage,
      ".",
    ],
    "release image build",
  );
  image = candidateImage;
  const imageInfo = JSON.parse(command("docker", ["inspect", image], "release image identity"))[0];
  if (
    imageInfo.Config.Labels["org.opencontainers.image.version"] !== version ||
    imageInfo.Config.Labels["org.opencontainers.image.revision"] !== commit ||
    imageInfo.Config.User !== "65532:65532"
  )
    throw new Error("Release image metadata mismatch");
  command(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `krun-test-release-smoke-${number}`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      image,
      "--help",
    ],
    "non-root release image smoke",
  );
  command(
    "docker",
    ["save", "--output", join(artifacts, "image.tar"), image],
    "release image archive",
  );
  assertArtifactInventory(await readdir(artifacts), version);
  const files: Record<string, string> = {};
  for (const name of await readdir(artifacts)) files[name] = await hashFile(join(artifacts, name));
  const changed = [];
  for (const [index, name] of releaseFiles.entries())
    if (before[index] !== (await hashFile(join(checkout, name)))) changed.push(name);
  for (const [name, hash] of Object.entries(sourceHashes))
    if ((await hashFile(join(root, name))) !== hash)
      throw new Error("Product checkout changed during rehearsal");
  const manifest = {
    version,
    targetVersion: "0.1.0",
    commit,
    sourceDirty,
    files,
    image,
    published: false,
    sourceCheckoutUnmodified: true,
    nodeFormats: ["esm", "commonjs"],
    installedCli: true,
    installedPythonSdk: true,
    strictExports: true,
    changedStampFiles: changed,
  };
  await writeFile(join(artifacts, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `artifact_directory=${artifacts}\n`, { flag: "a" });
  console.log(
    JSON.stringify({ event: "release_dry_run", ...manifest, artifactDirectory: artifacts }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release preparation failed");
  console.error(`Private preparation workspace retained: ${work}`);
  process.exitCode = 1;
} finally {
  if (image) command("docker", ["image", "rm", image], "owned release image cleanup");
}
