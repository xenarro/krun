import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  functionResourceSchema,
  functionSpecSchema,
} from "../../../packages/shared/src/functions/schema.ts";
import { parsePushDigest } from "./contracts.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const imageSchema = z
  .string()
  .regex(/^localhost:5001\/krun-test-e2e-sdk-(?:node|python)@sha256:[a-f0-9]{64}$/);
const deployedFunctionSchema = functionResourceSchema.extend({
  spec: functionSpecSchema.extend({ image: imageSchema }),
});
export const sdkFunctionsSchema = z.strictObject({
  node: deployedFunctionSchema,
  python: deployedFunctionSchema,
});
const starterSchema = functionResourceSchema.extend({
  spec: functionSpecSchema.extend({ image: z.literal("REPLACE_WITH_DIGEST") }),
});

export const renderSdkFunction = (text: string, image: string) => {
  const starter = starterSchema.parse(parse(text));
  return deployedFunctionSchema.parse({
    ...starter,
    spec: {
      ...starter.spec,
      image,
      inputSchema: { type: "object" },
      heartbeatTimeout: "30s",
      activeDeadlineSeconds: 120,
    },
  });
};

// Called only after cluster.ts has positively verified ownership of the registry.
// Commands keep their captured output private, including package-manager errors.
export const buildSdkFunctions = async (privateDir: string) => {
  const work = await mkdtemp(join(privateDir, "sdk-projects-"));
  const command = (exe: string, args: string[], label: string, cwd = root) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("KRUN_") &&
          !["NODE_OPTIONS", "PYTHONPATH", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"].includes(key),
      ),
    );
    const result = spawnSync(exe, args, {
      cwd,
      env: { ...env, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(`${label} failed (private output withheld)`);
    return result.stdout;
  };
  const build = async (language: "node" | "python") => {
    const name = `krun-test-sdk-${language}`;
    const project = join(work, name);
    command(
      process.execPath,
      [join(root, "packages/cli/dist/main.js"), "init", "--lang", language, name],
      `${language} template generation`,
      work,
    );
    const vendor = join(project, "vendor");
    await mkdir(vendor);
    if (language === "node") {
      command("pnpm", ["--dir", "sdk/node", "pack", "--pack-destination", vendor], "Node SDK pack");
      const archives = (await readdir(vendor)).filter((path) => path.endsWith(".tgz"));
      if (archives.length !== 1) throw new Error("Expected exactly one current Node SDK archive");
      command(
        "npm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          `./vendor/${archives[0]}`,
        ],
        "Vendored Node SDK install",
        project,
      );
    } else {
      command("uv", ["build", "sdk/python", "--out-dir", vendor], "Python SDK build");
      const wheels = (await readdir(vendor)).filter((path) => path.endsWith(".whl"));
      if (wheels.length !== 1) throw new Error("Expected exactly one current Python SDK wheel");
      command(
        "uv",
        ["add", "--python", "3.13", `./vendor/${wheels[0]}`],
        "Vendored Python SDK install",
        project,
      );
    }
    const handler = language === "node" ? "handler.js" : "handler.py";
    await copyFile(
      join(root, "test/e2e/functions", `sdk-${language}.${language === "node" ? "js" : "py"}`),
      join(project, handler),
    );
    if (language === "node") command("npm", ["test"], "Generated Node project tests", project);
    else
      command(
        "uv",
        ["run", "--locked", "--python", "3.13", "python", "-m", "pytest"],
        "Generated Python project tests",
        project,
      );
    const tag = `localhost:5001/krun-test-e2e-sdk-${language}:e2e`;
    command(
      "docker",
      ["build", "--network=none", "--tag", tag, project],
      `${language} template image build`,
    );
    const digest = parsePushDigest(
      command("docker", ["push", tag], `${language} local image push`),
    );
    const resource = renderSdkFunction(
      await readFile(join(project, "function.yaml"), "utf8"),
      `${tag.slice(0, -4)}@${digest}`,
    );
    await writeFile(join(project, "function.yaml"), stringify(resource));
    command(
      process.execPath,
      [join(root, "packages/cli/dist/main.js"), "validate", join(project, "function.yaml")],
      `${language} generated Function validation`,
    );
    console.log(
      JSON.stringify({
        event: "sdk_template_acceptance",
        language,
        generatedProjectTests: true,
        vendoredSdk: true,
        imageBuildNetworkNone: true,
        image: resource.spec.image,
      }),
    );
    return resource;
  };
  return sdkFunctionsSchema.parse({ node: await build("node"), python: await build("python") });
};
