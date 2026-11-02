import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const preload = `
import * as cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.default.spawn;
cp.default.spawn = (command,args,options) => {
  if(command !== 'docker') return original(command,args,options);
  const helper = "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000)";
  const parent = "const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const helper=spawn(process.execPath,['-e',"+JSON.stringify(helper)+"],{stdio:['ignore','inherit','inherit','ipc']}); helper.once('message',pid=>process.stdout.write(JSON.stringify({pid:process.pid,helper:pid}))); setInterval(()=>{},1000)";
  const child = original(process.execPath,['-e',parent],options);
  child.stdout.once('data',bytes=>process.send(JSON.parse(bytes.toString())));
  return child;
};
syncBuiltinESMExports();
`;

for (const signal of ["SIGINT", "SIGTERM"] as const)
  it(`CLI ${signal} exits 130 only after the actual child and inherited-pipe helper are gone, without applying or writing`, async () => {
    const root = await mkdtemp(join(tmpdir(), "krun-test-deploy-interrupt-"));
    const file = join(root, "function.yaml");
    const source =
      "apiVersion: krun.io/v1alpha1\nkind: Function\nmetadata: {name: sample}\nspec: {image: REPLACE_WITH_DIGEST, inputSchema: {type: object}}\n";
    const loader = join(root, "child-barrier.mjs");
    await writeFile(file, source);
    await writeFile(loader, preload);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
      ),
    );
    const child = spawn(
      process.execPath,
      ["--import", loader, cli, "deploy", "--registry", "localhost:5001", root],
      { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    child.stdout?.resume();
    let stderr = "";
    child.stderr?.on("data", (bytes) => {
      stderr += bytes;
    });
    let pid: number | undefined;
    let helper: number | undefined;
    child.once("message", (message: { pid: number; helper: number }) => {
      pid = message.pid;
      helper = message.helper;
      child.kill(signal);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("CLI interruption did not settle")), 10_000);
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stderr).toBe(130);
      expect(pid).toBeTypeOf("number");
      expect(() => process.kill(pid ?? 0, 0)).toThrow();
      expect(helper).toBeTypeOf("number");
      let active = false;
      try {
        process.kill(helper ?? 0, 0);
        active =
          process.platform !== "linux" ||
          !/^\d+ \(.*\) Z /.test(await readFile(`/proc/${helper}/stat`, "utf8"));
      } catch {}
      expect(active).toBe(false);
      expect(await readFile(file, "utf8")).toBe(source);
      expect(stderr).not.toContain("Applying function.yaml");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
      for (const owned of [pid, helper]) {
        if (owned !== undefined) {
          try {
            process.kill(owned, "SIGKILL");
          } catch {}
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
