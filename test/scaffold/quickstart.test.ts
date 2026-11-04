import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quickstartSettings, quickstartValues } from "../../scripts/quickstart-config.ts";

describe("disposable README quickstart", () => {
  it("rejects credential-bearing chart references before argv or summary construction", () => {
    for (const scheme of ["https", "http", "oci"]) {
      const url = new URL(`${scheme}://charts.example/krun.tgz`);
      url.username = "krun-test-private-user";
      url.password = "krun-test-private-marker";
      expect(() => quickstartSettings("embedded", { KRUN_CHART: url.href })).toThrow();
    }
  });
  it.each([
    "./charts/team@0.1",
    "https://charts.example/krun.tgz",
    "http://127.0.0.1:8088/krun.tgz",
    "oci://ghcr.io/xenarro/charts/krun",
  ])("keeps credential-free chart reference %s", (chart) => {
    expect(quickstartSettings("embedded", { KRUN_CHART: chart }).chart).toBe(chart);
  });
  it.each([
    "https://charts.example/krun.tgz?signature=krun-test-marker",
    "https://charts.example/krun.tgz#krun-test-marker",
  ])("does not expose opaque URL query or fragment authentication", (chart) => {
    expect(() => quickstartSettings("embedded", { KRUN_CHART: chart })).toThrow();
  });
  it("describes cancellation and active-deadline token revocation, not terminal-only lifetime", () => {
    const contract =
      readFileSync(new URL("../../README.md", import.meta.url), "utf8")
        .split("## Function container contract")[1]
        ?.split("## Public API summary")[0] ?? "";
    expect(contract).toContain("CANCELLING");
    expect(contract).toContain("active-deadline");
  });
  it("retains the exact documented published defaults without claiming publication", () => {
    const config = quickstartSettings("embedded", {});
    expect(config.chart).toBe("oci://ghcr.io/xenarro/charts/krun");
    expect(config.cli).toEqual(["npx", "@krun/cli"]);
    expect(config.image).toBeUndefined();
    expect(config.vendor).toBeUndefined();
    expect(config.registry).toBe("localhost:5001");
  });
  it("reads every local acceptance override without shell evaluation", () => {
    const config = quickstartSettings("postgres", {
      KRUN_CHART: "./deploy/helm/krun",
      KRUN_IMAGE: "localhost:5001/krun:e2e",
      KRUN_CLI: "node /checkout/packages/cli/dist/main.js",
      KRUN_SDK_VENDOR: "/private/packed-sdks",
      KRUN_REGISTRY: "localhost:5001",
    });
    expect(config.cli).toEqual(["node", "/checkout/packages/cli/dist/main.js"]);
    expect(config.image).toEqual({ repository: "localhost:5001/krun", tag: "e2e" });
    expect(config.chart).toBe("./deploy/helm/krun");
    expect(config.vendor).toBe("/private/packed-sdks");
  });
  it.each(["", "production", "postgres --debug"])("rejects mode %s", (mode) => {
    expect(() => quickstartSettings(mode, {})).toThrow();
  });
  it.each([
    "krun",
    "krun:",
    "user:secret@registry/krun:tag",
    "registry/krun@sha256:abc",
    "registry/krun:a:b",
    "UPPER/krun:tag",
    "/krun:tag",
    "krun:-tag",
    "krun:tag/tag",
  ])("requires the specified repository:tag image format: %s", (image) =>
    expect(() => quickstartSettings("embedded", { KRUN_IMAGE: image })).toThrow(),
  );
  it.each(["node cli; echo unsafe", "$(command)", "node 'quoted path'", "node\ncli"])(
    "refuses shell interpretation in CLI override: %s",
    (cli) => expect(() => quickstartSettings("embedded", { KRUN_CLI: cli })).toThrow(),
  );
  it.each(["--kubeconfig=foreign", "chart\n--debug", "chart\t--debug"])(
    "refuses chart option injection: %s",
    (chart) => {
      expect(() => quickstartSettings("embedded", { KRUN_CHART: chart })).toThrow();
    },
  );
  it("never publishes demo Functions to a remote registry", () => {
    expect(() => quickstartSettings("embedded", { KRUN_REGISTRY: "ghcr.io/other" })).toThrow();
  });
  it.each(["embedded", "postgres"])("keeps isolation and real mode selection: %s", (mode) => {
    const values = quickstartValues(
      quickstartSettings(mode, { KRUN_IMAGE: "localhost:5001/krun:e2e" }),
    );
    expect(values.db.mode).toBe(mode);
    expect(values.apiKeys.existingSecret).toBe("krun-test-quickstart-keys");
    expect(values.crds).toEqual({ install: true, keep: false });
    expect(values.jobsNamespace).toEqual({
      name: `krun-test-quickstart-${mode}-jobs`,
      keep: false,
    });
    expect(values.config.allowedRegistries).toBe("localhost:5001");
    expect(values).not.toHaveProperty("objectStorage");
    expect(JSON.stringify(values)).not.toMatch(/password|dsn|keys\.yaml/);
  });
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
describe("README rehearsal boundaries", () => {
  it("uses the installed Helm 4 list interface, not the removed all-status flag", () => {
    expect(read("scripts/quickstart.ts")).not.toContain('["list", "-a",');
  });
  it.each([[], ["production"], ["embedded", "extra"]])(
    "rejects invalid wrapper argv before cluster access: %j",
    (...args) => {
      const result = spawnSync("sh", [join(root, "scripts/quickstart.sh"), ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Usage: scripts/quickstart.sh embedded|postgres\n");
      expect(result.stdout).toBe("");
    },
  );
  it("never falls back to an ambient context or prints inherited API material without owned state", () => {
    const work = mkdtempSync(join(tmpdir(), "krun-test-quickstart-guard-"));
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
        ),
      );
      const marker = "krun-test-quickstart-private-canary";
      const result = spawnSync("sh", [join(root, "scripts/quickstart.sh"), "embedded"], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...env,
          TMPDIR: work,
          KUBECONFIG: join(work, "ambient-production"),
          KRUN_API_KEY: marker,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Quickstart failed during owned-foundation; private output withheld\n",
      );
      expect(result.stderr).not.toContain(marker);
    } finally {
      rmSync(work, { recursive: true });
    }
  });
  it("documents every requested entrypoint and refuses an estimated qualification table", () => {
    const readme = read("README.md");
    for (const text of [
      "## When not to use krun",
      "## Platform-team onboarding",
      "krun-function-author",
      "krun-job-viewer",
      "## Function container contract",
      "## Public API summary",
      "docs/API.md",
      "docs/OPERATIONS.md",
      "scripts/quickstart.sh postgres",
      "make e2e-quickstart",
      "KRUN_SDK_VENDOR",
      "KRUN_CLI",
      "KRUN_CHART",
      "KRUN_IMAGE",
      "KRUN_REGISTRY",
    ])
      expect(readme).toContain(text);
    const timings =
      readme.split("### Measured quickstart durations")[1]?.split("## Golden path")[0] ?? "";
    expect(timings).not.toContain("Qualification is in progress");
    for (const mode of ["embedded", "postgres"])
      expect(timings).toMatch(new RegExp(`\\| ${mode} \\| [0-9]+\\.[0-9]+ \\|`));
  });
  it("keeps the existing native suite allowances and gives each fresh mode its own fixed budget", () => {
    expect(read("test/e2e/vitest.config.ts")).toContain("testTimeout: 600_000");
    expect(read("test/e2e/vitest.config.ts")).toContain("retry: 1");
    expect(read("Makefile")).toContain('timeout 1800s node test/e2e/quickstart.ts "$$mode"');
    expect(read(".github/workflows/quickstart.yml")).toContain("timeout-minutes: 30");
    expect(read(".github/workflows/quickstart.yml")).toContain("if: always()");
  });
});
