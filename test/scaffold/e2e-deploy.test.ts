import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("native deploy digest readback negotiates index and single-manifest media types", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../e2e/deploy.e2e.ts", import.meta.url)),
    "utf8",
  );
  for (const type of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ])
    expect(source).toContain(type);
  expect(source).toContain("noApplyClusterUnchanged: true");
  expect(source).toContain("registryDigestReadback: true");
  expect(source).toContain("currentGenerationReady: true");
  const api = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../docs/api/openapi-public.json", import.meta.url)),
      "utf8",
    ),
  );
  expect(api.paths["/v1/functions/{function}/runs/{run}"].get.operationId).toBe("GetRun");
  expect(source).toContain(`/v1/functions/\${name}/runs/<id>`);
});
