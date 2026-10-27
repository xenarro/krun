import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);

for (const partialSetup of [false, true])
  it(`isolates kind teardown from ambient configuration after ${partialSetup ? "partial" : "complete"} setup`, () => {
    const dir = mkdtempSync(join(tmpdir(), "krun-test-kind-context-"));
    try {
      const stateDir = join(dir, `krun-test-e2e-${owner}`);
      const ambient = join(dir, "ambient.json");
      const privateConfig = join(stateDir, "kubeconfig");
      const calls = join(dir, "calls.json");
      mkdirSync(stateDir, { mode: 0o700 });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({ owner, key: randomBytes(32).toString("hex") }),
        { mode: 0o600 },
      );
      const original = JSON.stringify({
        "current-context": "kind-krun-test-e2e",
        sentinel: "owned-keyless-ambient-fixture",
      });
      writeFileSync(ambient, original);
      if (!partialSetup)
        writeFileSync(privateConfig, JSON.stringify({ "current-context": "kind-krun-test-e2e" }));
      // Intercept only this child process's command boundary. Load the fixture
      // as JavaScript rather than executing a temporary script: the hardened
      // verifier deliberately mounts TMPDIR noexec. Actual pinned kind and real
      // cluster teardown are exercised separately by native acceptance.
      const preload = join(dir, "commands.mjs");
      writeFileSync(
        preload,
        `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let deleted = false;
cp.spawnSync = (executable, args) => {
  let stdout = '';
  if (executable === 'kind' && args[0] === 'get') stdout = deleted ? '' : 'krun-test-e2e\\n';
  else if (executable === 'kind' && args[0] === 'delete') {
    fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args));
    const i = args.indexOf('--kubeconfig');
    const selected = i < 0 ? process.env.KUBECONFIG : args[i + 1];
    if (fs.existsSync(selected)) fs.writeFileSync(selected, JSON.stringify({'current-context': ''}));
    deleted = true;
  } else if (executable !== 'docker') throw new Error('Unexpected fixture command');
  return {status: 0, stdout, stderr: ''};
};
syncBuiltinESMExports();
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, "test/e2e/cluster.ts", "down"],
        {
          cwd: root,
          env: { ...process.env, TMPDIR: dir, KUBECONFIG: ambient },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(ambient, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual([
        "delete",
        "cluster",
        "--name",
        "krun-test-e2e",
        "--kubeconfig",
        privateConfig,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
