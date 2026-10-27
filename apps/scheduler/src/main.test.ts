import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
it("scheduler help is finite without configuration or resources", () => {
  const result = spawnSync(process.execPath, [entry, "--help"], {
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Usage: krun scheduler [--help]");
  expect(result.stderr).toBe("");
});
it("scheduler rejects flags without echoing private arguments", () => {
  const secret = randomBytes(32).toString("hex");
  const result = spawnSync(process.execPath, [entry, "--unknown", secret], {
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: krun scheduler");
  expect(result.stdout + result.stderr).not.toContain(secret);
});
it("scheduler startup names the bad configuration variable without its value", () => {
  const secret = randomBytes(32).toString("hex");
  const result = spawnSync(process.execPath, [entry], {
    env: { KRUN_NAMESPACE: "krun-test-p411", KRUN_DB_DSN: secret, KRUN_RETENTION: secret },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("KRUN_RETENTION");
  expect(result.stdout + result.stderr).not.toContain(secret);
});

it("serving scheduler requires downward API pod identity before resource acquisition", () => {
  const result = spawnSync(process.execPath, [entry], {
    env: {
      KRUN_NAMESPACE: "krun-test-p411",
      KRUN_DB_MODE: "embedded",
      KRUN_DB_PATH: "/does-not-exist/krun-test.db",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("KRUN_POD_NAME");
});
