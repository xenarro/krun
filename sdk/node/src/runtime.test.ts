import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

type Seen = {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
  at: number;
  authorized: boolean;
};
type Reply = (request: Seen, response: ServerResponse, seen: Seen[]) => void;
const sdk = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function exercise(
  handler: string,
  options: {
    env?: Record<string, string>;
    reply?: Reply;
    local?: boolean;
    input?: string;
    file?: boolean;
    signal?: boolean;
    observeTimeouts?: boolean;
    observeIntervals?: boolean;
  } = {},
) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const headers = { ...request.headers };
    const authorized = headers.authorization === `Bearer ${token}`;
    if (headers.authorization) headers.authorization = "[REDACTED]";
    const record = {
      path: request.url ?? "",
      method: request.method ?? "",
      headers,
      body,
      at: performance.now(),
      authorized,
    };
    seen.push(record);
    if (options.reply) options.reply(record, response, seen);
    else if (record.path.endsWith("/input"))
      response.writeHead(200, { "content-type": "application/json" }).end('{"answer":42}');
    else response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  const directory = mkdtempSync(join(tmpdir(), "krun-test-node-sdk-"));
  const token = randomBytes(32).toString("base64url");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS",
    ),
  );
  const url = `http://127.0.0.1:${address.port}`;
  Object.assign(
    env,
    options.local
      ? {}
      : {
          KRUN_GATEWAY_URL: url,
          KRUN_RUN_ID: "019a0000-0000-7000-8000-000000000001",
          KRUN_FUNCTION: "fixture",
          KRUN_TOKEN: token,
          KRUN_MAX_RESULT_BYTES: "262144",
        },
    options.env,
  );
  if (env.KRUN_RESULT_UPLOAD_URL === "UPLOAD") env.KRUN_RESULT_UPLOAD_URL = `${url}/upload`;
  const script = join(directory, "handler.mjs");
  const observeIntervals = options.observeIntervals
    ? 'const interval = globalThis.setInterval; globalThis.setInterval = (fn, ms) => { const timer = interval(() => { process.stderr.write(JSON.stringify({tick:ms})+"\\n"); fn(); },ms); queueMicrotask(() => process.stderr.write(JSON.stringify({period:ms,unref:!timer.hasRef()})+"\\n")); return timer; };\n'
    : "";
  writeFileSync(
    script,
    `${observeIntervals}${options.observeTimeouts ? 'const timeout = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = (ms) => { process.stderr.write(JSON.stringify({timeout:ms})+"\\n"); return timeout(ms); };\n' : ""}import { run } from ${JSON.stringify(new URL(`file://${sdk}`).href)};\nawait run(${handler});\n`,
  );
  const args = [script];
  if (options.file) {
    const input = join(directory, "input.json");
    writeFileSync(input, options.input ?? "{}");
    args.push(input);
  }
  const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input ?? "{}");
  const start = performance.now();
  let forced = false;
  const deadline = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, 55_000);
  try {
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (options.signal) {
      while (seen.length === 0 && child.exitCode === null) await sleep(5);
      child.kill("SIGTERM");
    }
    const code = await completed;
    expect(forced, "SDK child exceeded its acceptance deadline").toBe(false);
    expect(stdout.includes(token)).toBe(false);
    expect(stderr.includes(token)).toBe(false);
    for (const request of seen.filter((request) => request.path.startsWith("/internal/v1/"))) {
      expect(request.authorized).toBe(true);
      expect(request.headers["user-agent"]).toBe(`krun-sdk-node/${version}`);
    }
    return { code, stdout, stderr, seen, duration: performance.now() - start, url };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
const writes = (seen: Seen[], suffix: string) =>
  seen.filter((request) => request.path.endsWith(`/${suffix}`));
const ok: Reply = (request, response) =>
  request.path.endsWith("/input")
    ? response.writeHead(200).end('{"answer":42}')
    : response.writeHead(204).end();

it("exports only run without starting a function during import", async () => {
  expect(Object.keys(await import("./index.js"))).toEqual(["run"]);
});
it("reads input, exposes context, writes a result and logs only the explicit JSON line", async () => {
  const result = await exercise(
    'async (input, ctx) => { ctx.log({event:"work"}); return {input, id:ctx.runId, function:ctx.function}; }',
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('{"event":"work"}\n');
  expect(result.seen.map((r) => [r.method, r.path.split("/").at(-1)])).toEqual([
    ["GET", "input"],
    ["PUT", "result"],
  ]);
  expect(JSON.parse(writes(result.seen, "result")[0]?.body ?? "")).toEqual({
    input: { answer: 42 },
    id: "019a0000-0000-7000-8000-000000000001",
    function: "fixture",
  });
});
for (const value of ["undefined", "null"])
  it(`void ${value} sends no result and does not wait for a heartbeat`, async () => {
    const result = await exercise(`async () => ${value}`, {
      env: { KRUN_HEARTBEAT_TIMEOUT: "300" },
    });
    expect(result.code).toBe(0);
    expect(result.seen).toHaveLength(1);
    expect(result.duration).toBeLessThan(2000);
  });
for (const value of ["false", "0", '""'])
  it(`stores non-void JSON ${value}`, async () => {
    const result = await exercise(`async () => ${value}`);
    expect(result.code).toBe(0);
    expect(writes(result.seen, "result")[0]?.body).toBe(value);
  });
it("uploads above the exact byte cap, with Content-Length and without auth/checksum/inline result", async () => {
  const result = await exercise('async () => "🦉"', {
    env: { KRUN_MAX_RESULT_BYTES: "5", KRUN_RESULT_UPLOAD_URL: "UPLOAD" },
    observeTimeouts: true,
    reply: (request, response) => {
      // The input body supplies the fake's address without exposing a presigned capability.
      if (request.path === "/upload") response.writeHead(200).end();
      else ok(request, response, []);
    },
  });
  // UPLOAD is replaced with the owned fake URL by the test helper.
  expect(result.code).toBe(0);
  const upload = writes(result.seen, "upload")[0];
  expect(
    result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).timeout),
  ).toEqual([10_000, 300_000]);
  expect(upload?.body).toBe('"🦉"');
  expect(upload?.headers["content-length"]).toBe("6");
  expect(upload?.headers["content-type"]).toBe("application/json");
  expect(upload?.headers["user-agent"]).toBe(`krun-sdk-node/${version}`);
  expect(upload?.headers.authorization).toBeUndefined();
  expect(upload?.headers["transfer-encoding"]).toBeUndefined();
  expect(Object.keys(upload?.headers ?? {}).some((key) => key.startsWith("x-amz-checksum"))).toBe(
    false,
  );
  expect(writes(result.seen, "result")).toHaveLength(0);
});
it("keeps a result exactly at the byte cap inline", async () => {
  const result = await exercise('async () => "🦉"', { env: { KRUN_MAX_RESULT_BYTES: "6" } });
  expect(result.code).toBe(0);
  expect(writes(result.seen, "result")[0]?.body).toBe('"🦉"');
});
for (const kind of ["absent", "403", "inline400", "serialization"])
  it(`reports ResultWriteError and exits 1 for ${kind}`, async () => {
    const result = await exercise(
      kind === "serialization" ? "async () => 1n" : 'async () => "large"',
      {
        env:
          kind === "inline400" || kind === "serialization"
            ? {}
            : {
                KRUN_MAX_RESULT_BYTES: "1",
                ...(kind === "403" ? { KRUN_RESULT_UPLOAD_URL: "UPLOAD" } : {}),
              },
        reply: (request, response) =>
          request.path === "/upload" || (kind === "inline400" && request.path.endsWith("/result"))
            ? response.writeHead(kind === "403" ? 403 : 400).end()
            : ok(request, response, []),
      },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(writes(result.seen, "error")[0]?.body ?? "").type).toBe("ResultWriteError");
    expect(writes(result.seen, "upload")).toHaveLength(kind === "403" ? 1 : 0);
  });
