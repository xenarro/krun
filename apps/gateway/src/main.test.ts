import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
it("gateway help stays finite without configuration or acquired resources", () => {
  const result = spawnSync(process.execPath, [entry, "--help"], {
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Usage: krun gateway [--help]");
  expect(result.stderr).toBe("");
});
it("gateway rejects unknown flags without echoing supplied values", () => {
  const privateArgument = randomBytes(32).toString("hex");
  const result = spawnSync(process.execPath, [entry, "--unknown", privateArgument], {
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: krun gateway");
  expect((result.stdout + result.stderr).includes(privateArgument)).toBe(false);
});
it("gateway configuration failure names the first variable but never its value or another secret", () => {
  const secret = randomBytes(32).toString("hex");
  const result = spawnSync(process.execPath, [entry], {
    env: { KRUN_NAMESPACE: "krun-test-p37", KRUN_DB_DSN: secret, KRUN_MAX_INPUT_BYTES: "1048577" },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("KRUN_MAX_INPUT_BYTES");
  expect((result.stdout + result.stderr).includes(secret)).toBe(false);
});
