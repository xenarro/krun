import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { execute } from "./deploy-services.js";

const running = async (pid: number) => {
  try {
    process.kill(pid, 0);
    // A killed orphan may await the host init's reaper; it cannot hold pipes or run.
    return (
      process.platform !== "linux" ||
      !/^\d+ \(.*\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))
    );
  } catch {
    return false;
  }
};

for (const timeout of [false, true])
  it(`joins an inherited-pipe helper on ${timeout ? "timeout" : "interruption"} without signalling the caller`, async () => {
    const root = await mkdtemp(join(tmpdir(), "krun-test-deploy-tree-"));
    const marker = join(root, "pids.json");
    const helper =
      "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000);";
    const program = `import {spawn} from 'node:child_process'; import {writeFileSync,renameSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const helper=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit','ipc']}); helper.once('message',pid=>{writeFileSync(${JSON.stringify(`${marker}.pending`)},JSON.stringify({parent:process.pid,helper:pid})); renameSync(${JSON.stringify(`${marker}.pending`)},${JSON.stringify(marker)});}); setInterval(()=>{},1000);`;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve) => {
      watcher = watch(root, (_event, name) => {
        if (name === "pids.json") resolve();
      });
    });
    const command = execute(process.execPath, ["--input-type=module", "-e", program], root);
    const fiber = Effect.runFork(timeout ? command.pipe(Effect.timeout("2 seconds")) : command);
    let pids: { parent: number; helper: number } | undefined;
    let settled: Promise<unknown> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned tree did not settle")), 3_500);
      });
      await Promise.race([ready, deadline]);
      pids = JSON.parse(await readFile(marker, "utf8"));
      settled = Effect.runPromise(
        timeout
          ? Fiber.await(fiber)
          : Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
      );
      const exit = await Promise.race([settled, deadline]);
      expect(exit).toMatchObject({ _tag: "Failure" });
      expect(await running(pids?.parent ?? 0)).toBe(false);
      expect(await running(pids?.helper ?? 0)).toBe(false);
      expect(await running(process.pid)).toBe(true);
    } finally {
      clearTimeout(timer);
      watcher?.close();
      for (const pid of [pids?.parent, pids?.helper]) {
        if (pid !== undefined && (await running(pid))) process.kill(pid, "SIGKILL");
      }
      await (settled ?? Effect.runPromise(Fiber.interrupt(fiber)));
      await rm(root, { recursive: true, force: true });
    }
  });