it("reports a thrown error, bounded by compact JSON UTF-8 field limits", async () => {
  const result = await exercise(
    'async () => { class HugeError extends Error {} Object.defineProperty(HugeError,"name",{value:"🦉".repeat(100)}); const error = new HugeError("\\"\\n🦉".repeat(3000)); error.stack = Array.from({length:30},(_,i)=>String(i)+"x".repeat(1000)).join("\\n"); throw error; }',
  );
  expect(result.code).toBe(1);
  const error = JSON.parse(writes(result.seen, "error")[0]?.body ?? "");
  expect(Buffer.byteLength(JSON.stringify(error.message))).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(JSON.stringify(error.type))).toBeLessThanOrEqual(128);
  expect(Buffer.byteLength(JSON.stringify(error.details))).toBeLessThanOrEqual(8192);
  expect(error.details.stack.length).toBeLessThanOrEqual(20);
  expect(error.details.stack[0]).toMatch(/^0x/);
  expect(writes(result.seen, "result")).toHaveLength(0);
});
it("truncates escaped status messages, omits oversized data and invalid progress without throwing", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("\\"\\n🦉".repeat(2000),Infinity,{text:"x".repeat(5000)}); const circular={}; circular.self=circular; await ctx.status("safe",0.5,circular); }',
  );
  expect(result.code).toBe(0);
  const statuses = writes(result.seen, "status").map((r) => JSON.parse(r.body));
  expect(statuses).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(statuses[0].message))).toBeLessThanOrEqual(1024);
  expect(statuses[0].message).not.toContain("�");
  expect(statuses[0].data).toBeUndefined();
  expect(statuses[0].progress).toBeUndefined();
  expect(statuses[1]).toEqual({ message: "safe", progress: 0.5 });
});
it("snapshots status data once before measuring and queueing its JSON bytes", async () => {
  const result = await exercise(
    'async (_,ctx) => { let calls=0; await ctx.status("snapshot",0,{toJSON:()=>calls++===0?{small:true}:{large:"x".repeat(5000)}}); }',
  );
  const payload = JSON.parse(writes(result.seen, "status")[0]?.body ?? "");
  expect(payload.data).toEqual({ small: true });
  expect(Buffer.byteLength(JSON.stringify(payload.data))).toBeLessThanOrEqual(4096);
  expect(result.code).toBe(0);
});
it("sends two immediate status calls in distinct one-second slots without eager started", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("one",0.1); await ctx.status("two",0.2); }',
  );
  const statuses = writes(result.seen, "status");
  expect(statuses.map((r) => JSON.parse(r.body))).toEqual([
    { message: "one", progress: 0.1 },
    { message: "two", progress: 0.2 },
  ]);
  expect((statuses[1]?.at ?? 0) - (statuses[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);
  expect(result.code).toBe(0);
});
it("coalesces pending statuses to the latest payload", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("one"); await Promise.all([ctx.status("two"),ctx.status("three")]); }',
  );
  expect(writes(result.seen, "status").map((r) => JSON.parse(r.body).message)).toEqual([
    "one",
    "three",
  ]);
  expect(result.code).toBe(0);
});
it("keeps 429 pending and resends at the next slot", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("pending",0.1,{rows:2}); await new Promise(r=>setTimeout(r,1300)); }',
    {
      reply: (request, response, seen) =>
        request.path.endsWith("/status") && writes(seen, "status").length === 1
          ? response.writeHead(429).end()
          : ok(request, response, seen),
    },
  );
  const statuses = writes(result.seen, "status");
  expect(statuses).toHaveLength(2);
  expect(statuses[1]?.body).toBe(statuses[0]?.body);
  expect((statuses[1]?.at ?? 0) - (statuses[0]?.at ?? 0)).toBeGreaterThanOrEqual(990);
});
it("heartbeats at one third of the window with the last complete payload during a slow result write", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("loading",0.1,{rows:2}); return {ok:true}; }',
    {
      env: { KRUN_HEARTBEAT_TIMEOUT: "3" },
      observeIntervals: true,
      reply: (request, response, seen) =>
        request.path.endsWith("/result")
          ? setTimeout(() => response.writeHead(204).end(), 2300)
          : ok(request, response, seen),
    },
  );
  const statuses = writes(result.seen, "status");
  const resultAt = writes(result.seen, "result")[0]?.at ?? 0;
  // The timer ticks every T/3; network completion plus the one-second gate
  // can phase-shift delivery, so do not demand two completed POSTs in 2.3s.
  expect(statuses.length).toBeGreaterThanOrEqual(2);
  const ticks = result.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(ticks.find((event) => event.period)).toEqual({ period: 1000, unref: true });
  expect(ticks.filter((event) => event.tick === 1000).length).toBeGreaterThanOrEqual(2);
  expect(statuses.every((r) => r.body === statuses[0]?.body)).toBe(true);
  expect(statuses.filter((r) => r.at > resultAt).length).toBeGreaterThanOrEqual(1);
  expect(result.code).toBe(0);
}, 8000);
it("does not overflow a long heartbeat interval into eager one-millisecond pings", async () => {
  const result = await exercise("async () => null", {
    env: { KRUN_HEARTBEAT_TIMEOUT: "9000000" },
    observeIntervals: true,
  });
  expect(result.code).toBe(0);
  expect(result.seen).toHaveLength(1);
  expect(result.stderr.includes("TimeoutOverflowWarning")).toBe(false);
  expect(JSON.parse(result.stderr)).toEqual({ period: 2147483647, unref: true });
});
it("starts heartbeat before GetInput returns, but not eagerly", async () => {
  const result = await exercise("async () => null", {
    env: { KRUN_HEARTBEAT_TIMEOUT: "3" },
    reply: (request, response) =>
      request.path.endsWith("/input")
        ? setTimeout(() => response.writeHead(200).end("{}"), 1300)
        : response.writeHead(204).end(),
  });
  const status = writes(result.seen, "status")[0];
  expect(JSON.parse(status?.body ?? "")).toEqual({ message: "started" });
  expect((status?.at ?? 0) - (result.seen[0]?.at ?? 0)).toBeGreaterThan(850);
  expect(result.code).toBe(0);
});
for (const outcome of [400, 503, "timeout"] as const)
  it(`status ${outcome} is one bounded attempt and never throws`, async () => {
    const result = await exercise(
      'async (_,ctx) => { await ctx.status("loading"); return true; }',
      {
        reply: (request, response, seen) => {
          if (!request.path.endsWith("/status")) ok(request, response, seen);
          else if (outcome !== "timeout") response.writeHead(outcome).end();
        },
      },
    );
    expect(result.code).toBe(0);
    expect(writes(result.seen, "status")).toHaveLength(1);
    if (outcome === "timeout") expect(result.duration).toBeGreaterThanOrEqual(2900);
    expect(result.duration).toBeLessThan(5000);
  }, 7000);
