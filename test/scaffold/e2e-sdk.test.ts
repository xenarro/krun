import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

it("builds current packages before the owned kind foundation prepares real SDK templates", () => {
  expect(read("Makefile")).toContain("kind-up: build");
  expect(read("test/e2e/cluster.ts")).toContain("buildSdkFunctions");
  expect(read("test/e2e/cluster.ts")).toContain("sdkFunctionsSchema");
});

it("packs real local SDKs and runs both generated projects before building and pushing them", () => {
  const source = read("test/e2e/lib/sdk-functions.ts").replace(/\s+/g, " ");
  const cli = JSON.parse(read("packages/cli/package.json"));
  expect(source).toContain(JSON.stringify(`packages/cli/${cli.bin.krun}`));
  for (const part of [
    '"init", "--lang", language',
    '"pack", "--pack-destination"',
    '"build", "sdk/python", "--out-dir"',
    '"npm", ["test"]',
    '"pytest"',
    '"build", "--network=none"',
    '"push", tag',
    "parsePushDigest",
    "sdk_template_acceptance",
  ])
    expect(source).toContain(part);
});

it("pins the actual generated Function and preserves SDK entrypoints without hand-writing their protocol", async () => {
  const { renderSdkFunction } = await import("../e2e/lib/sdk-functions.js");
  for (const language of ["node", "python"] as const) {
    const image = `localhost:5001/krun-test-e2e-sdk-${language}@sha256:${"a".repeat(64)}`;
    const starter = read(`packages/cli/templates/${language}/function.yaml`).replaceAll(
      "__KRUN_NAME__",
      `krun-test-sdk-${language}`,
    );
    const original = parse(starter);
    const resource = renderSdkFunction(starter, image);
    expect(resource.metadata).toEqual(original.metadata);
    expect(resource.spec).toMatchObject({
      image,
      inputSchema: { type: "object" },
      heartbeatTimeout: "30s",
      activeDeadlineSeconds: 120,
    });
    for (const invalid of [
      "repo:tag",
      `remote.example/fixture@sha256:${"a".repeat(64)}`,
      image.slice(0, -1),
    ])
      expect(() => renderSdkFunction(starter, invalid)).toThrow();
    const fixture = read(`test/e2e/functions/sdk-${language}.${language === "node" ? "js" : "py"}`);
    expect(fixture).toContain(language === "node" ? 'from "@krun/sdk"' : "from krun import");
    expect(fixture).toContain("sdk-fixture-error");
    expect(fixture).not.toMatch(/curl|fetch\(|urllib|requests\.|KRUN_RUN_TOKEN|KRUN_GATEWAY_URL/);
  }
});

it("retains positive credential/privacy witnesses for all six SDK cases", () => {
  const harness = read("test/e2e/lib/harness.ts");
  expect(harness).toContain("state.sdkFunctions");
  for (const outcome of ["success", "error", "heartbeat"]) {
    const source = read(`test/e2e/sdk_${outcome}.e2e.ts`);
    expect(source).toContain('["node", "python"]');
    expect(source).toContain("h.privacy()");
    expect(source).toContain("h.close()");
  }
  const slow = read("test/e2e/sdk_heartbeat.e2e.ts");
  expect(slow).toContain("30_000");
  expect(slow).toContain("runtimeStatus?.reportTime");
  expect(slow).toContain("h.jobExists(first)");
  expect(slow).toContain("h.jobExists(alive)");
  expect(slow).not.toContain("h.jobExists(created)");
  expect(read("test/e2e/sdk_error.e2e.ts")).toContain(
    'expect(run.logTail).toContain("handler failed")',
  );
});

it("installs the existing pinned Python build tool in the kind CI job", () => {
  const workflow = parse(read(".github/workflows/ci.yml"));
  const uv = workflow.jobs.kind.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("astral-sh/setup-uv@"),
  );
  expect(uv?.uses).toBe("astral-sh/setup-uv@07a047e608db84b3d8c06cd9a7c7dcc9c355c18e");
  expect(uv?.with.version).toBe("0.13.1");
  expect(uv?.with["python-version"]).toBe("3.13");
});
