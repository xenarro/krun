import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const names = [
  "image.tar",
  "krun-sdk-0.1.0.tgz",
  "krun-cli-0.1.0.tgz",
  "krun-0.1.0.tgz",
  "krun-0.1.0-py3-none-any.whl",
  "krun-0.1.0.tar.gz",
];
const commit = "c".repeat(40);
const boundary = `import cp from 'node:child_process';
import {appendFileSync,writeFileSync}from'node:fs';
import {syncBuiltinESMExports}from'node:module';
const real=cp.spawnSync;
cp.spawnSync=(exe,args,options)=>{
 appendFileSync(process.env.TEST_TRACE,JSON.stringify({exe,args})+'\\n');
 if(exe==='tar')return real(exe,args,options);
 if(!['git','pnpm','docker','helm','cosign','syft','npm','uv','gh'].includes(exe))throw new Error('Unexpected fixture command');
 let stdout='';
 if(exe==='docker'&&args[0]==='push')stdout='digest: sha256:'+'a'.repeat(64);
 if(exe==='helm'&&args[0]==='push')stdout='Digest: sha256:'+'b'.repeat(64);
 if(exe==='syft')writeFileSync(args.at(-1).slice('spdx-json='.length),'{}');
 return {stdout,stderr:'',status:0,signal:null};
};syncBuiltinESMExports();`;
const fixture = async (change?: string) => {
  const work = await mkdtemp(join(tmpdir(), "krun-test-publisher-"));
  directories.push(work);
  const module = join(work, "module");
  const artifacts = join(work, "artifacts");
  await mkdir(module);
  await mkdir(artifacts);
  await symlink(join(root, "node_modules"), join(module, "node_modules"), "dir");
  for (const name of ["release-artifacts.ts", "release-owner-check.ts", "stamp-version.ts"])
    await cp(join(root, "scripts", name), join(module, name));
  const source = await readFile(join(root, "scripts/release-publish.ts"), "utf8");
  const rootDeclaration = 'const root = fileURLToPath(new URL("../", import.meta.url));';
  expect(source.split(rootDeclaration)).toHaveLength(2);
  await writeFile(
    join(module, "release-publish.ts"),
    source.replace(rootDeclaration, "const root = process.env.TEST_RELEASE_ROOT!;"),
  );
  await writeFile(join(work, "boundary.mjs"), boundary);
  await writeFile(join(work, "CHANGELOG.md"), "## [0.1.0] - fixture only\n");
  const ownership = JSON.parse(await readFile(join(root, "release-ownership.json"), "utf8"));
  ownership.verifiedByOwner = change !== "unverified-owner";
  ownership.evidence = ["https://example.test/fixture-not-authorization"];
  await writeFile(join(work, "release-ownership.json"), JSON.stringify(ownership));
  for (const name of names)
    await writeFile(join(artifacts, name), `unit artifact fixture: ${name}`);
  for (const [name, directory] of [
    ["sdk", "sdk/node"],
    ["cli", "packages/cli"],
  ] as const) {
    const packageDirectory = join(work, name, "package");
    await mkdir(packageDirectory, { recursive: true });
    const manifest: Record<string, unknown> = {
      name: `@krun/${name}`,
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/xenarro/krun.git", directory },
    };
    if (change === `missing-${name}-repository`) delete manifest.repository;
    if (change === `wrong-${name}-repository`)
      manifest.repository = {
        type: "git",
        url: "git+https://github.com/other/krun.git",
        directory,
      };
    if (change === `wrong-${name}-directory`)
      manifest.repository = {
        type: "git",
        url: "git+https://github.com/xenarro/krun.git",
        directory: "wrong",
      };
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
    const packed = spawnSync(
      "tar",
      ["-czf", join(artifacts, `krun-${name}-0.1.0.tgz`), "-C", join(work, name), "package"],
      { encoding: "utf8" },
    );
    expect(packed.status).toBe(0);
  }
  const hashes: Record<string, string> = {};
  for (const name of names)
    hashes[name] = createHash("sha256")
      .update(await readFile(join(artifacts, name)))
      .digest("hex");
  const data = {
    version: "0.1.0",
    targetVersion: "0.1.0",
    commit,
    files: hashes,
    image: "krun-test-release:0.1.0",
    sourceDirty: false,
    published: false,
    sourceCheckoutUnmodified: true,
    nodeFormats: ["esm", "commonjs"],
    installedCli: true,
    installedPythonSdk: true,
    strictExports: true,
    changedStampFiles: [],
  };
  await writeFile(join(artifacts, "manifest.json"), JSON.stringify(data));
  if (change === "extra-wheel")
    await writeFile(join(artifacts, "krun-0.0.97-py3-none-any.whl"), "unlisted fixture");
  if (change === "extra-sdist")
    await writeFile(join(artifacts, "krun-0.0.97.tar.gz"), "unlisted fixture");
  if (change === "extra-hidden") await writeFile(join(artifacts, ".extra"), "unlisted fixture");
  if (change === "artifact-directory") {
    await rm(join(artifacts, names[0] ?? ""));
    await mkdir(join(artifacts, names[0] ?? ""));
  }
  if (change === "artifact-symlink") {
    await rm(join(artifacts, names[0] ?? ""));
    await writeFile(join(work, "image-target"), `unit artifact fixture: ${names[0]}`);
    await symlink(join(work, "image-target"), join(artifacts, names[0] ?? ""));
  }
  if (change === "manifest-symlink") {
    await cp(join(artifacts, "manifest.json"), join(work, "manifest-target"));
    await rm(join(artifacts, "manifest.json"));
    await symlink(join(work, "manifest-target"), join(artifacts, "manifest.json"));
  }
  if (change === "tampered-file") await writeFile(join(artifacts, names[0] ?? ""), "tampered");
  const trace = join(work, "trace.jsonl");
  await writeFile(trace, "");
  const env = { ...process.env };
  for (const name of [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "UV_PUBLISH_TOKEN",
    "UV_PUBLISH_PASSWORD",
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ])
    delete env[name];
  Object.assign(env, {
    TEST_RELEASE_ROOT: work,
    TEST_TRACE: trace,
    RELEASE_ARTIFACT_DIRECTORY: artifacts,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: "xenarro/krun",
    GITHUB_ACTOR: "xenarro",
    GITHUB_REF: "refs/tags/v0.1.0",
    GITHUB_REF_NAME: "v0.1.0",
    GITHUB_WORKFLOW_REF: "xenarro/krun/.github/workflows/release.yml@refs/tags/v0.1.0",
    GITHUB_SHA: commit,
    GITHUB_TOKEN: "unit-fixture-not-a-credential",
  });
  const result = spawnSync(
    process.execPath,
    ["--import", join(work, "boundary.mjs"), join(module, "release-publish.ts")],
    { cwd: root, env, encoding: "utf8" },
  );
  const calls = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { exe: string; args: string[] });
  const mutations = calls.filter((call) => !["git", "tar", "pnpm"].includes(call.exe));
  return { result, calls, mutations, artifacts };
};
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
it("publishes only the two exact verified Python paths after real archive metadata preflight", async () => {
  const { result, calls, artifacts } = await fixture();
  expect(result.status, result.stderr).toBe(0);
  expect(calls.filter((call) => call.exe === "uv")).toEqual([
    {
      exe: "uv",
      args: [
        "publish",
        "--trusted-publishing",
        "always",
        join(artifacts, "krun-0.1.0-py3-none-any.whl"),
        join(artifacts, "krun-0.1.0.tar.gz"),
      ],
    },
  ]);
  expect(calls.filter((call) => call.exe === "tar")).toHaveLength(2);
});
it.each([
  "extra-wheel",
  "extra-sdist",
  "extra-hidden",
  "artifact-directory",
  "artifact-symlink",
  "manifest-symlink",
  "tampered-file",
  "unverified-owner",
  "missing-sdk-repository",
  "missing-cli-repository",
  "wrong-sdk-repository",
  "wrong-cli-repository",
  "wrong-sdk-directory",
  "wrong-cli-directory",
])("rejects %s before any registry mutation", async (change) => {
  const { result, mutations } = await fixture(change);
  expect(result.status).toBe(1);
  expect(mutations).toEqual([]);
});
