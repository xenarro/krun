import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { releaseVersion } from "./stamp-version.ts";

export const assertArtifactInventory = (names: string[], value: string) => {
  const version = releaseVersion(value);
  const expected = [
    "image.tar",
    `krun-sdk-${version}.tgz`,
    `krun-cli-${version}.tgz`,
    `krun-${version}.tgz`,
    `krun-${version}-py3-none-any.whl`,
    `krun-${version}.tar.gz`,
  ];
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected.sort()))
    throw new Error("Incomplete or unexpected release artifact inventory");
};

export const assertNodeRepository = (value: unknown, name: "@krun/sdk" | "@krun/cli") => {
  z.object({
    name: z.literal(name),
    repository: z.strictObject({
      type: z.literal("git"),
      url: z.literal("git+https://github.com/xenarro/krun.git"),
      directory: z.literal(name === "@krun/sdk" ? "sdk/node" : "packages/cli"),
    }),
  }).parse(value);
};

const packageSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    dependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const readPackage = async (path: string) =>
  packageSchema.parse(JSON.parse(await readFile(path, "utf8")));

export const prepareNodeArtifacts = async (root: string, output: string) => {
  // Never adopt or overwrite an existing output directory.
  await mkdir(output);
  const sdkDirectory = join(output, "sdk");
  const cliDirectory = join(output, "cli");
  await mkdir(sdkDirectory);
  await mkdir(cliDirectory);
  const sdk = await readPackage(join(root, "sdk/node/package.json"));
  const cli = await readPackage(join(root, "packages/cli/package.json"));
  const shared = await readPackage(join(root, "packages/shared/package.json"));
  assertNodeRepository(sdk, "@krun/sdk");
  assertNodeRepository(cli, "@krun/cli");
  if (sdk.name !== "@krun/sdk" || cli.name !== "@krun/cli" || shared.name !== "@krun/shared")
    throw new Error("Unexpected release package identity");
  if (sdk.version !== cli.version || sdk.version !== shared.version)
    throw new Error("Inconsistent release package versions");
  const dependencies = { ...shared.dependencies, ...cli.dependencies };
  delete dependencies["@krun/shared"];
  if (Object.values(dependencies).some((value) => /^(?:workspace|file|link):/.test(value)))
    throw new Error("Unresolved private release dependency");
  if (sdk.dependencies && Object.keys(sdk.dependencies).length)
    throw new Error("SDK release must remain dependency-free");
  await cp(join(root, "sdk/node/dist"), join(sdkDirectory, "dist"), { recursive: true });
  await cp(join(root, "packages/cli/dist"), join(cliDirectory, "dist"), { recursive: true });
  await cp(join(root, "packages/cli/templates"), join(cliDirectory, "templates"), {
    recursive: true,
  });
  await mkdir(join(cliDirectory, "vendor"));
  await cp(join(root, "packages/shared/dist"), join(cliDirectory, "vendor/shared"), {
    recursive: true,
  });
  const privatePackages = new Map<string, { directory: string; main: string }>();
  for (const name of ["ajv", "ajv-formats"]) {
    const source = await realpath(join(root, "packages/shared/node_modules", name));
    const data = await readPackage(join(source, "package.json"));
    const directory = join(cliDirectory, "vendor", name);
    await cp(source, directory, { recursive: true });
    privatePackages.set(name, { directory, main: z.string().parse(data.main) });
    Object.assign(dependencies, data.dependencies);
    delete dependencies[name];
  }
  // These are the same frozen, patched Ajv bytes as the application, not a
  // fresh registry resolution that could lose D48's prototype-key validation.
  delete dependencies.ajv;
  delete dependencies["ajv-formats"];
  const rewrite = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await rewrite(path);
      else if (entry.isSymbolicLink()) throw new Error("Symlink in release implementation");
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) {
        const text = await readFile(path, "utf8");
        let next = text.replace(
          /(["'])@krun\/shared\/dist\/([a-zA-Z0-9_./-]+)\1/g,
          (_all, quote, subpath: string) => {
            const target = join(cliDirectory, "vendor/shared", subpath);
            if (subpath.split("/").includes(".."))
              throw new Error("Invalid shared artifact import");
            let specifier = relative(dirname(path), target).split(sep).join("/");
            if (!specifier.startsWith(".")) specifier = `./${specifier}`;
            return `${quote}${specifier}${quote}`;
          },
        );
        next = next.replace(
          /((?:from\s+|require\(\s*|import\(\s*))(["'])(ajv(?:-formats)?)(\/[a-zA-Z0-9_./-]+)?\2/g,
          (_all, prefix: string, quote: string, name: string, subpath: string | undefined) => {
            const target = privatePackages.get(name);
            if (!target || subpath?.split("/").includes(".."))
              throw new Error("Invalid validator artifact import");
            let specifier = relative(
              dirname(path),
              join(target.directory, subpath?.slice(1) ?? target.main),
            )
              .split(sep)
              .join("/");
            if (!specifier.startsWith(".")) specifier = `./${specifier}`;
            return `${prefix}${quote}${specifier}${quote}`;
          },
        );
        if (next.includes("@krun/shared")) throw new Error("Unresolved shared artifact import");
        if (next !== text) await writeFile(path, next);
      }
    }
  };
  await rewrite(join(cliDirectory, "dist"));
  await rewrite(join(cliDirectory, "vendor"));
  for (const [directory, data] of [
    [sdkDirectory, sdk],
    [cliDirectory, cli],
  ] as const) {
    const published: Record<string, unknown> = { ...data, private: false };
    delete published.scripts;
    delete published.devDependencies;
    if (data.name === "@krun/cli") {
      published.dependencies = dependencies;
      published.files = ["dist", "templates", "vendor"];
    }
    await writeFile(join(directory, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    await cp(
      join(root, data.name === "@krun/sdk" ? "sdk/node/README.md" : "README.md"),
      join(directory, "README.md"),
    );
  }
  return { sdkDirectory, cliDirectory };
};
