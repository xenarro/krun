import { spawnSync } from "node:child_process";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Usage: smoke-scheduler.ts <image>");
// Reuse the permanent process acceptance against the actual hardened image;
// the fixture owns its namespace, kubeconfig, ephemeral DB and named containers.
const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "apps/scheduler/src/runtime-process.test.ts"],
  {
    env: { ...process.env, KRUN_TEST_SCHEDULER_IMAGE: image },
    encoding: "utf8",
    timeout: 120000,
  },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
