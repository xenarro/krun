import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertArtifactInventory, assertNodeRepository } from "./release-artifacts.ts";
import { assertReleaseOwnership } from "./release-owner-check.ts";
import { releaseVersion } from "./stamp-version.ts";

const artifactSchema = z.strictObject({
  version: z.string(),
  targetVersion: z.literal("0.1.0"),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(z.string().regex(/^[a-zA-Z0-9_.+-]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
  image: z.string().regex(/^krun-test-release:[0-9]+\.[0-9]+\.[0-9]+$/),
  sourceDirty: z.literal(false),
  published: z.literal(false),
  sourceCheckoutUnmodified: z.literal(true),
  nodeFormats: z.tuple([z.literal("esm"), z.literal("commonjs")]),
  installedCli: z.literal(true),
  installedPythonSdk: z.literal(true),
  strictExports: z.literal(true),
  changedStampFiles: z.array(z.string()),
});
const root = fileURLToPath(new URL("../", import.meta.url));
const command = (exe: string, args: string[], input?: string) => {
  const r = spawnSync(exe, args, {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error("Release operation failed");
  return `${r.stdout}\n${r.stderr}`;
};
const digest = (text: string) => {
  const values = [...text.matchAll(/\bdigest:\s*(sha256:[a-f0-9]{64})\b/gi)].map((x) => x[1]);
  const unique = [...new Set(values)];
  if (unique.length !== 1 || !unique[0])
    throw new Error("Missing unambiguous pushed artifact digest");
  return unique[0];
};
try {
  const ownership = assertReleaseOwnership(
    JSON.parse(await readFile(join(root, "release-ownership.json"), "utf8")),
    process.env,
  );
  if (
    ["NPM_TOKEN", "NODE_AUTH_TOKEN", "UV_PUBLISH_TOKEN", "UV_PUBLISH_PASSWORD"].some(
      (name) => process.env[name],
    )
  )
    throw new Error("Long-lived registry credential fallback is forbidden");
  const tag = process.env.GITHUB_REF_NAME ?? "";
  const version = releaseVersion(tag);
  const commit = process.env.GITHUB_SHA ?? "";
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid release source identity");
  command("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
  const directory = process.env.RELEASE_ARTIFACT_DIRECTORY;
  if (!directory) throw new Error("Release artifacts are required");
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Invalid release artifact directory");
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    !entries.some((entry) => entry.name === "manifest.json") ||
    entries.some((entry) => !entry.isFile())
  )
    throw new Error("Release artifacts must be regular files");
  assertArtifactInventory(
    entries.filter((entry) => entry.name !== "manifest.json").map((entry) => entry.name),
    version,
  );
  const artifacts = artifactSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (
    artifacts.version !== artifacts.targetVersion ||
    artifacts.version !== version ||
    artifacts.commit !== commit ||
    artifacts.image !== `krun-test-release:${version}`
  )
    throw new Error("Release artifact/source identity mismatch");
  assertArtifactInventory(Object.keys(artifacts.files), version);
  for (const [name, expected] of Object.entries(artifacts.files)) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(join(directory, name))) hash.update(bytes);
    if (hash.digest("hex") !== expected) throw new Error("Release artifact integrity mismatch");
  }
  const sdk = join(directory, `krun-sdk-${version}.tgz`);
  const cli = join(directory, `krun-cli-${version}.tgz`);
  // Revalidate the exact tarballs before any registry write, not a rebuilt tree.
  for (const [name, path] of [
    ["@krun/sdk", sdk],
    ["@krun/cli", cli],
  ] as const) {
    assertNodeRepository(JSON.parse(command("tar", ["-xOf", path, "package/package.json"])), name);
    command("pnpm", ["run", "release:lint", path]);
    command("pnpm", ["run", "release:types", path]);
  }
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const marker = `## [${version}]`;
  const start = changelog.indexOf(marker);
  if (start < 0) throw new Error("Missing release changelog");
  const notes = changelog.slice(start).split(/\n## /)[0] ?? "";
  const notesFile = join(directory, "release-notes.md");
  await writeFile(notesFile, notes);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Repository-scoped GHCR authentication is required");
  command("docker", ["login", "ghcr.io", "--username", "xenarro", "--password-stdin"], token);
  command(
    "helm",
    ["registry", "login", "ghcr.io", "--username", "xenarro", "--password-stdin"],
    token,
  );
  command("docker", ["load", "--input", join(directory, "image.tar")]);
  command("docker", ["tag", artifacts.image, `${ownership.image}:${version}`]);
  const imageDigest = digest(command("docker", ["push", `${ownership.image}:${version}`]));
  const image = `${ownership.image}@${imageDigest}`;
  const identity = `https://github.com/xenarro/krun/.github/workflows/release.yml@refs/tags/${tag}`;
  const verify = [
    "--certificate-identity",
    identity,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
  ];
  command("cosign", ["sign", "--yes", image]);
  const sbom = join(directory, "sbom.spdx.json");
  command(process.env.SYFT_COMMAND ?? "syft", [image, "-o", `spdx-json=${sbom}`]);
  command("cosign", ["attest", "--yes", "--type", "spdxjson", "--predicate", sbom, image]);
  command("cosign", ["verify", ...verify, image]);
  command("cosign", ["verify-attestation", ...verify, "--type", "spdxjson", image]);
  const chartDigest = digest(
    command("helm", [
      "push",
      join(directory, `krun-${version}.tgz`),
      "oci://ghcr.io/xenarro/charts",
    ]),
  );
  const chart = `ghcr.io/xenarro/charts/krun@${chartDigest}`;
  command("cosign", ["sign", "--yes", chart]);
  const chartSbom = join(directory, "chart-sbom.spdx.json");
  command(process.env.SYFT_COMMAND ?? "syft", [
    `file:${join(directory, `krun-${version}.tgz`)}`,
    "-o",
    `spdx-json=${chartSbom}`,
  ]);
  command("cosign", ["attest", "--yes", "--type", "spdxjson", "--predicate", chartSbom, chart]);
  command("cosign", ["verify", ...verify, chart]);
  command("cosign", ["verify-attestation", ...verify, "--type", "spdxjson", chart]);
  for (const path of [sdk, cli])
    command("npm", ["publish", path, "--provenance", "--access", "public"]);
  command("uv", [
    "publish",
    "--trusted-publishing",
    "always",
    join(directory, `krun-${version}-py3-none-any.whl`),
    join(directory, `krun-${version}.tar.gz`),
  ]);
  command("gh", [
    "release",
    "create",
    tag,
    "--repo",
    "xenarro/krun",
    "--verify-tag",
    "--title",
    tag,
    "--notes-file",
    notesFile,
    sbom,
    join(directory, "manifest.json"),
  ]);
  console.log(JSON.stringify({ event: "release_published", version, commit, image, chart }));
} catch {
  console.error("Release blocked or failed; no successful publication is claimed");
  process.exitCode = 1;
}
