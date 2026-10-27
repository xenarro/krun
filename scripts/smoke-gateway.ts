import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startFakeKube } from "../test/fake-kube/server.ts";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Usage: smoke-gateway.ts <image>");
const name = `krun-test-gateway-smoke-${randomBytes(6).toString("hex")}`;
const dir = await mkdtemp(join(tmpdir(), "krun-test-gateway-smoke-"));
const namespace = "krun-test-gateway-smoke";
const kube = await startFakeKube(namespace, true);
const groups: string[] = [];
let logs = "";
const partialClients: ReturnType<typeof httpRequest>[] = [];
const watchReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];
let child: ReturnType<typeof spawn> | undefined;
const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, "Owned Docker control failed");
  return result.stdout;
};
const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};
try {
  const token = randomBytes(32).toString("hex");
  const runToken = randomBytes(32).toString("base64url");
  const runId = "0192f000-0000-7000-8000-000000000038";
  const runHash = createHash("sha256").update(runToken).digest("hex");
  const keys = join(dir, "keys.json"),
    config = join(dir, "kubeconfig"),
    launcher = join(dir, "start.cjs");
  assert.equal(new URL(kube.address).hostname, "127.0.0.1");
  await writeFile(
    keys,
    JSON.stringify({
      keys: [
        {
          name: "smoke",
          key: token,
          scopes: ["functions:read", "runs:read", "runs:write"],
          functions: ["echo"],
        },
      ],
    }),
    { mode: 0o444 },
  );
  // The installed client requires this flag for an explicitly owned HTTP-only
  // loopback fixture. Production Kubernetes TLS/auth policy is not changed.
  await writeFile(
    config,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        { name: namespace, cluster: { server: kube.address, "insecure-skip-tls-verify": true } },
      ],
      users: [{ name: namespace, user: {} }],
      contexts: [{ name: namespace, context: { cluster: namespace, user: namespace, namespace } }],
      "current-context": namespace,
    }),
    { mode: 0o444 },
  );
  await writeFile(
    launcher,
    `const assert=require('node:assert/strict');const {spawnSync}=require('node:child_process');assert.equal(process.getuid(),65532);assert.equal(process.getgid(),65532);const r=spawnSync(process.execPath,['/app/bin/krun.js','migrate'],{encoding:'utf8',timeout:20000});assert.equal(r.status,0,'Owned image migration failed');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/krun.db');db.prepare('insert into runs(id,request_hash,function_name,input,state,priority,attempt,job_token_hash,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?)').run(${JSON.stringify(runId)},'a'.repeat(64),'echo','{"internal":true}','queued',0,0,${JSON.stringify(runHash)},'smoke','2026-10-26T00:00:00.000Z');db.close();process.argv=[process.execPath,'/app/bin/krun.js','gateway'];import('/app/bin/krun.js');\n`,
    { mode: 0o444 },
  );
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  child = spawn(
    "docker",
    [
      "run",
      "--name",
      name,
      "--read-only",
      "--network",
      "host",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/data:rw,nosuid,nodev,size=16m,uid=65532,gid=65532",
      "--volume",
      `${keys}:/run/krun-test-keys:ro`,
      "--volume",
      `${config}:/run/krun-test-kube:ro`,
      "--volume",
      `${launcher}:/krun-test-start.cjs:ro`,
      "--env",
      "KRUN_DB_MODE=embedded",
      "--env",
      "KRUN_DB_PATH=/data/krun.db",
      "--env",
      `KRUN_NAMESPACE=${namespace}`,
      "--env",
      "KRUN_API_KEYS_PATH=/run/krun-test-keys",
      "--env",
      "KUBECONFIG=/run/krun-test-kube",
      "--env",
      `KRUN_LISTEN_ADDR=127.0.0.1:${ports[0]}`,
      "--env",
      `KRUN_INTERNAL_LISTEN_ADDR=127.0.0.1:${ports[1]}`,
      "--env",
      `KRUN_ADMIN_LISTEN_ADDR=127.0.0.1:${ports[2]}`,
      "--env",
      "KRUN_SHUTDOWN_DELAY=2s",
      "--env",
      "KRUN_MAX_RESULT_BYTES=64",
      "--entrypoint",
      "/nodejs/bin/node",
      image,
      "/krun-test-start.cjs",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (data) => {
    logs += String(data);
  });
  child.stderr?.on("data", (data) => {
    logs += String(data);
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child?.once("exit", resolve);
    child?.once("error", reject);
  });
  const request = async (path: string, listener = 0, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${ports[listener]}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { code: response.status, body: await response.json() };
  };
  const openWatch = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": "ignored" },
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.ok(response.body);
    const reader = response.body.getReader();
    watchReaders.push(reader);
    const decoder = new TextDecoder();
    let buffered = "";
    return async () => {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          assert.equal(buffered, "", "Partial SSE frame at EOF");
          return undefined;
        }
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const boundary = buffered.indexOf("\n\n");
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      return frame;
    };
  };
  // Bounded tri-state probes of an actual external container, not application polling.
  const until = async (probe: () => Promise<boolean>) => {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      assert.equal(child?.exitCode, null, "Gateway image exited before acceptance state");
      try {
        if (await probe()) return;
      } catch {
        /* not listening yet */
      }
      await setTimeout(20);
    }
    throw new Error("Owned image acceptance deadline exceeded");
  };
  await until(async () => (await request("/healthz", 2)).code === 200);
  assert.equal((await request("/readyz", 2)).code, 503);
  kube.releaseList();
  await until(async () => (await request("/readyz", 2)).code === 200);
  groups.push("real-list-watch-initial-readiness");
  for (const path of ["/internal/v1/runs/%zz/input", "/internal/v1/runs/%E0%A4%A/input"]) {
    const response = await request(path, 1);
    assert.equal(response.code, 400);
    assert.equal(response.body.error.status, "INVALID_ARGUMENT");
    assert.equal(response.body.error.details[0].reason, "REQUEST_INVALID");
    assert.equal(response.body.error.details[0].domain, "krun.io");
    assert.equal(JSON.stringify(response.body).includes(path), false);
  }
  groups.push("internal-constructor-errors-canonical-and-sanitized");
  for (const [path, listener] of [
    ["/v1/functions", 2],
    ["/v1/functions", 1],
    ["/readyz", 0],
    ["/metrics", 1],
    ["/internal/v1/runs/unknown/input", 0],
  ] as const)
    assert.equal((await request(path, listener)).code, 404);
  groups.push("three-listener-isolation");
  const created = await request("/v1/functions/echo/runs", 0, { input: { owned: true } });
  assert.equal(created.code, 201);
  assert.equal((await request(`/v1/${created.body.name}`)).body.state, "QUEUED");
  groups.push("migrated-real-store-create-read");
  const waitPath = `/v1/${created.body.name}:wait`;
  const immediate = await request(waitPath, 0, { timeout: "0ms" });
  assert.equal(immediate.code, 200);
  assert.deepEqual(immediate.body, created.body);
  const timed = await request(waitPath, 0, { timeout: "100ms" });
  assert.equal(timed.code, 200);
  assert.equal(timed.body.state, "QUEUED");
  groups.push("waitrun-real-store-timeout-keeps200");
  const internal = async (operation: string, body?: string, bearer = runToken) => {
    const response = await fetch(
      `http://127.0.0.1:${ports[1]}/internal/v1/runs/${runId}/${operation}`,
      {
        method: operation === "input" ? "GET" : operation === "status" ? "POST" : "PUT",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "user-agent": "krun-test-p38-image",
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const text = await response.text();
    return {
      code: response.status,
      headers: response.headers,
      text,
      body: text ? JSON.parse(text) : undefined,
    };
  };
  const nextWatch = await openWatch(`/v1/functions/echo/runs/${runId}:watch`);
  const initialWatch = await nextWatch();
  assert.ok(initialWatch);
  assert.ok(initialWatch.startsWith("event: state\n"));
  assert.equal(initialWatch.includes('"input"'), false);
  groups.push("watchrun-real-store-initial-basic");
  const input = await internal("input");
  assert.equal(input.code, 200);
  assert.deepEqual(input.body, { internal: true });
  assert.equal(Number(input.headers.get("content-length")), Buffer.byteLength(input.text));
  assert.equal((await internal("input", undefined, token)).code, 401);
  assert.equal(
    (await internal("status", '{"message":"working","data":{"opaque":[null]}}')).code,
    204,
  );
  assert.equal((await internal("status", '{"message":"too fast"}')).code, 429);
  const statusWatch = await nextWatch();
  assert.ok(statusWatch);
  assert.ok(statusWatch.startsWith("event: status\n"));
  assert.equal(statusWatch.includes('"input"'), false);
  assert.ok(statusWatch.includes('"reportTime"'));
  groups.push("watchrun-real-sqlite-status-without-durable-event");
  assert.equal((await internal("result", "false")).code, 204);
  assert.equal(
    (await internal("error", '{"message":"reported","details":{"opaque":[null]}}')).code,
    204,
  );
  const reported = await request(`/v1/functions/echo/runs/${runId}`);
  assert.equal(reported.body.result, false);
  assert.equal(reported.body.error.source, "FUNCTION");
  assert.equal(reported.body.runtimeStatus.message, "working");
  assert.equal(typeof reported.body.runtimeStatus.reportTime, "string");
  assert.equal("at" in reported.body.runtimeStatus, false);
  const capped = await internal("result", " ".repeat(65));
  assert.equal(capped.code, 413);
  assert.equal(capped.body.error.details[0].reason, "RESULT_TOO_LARGE");
  assert.equal(capped.headers.get("connection"), "close");
  groups.push("internal-four-methods-token-state-rate-cap-and-public-projection");
  // A controlled durable SQLite update without a terminal run_event proves the
  // authoritative SSE fallback. This is not scheduler-driven Job completion.
  const terminalRun = await request("/v1/functions/echo/runs", 0, { input: { watchOnly: true } });
  assert.equal(terminalRun.code, 201);
  const terminalNext = await openWatch(`/v1/${terminalRun.body.name}:watch`);
  assert.ok((await terminalNext())?.startsWith("event: state\n"));
  const terminalId = terminalRun.body.name.split("/").at(-1);
  docker([
    "exec",
    name,
    "/nodejs/bin/node",
    "-e",
    `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/krun.db');try{db.prepare("update runs set state='succeeded',finished_at=?,result=? where id=?").run('2026-10-27T00:00:00.000Z','{"controlled":true}',${JSON.stringify(terminalId)});}finally{db.close();}`,
  ]);
  const terminalFrame = await terminalNext();
  assert.ok(terminalFrame);
  assert.ok(terminalFrame.includes('"state":"SUCCEEDED"'));
  assert.equal(terminalFrame.includes('"input"'), false);
  assert.equal(terminalFrame.includes('"result"'), false);
  assert.equal(await terminalNext(), undefined);
  const replay = await openWatch(`/v1/${terminalRun.body.name}:watch`);
  assert.ok((await replay())?.includes('"state":"SUCCEEDED"'));
  assert.equal(await replay(), undefined);
  groups.push("watchrun-controlled-terminal-fallback-and-terminal-connect-eof");
  // A legal BASIC snapshot larger than Node's native high-water mark still
  // reaches a normal client and reconnect. The physical Store row is real;
  // this is controlled fixture data, not a Kubernetes-produced large message.
  docker([
    "exec",
    name,
    "/nodejs/bin/node",
    "-e",
    `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/krun.db');try{db.prepare("update runs set job_status=? where id=?").run(JSON.stringify({phase:'Succeeded',message:'x'.repeat(131072),observedAt:'2026-10-27T00:00:00.000Z'}),${JSON.stringify(terminalId)});}finally{db.close();}`,
  ]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await openWatch(`/v1/${terminalRun.body.name}:watch`);
    const large = await next();
    assert.ok(large);
    assert.ok(large.startsWith("event: state\n"));
    assert.ok(Buffer.byteLength(large) > 65536);
    const data = /^data: (.+)$/m.exec(large);
    assert.ok(data?.[1]);
    const basic = JSON.parse(data[1]);
    assert.equal(basic.jobStatus.message.length, 131072);
    assert.equal("input" in basic, false);
    assert.equal("result" in basic, false);
    assert.equal(await next(), undefined);
  }
  groups.push("watchrun-large-terminal-basic-snapshot-and-reconnect");
  const waiting = request("/v1/functions/echo/runs?wait=60s", 0, { input: { wait: true } });
  waiting.catch(() => {});
  await until(async () => (await request("/v1/functions/echo/runs")).body.runs.length === 4);
  const existingWait = request(waitPath, 0, { timeout: "60s" });
  existingWait.catch(() => {});
  // Authenticated, under-cap bodies never complete. Closing the listener must
  // own these transports; no client timeout/abort may make this proof pass.
  const partialClosed: Promise<void>[] = [];
  for (const framing of [{ "content-length": "10" }, { "transfer-encoding": "chunked" }]) {
    const client = httpRequest(
      `http://127.0.0.1:${ports[1]}/internal/v1/runs/${runId}/result`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${runToken}`,
          "content-type": "application/json",
          ...framing,
        },
      },
      (response) => response.resume(),
    );
    partialClients.push(client);
    client.on("error", () => {});
    partialClosed.push(new Promise<void>((resolve) => client.once("close", resolve)));
    await new Promise<void>((resolve) =>
      client.once("socket", (socket) => socket.once("connect", resolve)),
    );
    client.flushHeaders();
    client.write("{");
  }
  const start = performance.now();
  docker(["kill", "--signal=TERM", name]);
  await until(async () => (await request("/readyz", 2)).code === 503);
  assert.equal((await request("/healthz", 2)).code, 200);
  assert.equal((await request("/v1/functions/echo")).code, 200);
  assert.equal((await internal("input")).code, 200);
  groups.push("readiness-first-live-during-fixed-drain");
  const response = await waiting;
  assert.equal(response.code, 201);
  assert.deepEqual(response.body.input, { wait: true });
  groups.push("inflight-create-wait-settles-current-run");
  const waited = await existingWait;
  assert.equal(waited.code, 200);
  assert.deepEqual(waited.body, created.body);
  groups.push("inflight-waitrun-settles-current-run-on-sigterm");
  assert.equal(await nextWatch(), undefined);
  groups.push("inflight-watchrun-ends-on-sigterm");
  assert.equal(await done, 0);
  await Promise.all(partialClosed);
  groups.push("internal-unfinished-bodies-closed-at-drain-end");
  const cliElapsed = performance.now() - start;
  // Measure the container process exit, not docker --rm filesystem cleanup.
  // Retain this named disposable container until its exact State is read back.
  const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
  assert.equal(state.ExitCode, 0);
  assert.equal(state.Running, false);
  const elapsed = Date.parse(state.FinishedAt) - (performance.timeOrigin + start);
  assert.ok(
    elapsed >= 1900 && elapsed < 5000,
    `Owned process drain elapsed ${elapsed}ms;Docker CLI ${cliElapsed}ms`,
  );
  groups.push("sigterm-exit-zero-within-five-seconds");
  assert.equal(kube.snapshot().activeWatches, 0);
  groups.push("watch-sockets-closed");
  assert.equal(logs.includes(token), false);
  assert.equal(logs.includes(runToken), false);
  assert.equal(logs.includes("krun-test-p38-image"), true);
  groups.push("credential-privacy");
  groups.push("nonroot-readonly-capability-dropped-runtime");
  console.log(
    JSON.stringify({
      image,
      groups,
      count: groups.length,
      elapsedMilliseconds: Math.round(elapsed),
      dockerCliElapsedMilliseconds: Math.round(cliElapsed),
      uid: 65532,
      gid: 65532,
      listWatch: kube.snapshot(),
    }),
  );
} finally {
  for (const reader of watchReaders) await reader.cancel().catch(() => {});
  for (const client of partialClients) client.destroy();
  spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 10000 });
  await kube.close();
  await rm(dir, { recursive: true, force: true });
}
