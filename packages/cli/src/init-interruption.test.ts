import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../../bin/krun.js", import.meta.url));
const roots: string[] = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS"),
);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// Hold the real acquired resource behind an IPC barrier, not a simulated file
// or a sleep. The signal reaches NodeRuntime before the acquisition resolves.
const preload = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const stage = process.argv.at(-1);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.send({ stage: 'interrupted' }));
}
const operation = fs[stage];
fs[stage] = async function(...args) {
  const result = await operation.apply(this, args);
  if ((stage === 'open' && String(args[0]).endsWith('/handler.js')) ||
      (stage === 'mkdir' && String(args[0]).endsWith('/sample'))) {
    process.send({ stage: 'acquired' });
    await new Promise(resolve => process.once('message', resolve));
  }
  return result;
};
syncBuiltinESMExports();
// The test stage is not a CLI argument.
process.argv.pop();
`;

for (const stage of ["open", "mkdir"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const existing of stage === "open" ? [false, true] : [false]) {
      it(`awaits ${stage} rollback after ${signal} (${existing ? "existing" : "new"} directory)`, async () => {
        const root = mkdtempSync(join(tmpdir(), "krun-test-init-interrupt-"));
        roots.push(root);
        const target = join(root, "sample");
        if (existing) {
          mkdirSync(target);
          writeFileSync(join(target, ".keep"), "user data");
        }
        const loader = join(root, "hold-acquisition.mjs");
        writeFileSync(loader, preload);
        const child = spawn(
          process.execPath,
          ["--import", loader, cli, "init", "--lang", "node", target, stage],
          {
            env,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        let stderr = "";
        child.stderr?.on("data", (data) => {
          stderr += data;
        });
        child.stdout?.resume();
        let acquired = false;
        let interrupted = false;
        child.on("message", (message: { stage: string }) => {
          if (message.stage === "acquired") {
            acquired = true;
            child.kill(signal);
          } else if (message.stage === "interrupted") {
            interrupted = true;
            if (child.connected) child.send("release", () => undefined);
          }
        });
        let timer: NodeJS.Timeout | undefined;
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`CLI did not exit: ${stderr}`)), 10_000);
            child.once("error", reject);
            child.once("close", resolve);
          });
          expect(acquired).toBe(true);
          expect(interrupted).toBe(true);
          expect(code, stderr).toBe(130);
          if (existing) {
            expect(readdirSync(target)).toEqual([".keep"]);
            expect(readFileSync(join(target, ".keep"), "utf8")).toBe("user data");
          } else {
            expect(existsSync(target)).toBe(false);
          }
          const retry = spawnSync(process.execPath, [cli, "init", "--lang", "node", target], {
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
          expect(retry.status, retry.stderr).toBe(0);
          expect(existsSync(join(target, "function.yaml"))).toBe(true);
          if (existing) expect(readFileSync(join(target, ".keep"), "utf8")).toBe("user data");
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
            child.kill("SIGKILL");
            await closed;
          }
        }
      }, 30_000);
    }
  }
}
