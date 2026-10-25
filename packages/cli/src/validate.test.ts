import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("offers real validate help without production configuration", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/validate.js", import.meta.url)), "--help"],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Usage: krun validate [--help] <path>...");
  expect(result.stderr).toBe("");
});
