import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the SDK scaffold dependency-free without inventing a runtime API", async () => {
  expect(Object.keys(await import("./index.js"))).toEqual([]);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.engines.node).toBe(">=22");
});
