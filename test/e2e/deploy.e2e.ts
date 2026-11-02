import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { functionResourceSchema } from "../../packages/shared/src/functions/schema.js";
import { chartLayout, databaseMode } from "./lib/chart.js";
import { assertRegistryOwner, contextArgs } from "./lib/contracts.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const privateDir = join(tmpdir(), `krun-test-e2e-${owner}`);
const kubeconfig = join(privateDir, "kubeconfig");
const projectsSchema = z.strictObject({ node: z.string(), python: z.string() });
const stateSchema = z.object({ owner: z.literal(owner), mode: databaseMode });
const command = (exe: string, args: string[], env?: NodeJS.ProcessEnv, cwd = root) => {
  const result = spawnSync(exe, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error("Owned deploy acceptance command failed (private output withheld)");
  return result;
};
const kube = (args: string[]) => command("kubectl", [...contextArgs(kubeconfig), ...args]).stdout;

for (const language of ["node", "python"] as const)
  it(`deploys the actual vendored ${language} project and proves no-apply leaves the cluster untouched`, async () => {
    const state = stateSchema.parse(
      JSON.parse(await readFile(join(privateDir, "state.json"), "utf8")),
    );
    const layout = chartLayout(state.mode);
    const config = z
      .object({
        "current-context": z.literal("kind-krun-test-e2e"),
        clusters: z.array(z.object({ cluster: z.object({ server: z.url() }) })).length(1),
      })
      .parse(parse(await readFile(kubeconfig, "utf8")));
    expect(new URL(config.clusters[0]?.cluster.server ?? "").hostname).toMatch(
      /^(127\.0\.0\.1|localhost)$/,
    );
    assertRegistryOwner(
      JSON.parse(command("docker", ["inspect", "kind-registry"]).stdout)[0],
      owner,
    );
    const projects = projectsSchema.parse(
      JSON.parse(await readFile(join(privateDir, "sdk-projects.json"), "utf8")),
    );
    const project = resolve(projects[language]);
    expect(project.startsWith(`${privateDir}/sdk-projects-`)).toBe(true);
    const name = `krun-test-deploy-${language}-${state.mode}`;
    const file = join(project, "function.yaml");
    const document = parseDocument(await readFile(file, "utf8"));
    document.setIn(["metadata", "name"], name);
    document.setIn(["spec", "image"], "REPLACE_WITH_DIGEST");
    await writeFile(file, String(document));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
      ),
    );
    const deploymentEnv = {
      ...env,
      KUBECONFIG: kubeconfig,
      KRUN_JOBS_NAMESPACE: layout.jobsNamespace,
      KRUN_GATEWAY_URL: "must-not-select-sdk-mode",
      KRUN_API_KEY: "krun-test-deploy-output-canary",
    };
    const args = [
      join(root, "packages/cli/dist/main.js"),
      "deploy",
      "--registry",
      "localhost:5001",
      "--namespace",
      layout.namespace,
      "--api-url",
      "http://127.0.0.1:8080",
    ];
    const before = JSON.parse(
      kube(["get", "functions.krun.io", "-n", layout.namespace, "-o", "json"]),
    ).items;
    const gitops = command(
      process.execPath,
      [...args, "--no-apply"],
      { ...deploymentEnv, KUBECONFIG: join(privateDir, "krun-test-nonexistent-kubeconfig") },
      project,
    );
    expect(
      JSON.parse(kube(["get", "functions.krun.io", "-n", layout.namespace, "-o", "json"])).items,
    ).toEqual(before);
    const pinned = functionResourceSchema.parse(parse(await readFile(file, "utf8")));
    expect(pinned.spec.image).toMatch(new RegExp(`^localhost:5001/${name}@sha256:[a-f0-9]{64}$`));
    expect(gitops.stdout.trim()).toBe(pinned.spec.image);
    const digest = pinned.spec.image.split("@")[1];
    const manifest = await fetch(`http://127.0.0.1:5001/v2/${name}/manifests/${digest}`, {
      headers: {
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
    });
    expect(manifest.status).toBe(200);
    expect(
      `sha256:${createHash("sha256")
        .update(new Uint8Array(await manifest.arrayBuffer()))
        .digest("hex")}`,
    ).toBe(digest);
    try {
      const deployed = command(process.execPath, args, deploymentEnv, project);
      expect(deployed.stderr).toContain("Ready=True (current generation)");
      expect(
        deployed.stdout.split("\n").filter((line) => /^(curl|kubectl) /.test(line)),
      ).toHaveLength(3);
      expect(deployed.stdout).toContain(`http://127.0.0.1:8080/v1/functions/${name}/runs`);
      expect(deployed.stdout).toContain("$KRUN_API_KEY");
      expect(deployed.stdout).toContain(
        `kubectl logs -f -n '${layout.jobsNamespace}' 'job/krun-<id>'`,
      );
      expect(deployed.stdout).toContain(`/v1/functions/${name}/runs/<id>`);
      expect(deployed.stdout).toContain("logTail");
      expect(`${gitops.stdout}${gitops.stderr}${deployed.stdout}${deployed.stderr}`).not.toMatch(
        /krun-test-deploy-output-canary|must-not-select-sdk-mode/,
      );
      const live = JSON.parse(
        kube(["get", "functions.krun.io", name, "-n", layout.namespace, "-o", "json"]),
      );
      // Both Dockerfiles copy the manifest into the image. Pinning it may change
      // the next build's digest; verify each successful invocation, not equality
      // between two different build contexts.
      const applied = functionResourceSchema.parse(parse(await readFile(file, "utf8")));
      expect(live.spec.image).toBe(applied.spec.image);
      const appliedDigest = applied.spec.image.split("@")[1];
      const appliedManifest = await fetch(
        `http://127.0.0.1:5001/v2/${name}/manifests/${appliedDigest}`,
        {
          headers: {
            Accept:
              "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
          },
        },
      );
      expect(appliedManifest.status).toBe(200);
      expect(
        `sha256:${createHash("sha256")
          .update(new Uint8Array(await appliedManifest.arrayBuffer()))
          .digest("hex")}`,
      ).toBe(appliedDigest);
      expect(live.status.observedGeneration).toBe(live.metadata.generation);
      expect(live.status.conditions).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "Ready", status: "True" })]),
      );
      console.log(
        JSON.stringify({
          event: "cli_deploy_acceptance",
          language,
          databaseMode: state.mode,
          noApplyClusterUnchanged: true,
          registryDigestReadback: true,
          currentGenerationReady: true,
          printedCommands: 3,
        }),
      );
    } finally {
      kube([
        "delete",
        "functions.krun.io",
        name,
        "-n",
        layout.namespace,
        "--ignore-not-found=true",
        "--wait=true",
      ]);
    }
  });
