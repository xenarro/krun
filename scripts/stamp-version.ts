import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";

export const releaseFiles = [
  "package.json",
  "apps/gateway/package.json",
  "apps/scheduler/package.json",
  "packages/shared/package.json",
  "packages/cli/package.json",
  "sdk/node/package.json",
  "packages/cli/templates/node/package.json",
  "sdk/python/pyproject.toml",
  "packages/cli/templates/python/pyproject.toml",
  "deploy/helm/krun/Chart.yaml",
] as const;

// The first release and its synthetic PR versions are stable SemVer, which is
// identical in npm, Python/PEP440 and Helm. Do not silently coerce another form.
export const releaseVersion = (value: string) => {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid stable release version");
  return value.startsWith("v") ? value.slice(1) : value;
};
const manifest = z.object({ name: z.string(), version: z.string() }).passthrough();
const chartSchema = z.object({
  name: z.literal("krun"),
  version: z.string(),
  appVersion: z.string(),
});

export const stampVersion = async (root: string, value: string) => {
  const version = releaseVersion(value);
  const changes: { name: string; text: string }[] = [];
  for (const name of releaseFiles) {
    const text = await readFile(join(root, name), "utf8");
    let next: string;
    if (name.endsWith("package.json")) {
      const data = manifest.parse(JSON.parse(text));
      data.version = version;
      if (name === "packages/cli/templates/node/package.json")
        data.dependencies = { "@krun/sdk": `^${version}` };
      next = `${JSON.stringify(data, null, 2)}\n`;
    } else if (name.endsWith("pyproject.toml")) {
      if ([...text.matchAll(/^version = "[^"]*"$/gm)].length !== 1)
        throw new Error("Invalid Python project version inventory");
      next = text.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
      if (name === "packages/cli/templates/python/pyproject.toml") {
        if (!/^dependencies = \["krun~=[^"]*"\]$/m.test(next))
          throw new Error("Invalid Python template SDK dependency");
        next = next.replace(
          /^dependencies = \["krun~=[^"]*"\]$/m,
          `dependencies = ["krun~=${version}"]`,
        );
      }
    } else {
      const doc = parseDocument(text);
      if (doc.errors.length) throw new Error("Invalid chart version inventory");
      chartSchema.parse(doc.toJS());
      doc.set("version", version);
      doc.set("appVersion", version);
      next = String(doc);
    }
    changes.push({ name, text: next });
  }
  for (const change of changes) await writeFile(join(root, change.name), change.text);
  return version;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected one release version");
    const version = await stampVersion(
      fileURLToPath(new URL("../", import.meta.url)),
      process.argv[2] ?? "",
    );
    console.log(JSON.stringify({ event: "release_stamped", version, files: releaseFiles.length }));
  } catch {
    console.error("Release version stamp failed");
    process.exitCode = 1;
  }
}
