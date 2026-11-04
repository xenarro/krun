import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cleanupAfterForward, stopForward } from "../../scripts/quickstart-process.ts";
import { acquireFoundationLease } from "../e2e/lib/foundation-lease.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS"),
);

describe("whole-foundation workflow ownership", () => {
  it("blocks participating stock commands and a second driver before inventory; keeps ownership through an early failed up", async () => {
    const work = await mkdtemp(join(tmpdir(), "krun-test-foundation-race-"));
    const lock = join(work, `krun-test-e2e-${owner}.lock`);
    const lease = await acquireFoundationLease(lock);
    try {
      const env = { ...environment, TMPDIR: work, PATH: join(work, "no-external-tools") };
      const blocked = spawnSync(process.execPath, [join(root, "test/e2e/cluster.ts"), "down"], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain("foundation lease");
      const early = spawnSync(process.execPath, [join(root, "test/e2e/cluster.ts"), "up"], {
        env: { ...env, KRUN_TEST_FOUNDATION_LEASE: lease.token },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(early.status).toBe(1);
      expect(early.stderr).toContain("kind version failed");
      await expect(acquireFoundationLease(lock)).rejects.toThrow();
      const borrowed = await acquireFoundationLease(lock, lease.token);
      await borrowed.release();
      await expect(acquireFoundationLease(lock)).rejects.toThrow();
      const marker = join(work, "peer-foundation-marker");
      await writeFile(marker, "peer-owned");
      const driver = spawnSync(
        process.execPath,
        [join(root, "test/e2e/quickstart.ts"), "embedded"],
        { env, encoding: "utf8", timeout: 10_000 },
      );
      expect(driver.status).toBe(1);
      expect(driver.stderr).toContain("foundation lease");
      expect(driver.stdout).not.toContain("clusterRemoved");
      expect(await readFile(marker, "utf8")).toBe("peer-owned");
    } finally {
      await lease.release();
    }
    const next = await acquireFoundationLease(lock);
    await next.release();
    await rm(work, { recursive: true });
  });
  it("never steals a busy lease or releases it for an invalid borrower", async () => {
    const work = await mkdtemp(join(tmpdir(), "krun-test-foundation-borrow-"));
    const lock = join(work, "foundation.lock");
    const lease = await acquireFoundationLease(lock);
    try {
      await expect(acquireFoundationLease(lock, "invalid")).rejects.toThrow();
      await expect(acquireFoundationLease(lock)).rejects.toThrow();
    } finally {
      await lease.release();
      await rm(work, { recursive: true });
    }
  });
});

const child = async () => {
  const process = spawn(
    globalThis.process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(process.stdout, "data");
  return process;
};
describe("joined bounded forward finalization", () => {
  it("kills and joins a real ignored-TERM child", async () => {
    const process = await child();
    try {
      await stopForward(process, 25);
      expect(process.signalCode).toBe("SIGKILL");
    } finally {
      if (process.exitCode === null && process.signalCode === null) {
        const exit = once(process, "exit");
        process.kill("SIGKILL");
        await exit;
      }
    }
  });
  it("handles an already-exited child and a native spawn error", async () => {
    const process = spawn(globalThis.process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(process, "exit");
    await stopForward(process, 25);
    const missing = spawn("/krun-test-definitely-absent-executable", [], { stdio: "ignore" });
    await stopForward(missing, 25);
  });
  it("still invokes resource cleanup if forward shutdown throws", async () => {
    const process = await child();
    const cleanup = vi.fn(async () => {});
    const spy = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw new Error("controlled kill failure");
    });
    try {
      await expect(cleanupAfterForward(process, cleanup)).rejects.toThrow();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      if (process.exitCode === null && process.signalCode === null) {
        const exit = once(process, "exit");
        process.kill("SIGKILL");
        await exit;
      }
    }
  });
});
