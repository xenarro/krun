import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { assertArtifactInventory, prepareNodeArtifacts } from "../../scripts/release-artifacts.ts";
import { assertReleaseOwnership } from "../../scripts/release-owner-check.ts";

it("rejects missing, duplicated or hidden extra release files", () => {
  const names = [
    "image.tar",
    "krun-sdk-0.1.0.tgz",
    "krun-cli-0.1.0.tgz",
    "krun-0.1.0.tgz",
    "krun-0.1.0-py3-none-any.whl",
    "krun-0.1.0.tar.gz",
  ];
  expect(() => assertArtifactInventory(names, "0.1.0")).not.toThrow();
  expect(() => assertArtifactInventory([...names, ".gitignore"], "0.1.0")).toThrow();
  expect(() => assertArtifactInventory(names.slice(1), "0.1.0")).toThrow();
  expect(() => assertArtifactInventory([...names, "image.tar"], "0.1.0")).toThrow();
});
const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
it("prepares standalone packages without publishing shared or losing its patched validator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "krun-test-release-artifacts-"));
  directories.push(dir);
  const result = await prepareNodeArtifacts(root, join(dir, "output"));
  const sdk = JSON.parse(await readFile(join(result.sdkDirectory, "package.json"), "utf8"));
  const cli = JSON.parse(await readFile(join(result.cliDirectory, "package.json"), "utf8"));
  expect(sdk.dependencies).toBeUndefined();
  expect(sdk.private).toBe(false);
  expect(sdk.repository).toEqual({
    type: "git",
    url: "git+https://github.com/xenarro/krun.git",
    directory: "sdk/node",
  });
  expect(cli.repository).toEqual({
    type: "git",
    url: "git+https://github.com/xenarro/krun.git",
    directory: "packages/cli",
  });
  expect(sdk.exports["."].require.types).toBe("./dist/index.d.cts");
  expect(cli.dependencies["@krun/shared"]).toBeUndefined();
  expect(cli.dependencies.ajv).toBeUndefined();
  expect(cli.dependencies["ajv-formats"]).toBeUndefined();
  expect(cli.scripts).toBeUndefined();
  expect(
    await readFile(join(result.cliDirectory, "dist/validate-functions.js"), "utf8"),
  ).not.toContain("@krun/shared");
  const Ajv = createRequire(import.meta.url)(
    join(result.cliDirectory, "vendor/ajv/dist/2020.js"),
  ).default;
  const validate = new Ajv().compile(
    JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}',
    ),
  );
  expect(validate(JSON.parse('{"__proto__":1}'))).toBe(false);
  expect(validate(JSON.parse('{"__proto__":"valid"}'))).toBe(true);
  await expect(prepareNodeArtifacts(root, join(dir, "output"))).rejects.toThrow();
});
it("never treats the checked-in unverified ownership manifest as release authorization", async () => {
  const data = JSON.parse(await readFile(join(root, "release-ownership.json"), "utf8"));
  const env = {
    GITHUB_EVENT_NAME: "push",
    GITHUB_ACTOR: "xenarro",
    GITHUB_REF_NAME: "v0.1.0",
    GITHUB_REPOSITORY: "xenarro/krun",
    GITHUB_REF: "refs/tags/v0.1.0",
    GITHUB_WORKFLOW_REF: "xenarro/krun/.github/workflows/release.yml@refs/tags/v0.1.0",
  };
  expect(() => assertReleaseOwnership(data, env)).toThrow();
  const control = {
    ...data,
    verifiedByOwner: true,
    evidence: ["https://example.test/owner-attestation"],
  };
  expect(assertReleaseOwnership(control, env).repository).toBe("xenarro/krun");
  expect(() =>
    assertReleaseOwnership(control, { ...env, GITHUB_EVENT_NAME: "pull_request" }),
  ).toThrow();
  expect(() =>
    assertReleaseOwnership(control, { ...env, GITHUB_WORKFLOW_REF: "different" }),
  ).toThrow();
  expect(() => assertReleaseOwnership({ ...control, evidence: [] }, env)).toThrow();
});