for (const endpoint of ["input", "result", "error"])
  it(`retries ${endpoint} 503 three times with 1/2/4 second backoff`, async () => {
    const result = await exercise(
      endpoint === "error" ? 'async () => { throw new Error("oops"); }' : "async () => true",
      {
        reply: (request, response, seen) => {
          if (request.path.endsWith(`/${endpoint}`) && writes(seen, endpoint).length < 4)
            response.writeHead(503).end();
          else ok(request, response, seen);
        },
      },
    );
    const attempts = writes(result.seen, endpoint);
    expect(attempts).toHaveLength(4);
    for (let i = 1; i < 4; i++)
      expect((attempts[i]?.at ?? 0) - (attempts[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        [0, 990, 1990, 3990][i] ?? 0,
      );
    expect(result.code).toBe(endpoint === "error" ? 1 : 0);
  }, 15_000);
for (const endpoint of ["input", "result", "error"])
  it(`times out never-answering ${endpoint} after 10s per attempt and three retries`, async () => {
    const result = await exercise(
      endpoint === "error" ? 'async () => { throw new Error("failure"); }' : "async () => true",
      {
        reply: (request, response, seen) => {
          if (!request.path.endsWith(`/${endpoint}`)) ok(request, response, seen);
        },
      },
    );
    expect(result.code).toBe(1);
    expect(writes(result.seen, endpoint)).toHaveLength(4);
    expect(result.duration).toBeGreaterThanOrEqual(46_500);
    expect(result.duration).toBeLessThan(54_000);
  }, 60_000);
for (const endpoint of ["input", "result", "error", "status", "upload"])
  it(`401 on ${endpoint} terminates immediately without retry or a later error call`, async () => {
    const result = await exercise(
      endpoint === "error"
        ? 'async () => { throw new Error("oops"); }'
        : endpoint === "status"
          ? 'async (_,ctx) => { await ctx.status("work"); return true; }'
          : "async () => true",
      {
        env:
          endpoint === "upload"
            ? { KRUN_MAX_RESULT_BYTES: "1", KRUN_RESULT_UPLOAD_URL: "UPLOAD" }
            : {},
        reply: (request, response, seen) =>
          request.path.endsWith(`/${endpoint}`)
            ? response.writeHead(401).end()
            : ok(request, response, seen),
      },
    );
    expect(result.code).toBe(1);
    expect(writes(result.seen, endpoint)).toHaveLength(1);
    expect(result.seen.at(-1)?.path.endsWith(`/${endpoint}`)).toBe(true);
  });
it("exits 1 on SIGTERM while the handler is running", async () => {
  const result = await exercise("async () => { await new Promise(r=>setTimeout(r,10000)); }", {
    signal: true,
  });
  expect(result.code).toBe(1);
});
for (const file of [false, true])
  it(`local mode reads ${file ? "file" : "stdin"}, separates streams and never contacts the gateway`, async () => {
    const result = await exercise(
      'async (input,ctx) => { ctx.log({event:"local"}); await ctx.status("ready",0.1); return input; }',
      { local: true, input: '{"local":42}', file },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"local":42}\n');
    expect(
      result.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ event: "local" }, { message: "ready", progress: 0.1 }]);
    expect(result.seen).toEqual([]);
  });
