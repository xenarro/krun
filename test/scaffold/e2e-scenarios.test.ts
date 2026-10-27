import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
it("requires all five Phase4 scenario files and refuses an empty suite", () => {
  expect(
    readdirSync(`${root}test/e2e`)
      .filter((path) => path.endsWith(".e2e.ts"))
      .sort(),
  ).toEqual([
    "exit_code.e2e.ts",
    "exit_code_status.e2e.ts",
    "heartbeat_timeout.e2e.ts",
    "image_pull_backoff.e2e.ts",
    "success.e2e.ts",
  ]);
  expect(read("test/e2e/vitest.config.ts")).toContain("passWithNoTests: false");
});
it("pins curl fixtures and uses strict shell errors plus contract-specific retries", () => {
  const images = parse(read("test/e2e/images.json"));
  expect(images.curl).toMatch(/^curlimages\/curl:[\d.]+@sha256:[a-f0-9]{64}$/);
  const common = read("test/e2e/functions/common.sh");
  expect(common).toContain("set -eu");
  expect(common).toContain("--fail-with-body");
  expect(common).toContain("--retry 3 --retry-connrefused");
  expect(common.split("status()")[1]).not.toContain("--retry");
  expect(read("test/e2e/functions/success.sh")).toContain("--data-binary @/tmp/input.json");
  expect(read("test/e2e/functions/exit_code_status.sh")).toContain("exit 3");
});
