import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the finite scheduler scaffold", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/main.js", import.meta.url))],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("scheduler");
  expect(result.stderr).toBe("");
});
