import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { eventually } from "../e2e/lib/wait.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
it("holds the first accepted status until a delayed observer acknowledges it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "krun-test-status-observer-"));
  const fifo = join(dir, "first-status-ack");
  const common = join(dir, "common.sh");
  await writeFile(common, 'set -eu\nstatus() { printf "%s\\n" "$1"; }\n');
  const source = (await readFile(join(root, "test/e2e/functions/exit_code_status.sh"), "utf8"))
    .replace(". /common.sh", `. "${common}"`)
    .replaceAll("/tmp/krun-e2e-first-status-ack", fifo);
  const child = spawn("/bin/sh", ["-c", source], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => {
    output += part;
  });
  child.stderr.resume();
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const messages = () => output.split("\n").filter((line) => line.startsWith("{"));
  try {
    await eventually(
      async () => messages().length,
      (count) => (count === 1 ? "done" : child.exitCode === null ? "wait" : "fail"),
      "First fixture status",
      2000,
    );
    const first = performance.now();
    await eventually(
      async () => ({ count: messages().length, running: child.exitCode === null }),
      (value) =>
        value.count !== 1 || !value.running
          ? "fail"
          : performance.now() - first >= 1250
            ? "done"
            : "wait",
      "Delayed observer retains the first status beyond the original race window",
      2500,
    );
    await writeFile(fifo, "first-observed\n");
    expect(await ended).toBe(3);
    expect(messages().map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await ended;
    await rm(dir, { recursive: true, force: true });
  }
});
