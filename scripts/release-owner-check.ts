import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { releaseVersion } from "./stamp-version.ts";

const ownershipSchema = z.strictObject({
  repository: z.literal("xenarro/krun"),
  workflow: z.literal("release.yml"),
  environment: z.literal("release"),
  npmPackages: z.tuple([z.literal("@krun/sdk"), z.literal("@krun/cli")]),
  pypiProject: z.literal("krun"),
  image: z.literal("ghcr.io/xenarro/krun"),
  chart: z.literal("oci://ghcr.io/xenarro/charts/krun"),
  verifiedByOwner: z.literal(true),
  evidence: z.array(z.string().url()).min(1),
});
export const assertReleaseOwnership = (value: unknown, env: NodeJS.ProcessEnv) => {
  const ownership = ownershipSchema.parse(value);
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REPOSITORY !== ownership.repository ||
    env.GITHUB_ACTOR !== "xenarro"
  )
    throw new Error("Release requires the trusted repository tag event");
  const tag = env.GITHUB_REF?.slice("refs/tags/".length) ?? "";
  if (!env.GITHUB_REF?.startsWith("refs/tags/v")) throw new Error("Release requires an owner tag");
  releaseVersion(tag);
  if (env.GITHUB_REF_NAME !== tag) throw new Error("Release tag identity mismatch");
  if (env.GITHUB_WORKFLOW_REF !== `xenarro/krun/.github/workflows/release.yml@refs/tags/${tag}`)
    throw new Error("Unexpected release workflow identity");
  return ownership;
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertReleaseOwnership(
      JSON.parse(await readFile(new URL("../release-ownership.json", import.meta.url), "utf8")),
      process.env,
    );
    console.log("Owner-verified release bindings accepted");
  } catch {
    console.error(
      "BLOCKED: owner registry grants and exact trusted-publisher bindings are unverified",
    );
    process.exitCode = 1;
  }
}
