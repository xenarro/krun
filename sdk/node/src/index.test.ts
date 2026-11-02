import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the SDK dependency-free and exposes only the documented run entrypoint", async () => {
  expect(Object.keys(await import("./index.js"))).toEqual(["run"]);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.engines.node).toBe(">=22");
});