it("local void produces no stdout and local exceptions exit 1 on stderr", async () => {
  const empty = await exercise("async () => null", { local: true });
  expect(empty.code).toBe(0);
  expect(empty.stdout).toBe("");
  const error = await exercise('async () => { throw new TypeError("local failure"); }', {
    local: true,
  });
  expect(error.code).toBe(1);
  expect(error.stdout).toBe("");
  expect(JSON.parse(error.stderr).type).toBe("TypeError");
});
it("retries an upload on 503 with the same exact bytes and never falls back to SetResult", async () => {
  const result = await exercise('async () => ({large:"result"})', {
    env: { KRUN_MAX_RESULT_BYTES: "1", KRUN_RESULT_UPLOAD_URL: "UPLOAD" },
    reply: (request, response, seen) => {
      if (request.path === "/upload")
        response.writeHead(writes(seen, "upload").length < 4 ? 503 : 200).end();
      else ok(request, response, seen);
    },
  });
  const attempts = writes(result.seen, "upload");
  expect(attempts).toHaveLength(4);
  expect(new Set(attempts.map((r) => r.body)).size).toBe(1);
  expect(attempts.every((r) => r.headers.authorization === undefined)).toBe(true);
  expect(writes(result.seen, "result")).toHaveLength(0);
  expect(result.code).toBe(0);
}, 15_000);
for (const endpoint of ["input", "result", "upload"])
  it(`does not follow or retry a ${endpoint} redirect`, async () => {
    const result = await exercise("async () => true", {
      env:
        endpoint === "upload"
          ? { KRUN_MAX_RESULT_BYTES: "1", KRUN_RESULT_UPLOAD_URL: "UPLOAD" }
          : {},
      reply: (request, response, seen) =>
        request.path.endsWith(`/${endpoint}`)
          ? response.writeHead(302, { location: "/elsewhere" }).end()
          : ok(request, response, seen),
    });
    expect(result.code).toBe(1);
    expect(writes(result.seen, endpoint)).toHaveLength(1);
    expect(writes(result.seen, "elsewhere")).toHaveLength(0);
  }, 15_000);
