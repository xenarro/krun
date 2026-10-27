import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startSchedulerKube } from "./scheduler.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const schedulerRunId = "0192f000-0000-7000-8000-000000000411";
export const schedulerUntil = async (check: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + 10000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, "Owned scheduler process observation timed out");
    await setTimeout(20);
  }
};
const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};

/** Start the real compiled command; an optional image runs the identical CLI graph. */
export const startSchedulerProcess = async (
  options: {
    standby?: boolean;
    holdFunctions?: boolean;
    holdJobs?: boolean;
    seed?: boolean;
    image?: string | undefined;
    configuredStorage?: boolean;
  } = {},
) => {
  const namespace = "krun-test-scheduler-process";
  const name = `krun-test-p411-process-${randomBytes(6).toString("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), "krun-test-p411-"));
  const kube = await startSchedulerKube(namespace, options.standby, options.holdFunctions);
  if (options.holdJobs) kube.holdJobLists();
  const port = await freePort();
  const dbPath = options.image ? "/data/krun.db" : join(dir, "krun.db");
  const kubePath = join(dir, "kubeconfig.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    KRUN_DB_MODE: "embedded",
    KRUN_DB_PATH: dbPath,
    KRUN_NAMESPACE: namespace,
    KRUN_JOBS_NAMESPACE: namespace,
    KRUN_POD_NAME: "krun-test-scheduler-pod",
    KRUN_ADMIN_LISTEN_ADDR: `127.0.0.1:${port}`,
    KRUN_LOG_LEVEL: "info",
    KUBECONFIG: kubePath,
  };
  if (options.configuredStorage) env.KRUN_S3_BUCKET = "krun-test-results";
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name, cluster: { server: kube.address, "insecure-skip-tls-verify": true } }],
    users: [{ name, user: {} }],
    contexts: [{ name, context: { cluster: name, user: name, namespace } }],
    "current-context": name,
  };
  await writeFile(kubePath, JSON.stringify(config), { mode: 0o444 });
  const seed = `const d=new (require('node:sqlite').DatabaseSync)(process.env.KRUN_DB_PATH);d.prepare('insert into runs(id,request_hash,function_name,input,state,priority,attempt,created_by,created_at) values(?,?,?,?,?,?,?,?,?)').run('${schedulerRunId}','a'.repeat(64),'echo','{}','queued',0,0,'krun-test',new Date().toISOString());d.close();`;
  let child: ReturnType<typeof spawn>;
  try {
    if (options.image) {
      const launcher = join(dir, "launcher.cjs");
      await writeFile(
        launcher,
        `const a=require('node:assert/strict');const s=require('node:child_process').spawnSync; a.equal(process.getuid(),65532);a.equal(process.getgid(),65532);const r=s(process.execPath,['/app/bin/krun.js','migrate'],{encoding:'utf8'});a.equal(r.status,0,'Owned image migration failed');${options.seed ? seed : ""}process.argv=[process.execPath,'/app/apps/scheduler/dist/main.js'];import('/app/apps/scheduler/dist/main.js');`,
        { mode: 0o444 },
      );
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/data:rw,nosuid,nodev,size=16m,uid=65532,gid=65532",
        "--mount",
        `type=bind,source=${kubePath},target=/krun-test-kube,readonly`,
        "--mount",
        `type=bind,source=${launcher},target=/krun-test-launcher.cjs,readonly`,
      ];
      for (const [key, value] of Object.entries(env))
        if (key.startsWith("KRUN_") && value !== undefined) args.push("--env", `${key}=${value}`);
      args.push(
        "--env",
        "KUBECONFIG=/krun-test-kube",
        "--entrypoint",
        "/nodejs/bin/node",
        options.image,
        "/krun-test-launcher.cjs",
      );
      child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const migrated = spawnSync(process.execPath, [join(root, "bin/krun.js"), "migrate"], {
        env,
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(migrated.status, 0, "Owned scheduler migration failed");
      if (options.seed) {
        const seeded = spawnSync(process.execPath, ["-e", seed], {
          env,
          encoding: "utf8",
          timeout: 10000,
        });
        assert.equal(seeded.status, 0);
      }
      child = spawn(process.execPath, [join(root, "bin/krun.js"), "scheduler"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch (error) {
    await kube.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    },
  );
  const response = async (path: string) => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Owned scheduler exited before observation");
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) });
    } catch {
      return undefined;
    }
  };
  return {
    kube,
    output: () => output,
    exited,
    response,
    state: async () => {
      if (options.image) {
        const script = `const d=new(require('node:sqlite').DatabaseSync)(process.env.KRUN_DB_PATH,{readOnly:true});console.log(JSON.stringify(d.prepare('select state from runs where id=?').get('${schedulerRunId}')));d.close();`;
        const result = await execute("docker", ["exec", name, "/nodejs/bin/node", "-e", script], {
          encoding: "utf8",
          timeout: 10000,
        });
        return (JSON.parse(result.stdout) as { state: string } | null)?.state;
      }
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return (
          db.prepare("select state from runs where id=?").get(schedulerRunId) as
            | { state: string }
            | undefined
        )?.state;
      } finally {
        db.close();
      }
    },
    breakStore: async () => {
      const script =
        "const d=new(require('node:sqlite').DatabaseSync)(process.env.KRUN_DB_PATH);d.exec('DROP TABLE runs');d.close();";
      if (options.image)
        await execute("docker", ["exec", name, "/nodejs/bin/node", "-e", script], {
          encoding: "utf8",
          timeout: 10000,
        });
      else
        await execute(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 10000 });
    },
    stop: async () => {
      const before = performance.now();
      if (options.image)
        await execute("docker", ["kill", "--signal", "TERM", name], {
          encoding: "utf8",
          timeout: 10000,
        });
      else child.kill("SIGTERM");
      const timer = new AbortController();
      try {
        const result = await Promise.race([
          exited,
          setTimeout(5000, undefined, { signal: timer.signal }).then(() => {
            throw new Error("Owned scheduler exceeded five-second shutdown acceptance");
          }),
        ]);
        assert.ok(performance.now() - before < 5000);
        return result;
      } finally {
        timer.abort();
      }
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (options.image)
          await execute("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => {});
        else child.kill("SIGKILL");
        await exited.catch(() => {});
      }
      await kube.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};
