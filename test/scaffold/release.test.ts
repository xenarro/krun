import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { releaseFiles, releaseVersion, stampVersion } from "../../scripts/stamp-version.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const fixture = async () => {
  const path = await mkdtemp(join(tmpdir(), "krun-test-release-"));
  directories.push(path);
  for (const name of releaseFiles) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), await readFile(join(root, name)));
  }
  return path;
};
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it.each(["v0.1.0", "v1.2.3", "0.0.97"])("normalizes a stable release version %s", (value) => {
  expect(releaseVersion(value)).toBe(value.replace(/^v/, ""));
});
it.each(["", "v1.2", "v01.2.3", "1.2.3\n", " v1.2.3", "1.2.3/other", "v1.2.3;false"])(
  "rejects malformed release version without echoing it",
  (value) => {
    expect(() => releaseVersion(value)).toThrow("Invalid stable release version");
  },
);
it("stamps all workspace, Python, template and chart versions consistently and idempotently", async () => {
  const path = await fixture();
  await stampVersion(path, "v0.1.0");
  const first = await Promise.all(releaseFiles.map((name) => readFile(join(path, name), "utf8")));
  await stampVersion(path, "v0.1.0");
  expect(await Promise.all(releaseFiles.map((name) => readFile(join(path, name), "utf8")))).toEqual(
    first,
  );
  for (const name of releaseFiles.filter((name) => name.endsWith("package.json"))) {
    const data = JSON.parse(await readFile(join(path, name), "utf8"));
    expect(data.version).toBe("0.1.0");
    expect(data.private).toBe(true);
  }
  const chart = parse(await readFile(join(path, "deploy/helm/krun/Chart.yaml"), "utf8"));
  expect(chart.version).toBe("0.1.0");
  expect(chart.appVersion).toBe("0.1.0");
  for (const name of releaseFiles.filter((name) => name.endsWith("pyproject.toml"))) {
    expect(await readFile(join(path, name), "utf8")).toContain('version = "0.1.0"');
  }
  const node = JSON.parse(
    await readFile(join(path, "packages/cli/templates/node/package.json"), "utf8"),
  );
  expect(node.dependencies["@krun/sdk"]).toBe("^0.1.0");
  expect(
    await readFile(join(path, "packages/cli/templates/python/pyproject.toml"), "utf8"),
  ).toContain('"krun~=0.1.0"');
});
it("validates the complete stamp inventory before modifying any source", async () => {
  const path = await fixture();
  const before = await readFile(join(path, "package.json"), "utf8");
  await writeFile(join(path, "deploy/helm/krun/Chart.yaml"), "invalid: [");
  await expect(stampVersion(path, "v0.1.0")).rejects.toThrow();
  expect(await readFile(join(path, "package.json"), "utf8")).toBe(before);
});