it("retries a connection reset without exposing connection diagnostics", async () => {
  const result = await exercise("async () => true", {
    reply: (request, response, seen) => {
      if (request.path.endsWith("/input") && writes(seen, "input").length === 1) response.destroy();
      else ok(request, response, seen);
    },
  });
  expect(writes(result.seen, "input").length).toBeGreaterThanOrEqual(2);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain(result.url);
});
it("replaces a pending 429 payload with the latest status", async () => {
  const result = await exercise(
    'async (_,ctx) => { await ctx.status("old"); await ctx.status("new"); }',
    {
      reply: (request, response, seen) =>
        request.path.endsWith("/status") && writes(seen, "status").length === 1
          ? response.writeHead(429).end()
          : ok(request, response, seen),
    },
  );
  expect(writes(result.seen, "status").map((r) => JSON.parse(r.body).message)).toEqual([
    "old",
    "new",
  ]);
  expect(result.code).toBe(0);
});
it("drops an in-flight status and queued heartbeat once the terminal write returns", async () => {
  const result = await exercise('async (_,ctx) => { void ctx.status("pending"); return true; }', {
    env: { KRUN_HEARTBEAT_TIMEOUT: "3" },
    reply: (request, response, seen) => {
      if (!request.path.endsWith("/status")) ok(request, response, seen);
    },
  });
  expect(result.code).toBe(0);
  expect(result.duration).toBeLessThan(2000);
  expect(writes(result.seen, "result")).toHaveLength(1);
});
it("keeps heartbeat alive until a slow error report returns", async () => {
  const result = await exercise('async () => { throw new Error("failure"); }', {
    env: { KRUN_HEARTBEAT_TIMEOUT: "3" },
    reply: (request, response, seen) =>
      request.path.endsWith("/error")
        ? setTimeout(() => response.writeHead(204).end(), 2200)
        : ok(request, response, seen),
  });
  expect(writes(result.seen, "status").length).toBeGreaterThanOrEqual(1);
  expect(writes(result.seen, "status").every((r) => r.body === '{"message":"started"}')).toBe(true);
  expect(result.code).toBe(1);
}, 8000);

