import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

type Barrier = { route: string; count: number };
type Reply = { status?: number; hang?: boolean; until?: Barrier };
type Expected = { method: string; path: string; target: string; body?: unknown };
type Seen = Expected & {
  rawBytes: number;
  at: number;
  respondedAt?: number;
  authorized: boolean;
  agent: string;
  length?: string;
  contentType?: string;
  chunked: boolean;
  checksum: boolean;
};
type Scenario = {
  name: string;
  handler: string;
  input: unknown;
  env: Record<string, string>;
  responses: Record<string, Reply[]>;
  upload?: boolean;
  releaseHandlerAfter?: Barrier;
  expect: {
    requests: Expected[];
    exitCode: number;
    minGapMs?: number[][];
    during?: number[][];
    sinceStartMs?: number[][];
  };
};
const directory = new URL("./", import.meta.url);
const root = new URL("../../", directory);
const runId = "019a0000-0000-7000-8000-000000000001";
const table: Scenario[] = JSON.parse(readFileSync(new URL("scenarios.json", directory), "utf8"));
const version: string = JSON.parse(
  readFileSync(new URL("sdk/node/package.json", root), "utf8"),
).version;

function matches(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && "$stack" in expected) {
    const rule = expected.$stack as { minLines: number; maxLines: number; detailsBytesMax: number };
    if (!actual || typeof actual !== "object" || !("stack" in actual)) return false;
    const stack = actual.stack;
    return (
      Object.keys(actual).length === 1 &&
      Array.isArray(stack) &&
      stack.every((line) => typeof line === "string") &&
      stack.length >= rule.minLines &&
      stack.length <= rule.maxLines &&
      Buffer.byteLength(JSON.stringify(actual)) <= rule.detailsBytesMax
    );
  }
  if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected)
  ) {
    const left = expected as Record<string, unknown>,
      right = actual as Record<string, unknown>;
    return (
      isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort()) &&
      Object.entries(left).every(([key, value]) => matches(value, right[key]))
    );
  }
  return isDeepStrictEqual(expected, actual);
}
function check(
  scenario: Scenario,
  seen: Seen[],
  code: number | null,
  start: number,
  language: string,
) {
  assert.equal(code, scenario.expect.exitCode, "SDK exit mismatch");
  assert.equal(seen.length, scenario.expect.requests.length, "request count mismatch");
  for (const [index, expected] of scenario.expect.requests.entries()) {
    const actual = seen[index];
    assert.ok(actual, `missing request ${index}`);
    assert.ok(
      actual.method === expected.method &&
        actual.path === expected.path &&
        actual.target === expected.target,
      `request order mismatch at ${index}`,
    );
    assert.ok(matches(expected.body, actual.body), `body mismatch at request ${index}`);
    assert.ok(actual.authorized, `authorization mismatch at ${index}`);
    assert.equal(
      actual.agent,
      `krun-sdk-${language}/${version}`,
      `user agent mismatch at ${index}`,
    );
    if (
      actual.target === "internal" &&
      (actual.method !== "GET" || actual.contentType !== undefined)
    ) {
      const media = actual.contentType?.split(";")[0]?.trim().toLowerCase();
      assert.equal(media, "application/json", `content type mismatch at ${index}`);
    }
    if (actual.target === "upload") {
      assert.equal(actual.contentType, "application/json");
      assert.equal(actual.length, String(actual.rawBytes), "upload content length mismatch");
      assert.ok(!actual.chunked && !actual.checksum, "upload framing mismatch");
    }
  }
  for (const [first, second, minimum] of scenario.expect.minGapMs ?? []) {
    assert.ok(first !== undefined && second !== undefined && minimum !== undefined);
    assert.ok(
      (seen[second]?.at ?? -Infinity) - (seen[first]?.at ?? Infinity) >= minimum,
      "request gap too short",
    );
  }
  for (const [pending, ping] of scenario.expect.during ?? []) {
    assert.ok(pending !== undefined && ping !== undefined);
    const response = seen[pending],
      heartbeat = seen[ping];
    assert.ok(response && heartbeat && response.respondedAt !== undefined);
    assert.ok(
      response.at < heartbeat.at && heartbeat.at < response.respondedAt,
      "heartbeat was not during pending I/O",
    );
  }
  for (const [index, minimum] of scenario.expect.sinceStartMs ?? []) {
    assert.ok(index !== undefined && minimum !== undefined);
    assert.ok((seen[index]?.at ?? -Infinity) - start >= minimum, "eager heartbeat");
  }
}
function selfTest() {
  const request: Seen = {
    method: "GET",
    path: "/input",
    target: "internal",
    rawBytes: 0,
    at: 0,
    authorized: true,
    agent: `krun-sdk-node/${version}`,
    chunked: false,
    checksum: false,
  };
  const result: Seen = {
    ...request,
    method: "PUT",
    path: "/result",
    body: { rows: 42 },
    contentType: "application/json",
    at: 1000,
  };
  const scenario: Scenario = {
    name: "self-test",
    handler: "echo",
    input: {},
    env: {},
    responses: {},
    expect: {
      requests: [
        { method: "GET", path: "/input", target: "internal" },
        { method: "PUT", path: "/result", target: "internal", body: { rows: 42 } },
      ],
      exitCode: 0,
    },
  };
  check(scenario, [request, result], 0, 0, "node");
  for (const seen of [
    [result, request],
    [request],
    [request, result, result],
    [request, { ...result, body: { rows: 0 } }],
    [{ ...request, authorized: false }, result],
    [request, { ...result, body: { rows: 42, extra: true } }],
  ])
    assert.throws(() => check(scenario, seen, 0, 0, "node"));
  assert.throws(() => check(scenario, [request, result], 1, 0, "node"));
  // Wire framing uses received bytes; equivalent JSON spellings need not have equal sizes.
  const uploadScenario: Scenario = {
    ...scenario,
    expect: {
      requests: [{ method: "PUT", path: "/upload", target: "upload", body: { n: 1e-7 } }],
      exitCode: 0,
    },
  };
  for (const raw of ['{"n":1e-7}', '{"n":1e-07}', '{ "n": 0.0000001 }']) {
    const buffer = Buffer.from(raw, "utf8");
    const upload: Seen = {
      ...result,
      path: "/upload",
      target: "upload",
      body: JSON.parse(raw),
      rawBytes: buffer.length,
      length: String(buffer.length),
    };
    check(uploadScenario, [upload], 0, 0, "node");
    assert.throws(() =>
      check(uploadScenario, [{ ...upload, length: String(buffer.length + 1) }], 0, 0, "node"),
    );
  }
  for (const contentType of [undefined, "", "text/plain", "application/jsonp"]) {
    const invalid = { ...result };
    if (contentType === undefined) delete invalid.contentType;
    else invalid.contentType = contentType;
    assert.throws(() => check(scenario, [request, invalid], 0, 0, "node"));
  }
  assert.throws(() =>
    check(scenario, [{ ...request, contentType: "text/plain" }, result], 0, 0, "node"),
  );
  check(scenario, [request, result], 0, 0, "node"); // Missing GET media is permitted.
  for (const contentType of [
    "application/json",
    "Application/JSON; charset=UTF-8",
    " application/json ; charset=utf-8",
  ]) {
    check(
      scenario,
      [
        { ...request, contentType },
        { ...result, contentType },
      ],
      0,
      0,
      "node",
    );
  }
  const bounded = { $stack: { minLines: 1, maxLines: 20, detailsBytesMax: 8192 } };
  assert.ok(matches(bounded, { stack: ["frame"] }));
  for (const value of [
    { stack: [] },
    { stack: [2] },
    { stack: Array(21).fill("frame") },
    { stack: ["x".repeat(8192)] },
    { stack: ["frame"], extra: 0 },
    {},
  ])
    assert.ok(!matches(bounded, value));
  console.log(JSON.stringify({ ok: true, matcherNegativeControls: true }));
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function exercise(scenario: Scenario, language: string, python: string, mutation: string) {
  const token = randomBytes(32).toString("base64url");
  const seen: Seen[] = [];
  const completed = new Map<string, number>();
  const pending: (() => void)[] = [];
  const counts = new Map<string, number>();
  let child: ChildProcess | undefined;
  let released = false;
  let fault: Error | undefined;
  const ready = (barrier: Barrier) => (completed.get(barrier.route) ?? 0) >= barrier.count;
  const notify = () => {
    for (const resume of [...pending]) resume();
    if (!released && scenario.releaseHandlerAfter && ready(scenario.releaseHandlerAfter)) {
      released = true;
      child?.stdin?.end("release\n");
    }
  };
  const fake = (target: string) =>
    createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        const raw = buffer.toString("utf8");
        const path = (request.url ?? "").replace(runId, "{run}");
        const method = request.method ?? "";
        const key = `${method} ${target === "upload" ? "upload" : path.split("/").at(-1)}`;
        const call: Seen = {
          method,
          path,
          target,
          rawBytes: buffer.length,
          at: performance.now(),
          authorized:
            target === "internal"
              ? request.headers.authorization === `Bearer ${token}`
              : request.headers.authorization === undefined,
          agent: request.headers["user-agent"] ?? "",
          chunked: request.headers["transfer-encoding"] !== undefined,
          checksum: Object.keys(request.headers).some((key) => key.startsWith("x-amz-checksum")),
          ...(raw ? { body: JSON.parse(raw) } : {}),
          ...(request.headers["content-length"]
            ? { length: request.headers["content-length"] }
            : {}),
          ...(request.headers["content-type"] !== undefined
            ? { contentType: request.headers["content-type"] }
            : {}),
        };
        seen.push(call);
        const index = counts.get(key) ?? 0;
        counts.set(key, index + 1);
        const choices = scenario.responses[key];
        const reply = choices?.[Math.min(index, choices.length - 1)] ?? {
          status: key === "GET input" || target === "upload" ? 200 : 204,
        };
        response.once("finish", () => {
          call.respondedAt = performance.now();
          completed.set(key, (completed.get(key) ?? 0) + 1);
          notify();
        });
        if (reply.hang) return;
        const send = () => {
          const status = reply.status ?? 204;
          const body = key === "GET input" && status === 200 ? JSON.stringify(scenario.input) : "";
          response
            .writeHead(status, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            })
            .end(body);
        };
        if (reply.until && !ready(reply.until)) {
          const barrier = reply.until;
          const resume = () => {
            if (ready(barrier)) {
              pending.splice(pending.indexOf(resume), 1);
              send();
            }
          };
          pending.push(resume);
        } else send();
      } catch {
        fault = new Error("HTTP fake failed to read a request");
        response.destroy();
      }
    });
  const servers = [fake("internal"), fake("upload")];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let stdout = "",
    stderr = "";
  const stop = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const cancel = () => {
    forced = true;
    stop("SIGTERM");
    escalation ??= setTimeout(() => stop("SIGKILL"), 2000);
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const [url, upload] = await Promise.all(servers.map(listen));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("KRUN_") && key !== "NODE_OPTIONS" && key !== "PYTHONPATH",
      ),
    );
    Object.assign(env, scenario.env, {
      KRUN_GATEWAY_URL: url,
      KRUN_RUN_ID: runId,
      KRUN_FUNCTION: "krun-test-sdk-conformance",
      KRUN_TOKEN: token,
      KRUN_MAX_RESULT_BYTES: scenario.env.KRUN_MAX_RESULT_BYTES ?? "262144",
      PYTHONPATH: fileURLToPath(new URL("sdk/python", root)),
    });
    if (scenario.upload) env.KRUN_RESULT_UPLOAD_URL = `${upload}/upload`;
    const executable = language === "node" ? process.execPath : python;
    const args =
      language === "node"
        ? [
            fileURLToPath(new URL("fixture-node.ts", directory)),
            new URL("sdk/node/dist/index.js", root).href,
            scenario.handler,
            mutation,
          ]
        : [
            fileURLToPath(new URL("sdk/python/tests/conformance_handler.py", root)),
            scenario.handler,
            mutation,
          ];
    const start = performance.now();
    child = spawn(executable, args, {
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child?.once("error", reject);
      child?.once("close", resolve);
    });
    deadline = setTimeout(cancel, 45_000);
    const code = await done;
    assert.ok(!forced, "SDK child exceeded conformance deadline");
    assert.ok(!fault, "HTTP fake failure");
    assert.ok(
      !stdout.includes(token) && !stderr.includes(token),
      "credential leaked in SDK output",
    );
    check(scenario, seen, code, start, language);
    return { ok: true, scenario: scenario.name, requests: seen.length, exitCode: code };
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    stop("SIGKILL");
    pending.length = 0;
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }
}
const [, , language, name, python = "", mutation = "none"] = process.argv;
try {
  assert.ok(language === "node" || language === "python", "invalid SDK language");
  if (name === "--self-test") selfTest();
  else {
    const scenario = table.find((value) => value.name === name);
    assert.ok(scenario, "unknown scenario");
    console.log(JSON.stringify(await exercise(scenario, language, python, mutation)));
  }
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      failure: error instanceof Error ? error.message.split("\n")[0] : "conformance failed",
    }),
  );
  process.exitCode = 1;
}