// Local and deployed executions must agree before any result bytes leave the SDK.
for (const local of [true, false]) {
  for (const [name, expression] of [
    ["nan", "NaN"],
    ["infinity", "Infinity"],
    ["negative-infinity", "-Infinity"],
    ["symbol", 'Symbol("fixture")'],
    ["function", "() => true"],
    ["toJSON-null", "({toJSON(){return null}})"],
    ["toJSON-undefined", "({toJSON(){return undefined}})"],
    ["bigint", "1n"],
    ["cyclic", "(()=>{const value={};value.self=value;return value})()"],
    ["throwing-toJSON", '({toJSON(){throw new Error("fixture")}})'],
  ]) {
    it(`rejects non-void serialization ${name} consistently in ${local ? "local" : "deployed"} mode`, async () => {
      const result = await exercise(`async () => ${expression}`, { local });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const errors = writes(result.seen, "error");
      expect(errors).toHaveLength(local ? 0 : 1);
      const error = JSON.parse(local ? result.stderr : (errors[0]?.body ?? ""));
      expect(error.type).toBe("ResultWriteError");
      expect(typeof error.message).toBe("string");
      expect(Buffer.byteLength(JSON.stringify(error.message))).toBeLessThanOrEqual(4096);
      expect(writes(result.seen, "result")).toHaveLength(0);
      if (local) expect(result.seen).toEqual([]);
    });
  }
  for (const expression of ["null", "undefined", "false", "0", '""']) {
    it(`preserves genuine void and JSON control ${expression} in ${local ? "local" : "deployed"} mode`, async () => {
      const result = await exercise(`async () => ${expression}`, { local });
      expect(result.code).toBe(0);
      const isVoid = expression === "null" || expression === "undefined";
      expect(result.stdout).toBe(local && !isVoid ? `${expression}\n` : "");
      expect(writes(result.seen, "result")).toHaveLength(!local && !isVoid ? 1 : 0);
      expect(writes(result.seen, "error")).toHaveLength(0);
    });
  }
  it(`serializes a non-void result once in ${local ? "local" : "deployed"} mode`, async () => {
    const result = await exercise(
      'async () => {let calls=0;return {toJSON(){if(++calls!==1)throw new Error("serialized twice");return {once:true};}};}',
      { local },
    );
    expect(result.code).toBe(0);
    expect(local ? result.stdout : writes(result.seen, "result")[0]?.body).toBe(
      local ? '{"once":true}\n' : '{"once":true}',
    );
    expect(writes(result.seen, "error")).toHaveLength(0);
  });
  for (const [name, setup, type, message] of [
    ["message-object", 'error.message={reason:"fixture"};', "Error", "[object Object]"],
    ["message-number", "error.message=42;", "Error", "42"],
    ["message-symbol", 'error.message=Symbol("fixture");', "Error", "Symbol(fixture)"],
    ["message-null", "error.message=null;", "Error", "null"],
    [
      "message-hostile",
      'error.message={[Symbol.toPrimitive](){throw new Error("blocked")}};',
      "Error",
      "error",
    ],
    [
      "message-getter",
      'Object.defineProperty(error,"message",{get(){throw new Error("blocked")}});',
      "Error",
      "error",
    ],
    [
      "type-object",
      'error.constructor={name:{toString(){return "TaggedFailure"}}};',
      "TaggedFailure",
      "ordinary failure",
    ],
    [
      "type-hostile",
      'error.constructor={name:{toString(){throw new Error("blocked")}}};',
      "Error",
      "ordinary failure",
    ],
    [
      "constructor-getter",
      'Object.defineProperty(error,"constructor",{get(){throw new Error("blocked")}});',
      "Error",
      "ordinary failure",
    ],
    [
      "stack-getter",
      'Object.defineProperty(error,"stack",{get(){throw new Error("blocked")}});',
      "Error",
      "ordinary failure",
    ],
  ] as const) {
    it(`reports bounded function error ${name} in ${local ? "local" : "deployed"} mode`, async () => {
      const result = await exercise(
        `async () => {const error=new Error("ordinary failure");error.stack="fixture";${setup}throw error;}`,
        { local },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const errors = writes(result.seen, "error");
      expect(errors).toHaveLength(local ? 0 : 1);
      const payload = JSON.parse(local ? result.stderr : (errors[0]?.body ?? ""));
      expect(payload.type).toBe(type);
      expect(payload.message).toBe(message);
      expect(Buffer.byteLength(JSON.stringify(payload.type))).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(JSON.stringify(payload.message))).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(JSON.stringify(payload.details))).toBeLessThanOrEqual(8192);
      expect(payload.details.stack.length).toBeLessThanOrEqual(20);
      expect(writes(result.seen, "result")).toHaveLength(0);
    });
  }
}
