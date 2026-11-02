import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

export interface Context {
  readonly runId: string;
  readonly function: string;
  status(message: string, progress?: number, data?: Record<string, unknown>): Promise<void>;
  log(value: unknown): void;
}
export type Handler<Input = unknown, Output = unknown> = (
  input: Input,
  context: Context,
) => Output | Promise<Output>;

type Status = { message: string; progress?: number; data?: Record<string, unknown> };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const diagnostic = (message: string): void => {
  process.stderr.write(`${message}\n`);
};
const line = (value: unknown, local: boolean): void => {
  (local ? process.stderr : process.stdout).write(`${JSON.stringify(value)}\n`);
};
function truncate(value: string, limit: number): string {
  let used = 2;
  let prefix = "";
  for (const character of value) {
    const size = bytes(character) - 2;
    if (used + size > limit) break;
    prefix += character;
    used += size;
  }
  return prefix;
}
function statusPayload(message: string, progress?: number, data?: Record<string, unknown>): Status {
  const status: Status = { message: truncate(message || "status", 1024) };
  if (progress !== undefined) {
    if (Number.isFinite(progress) && progress >= 0 && progress <= 1) status.progress = progress;
    else diagnostic("status progress omitted: outside 0..1");
  }
  if (data !== undefined) {
    try {
      const encoded = JSON.stringify(data);
      const snapshot: unknown = JSON.parse(encoded);
      if (
        snapshot !== null &&
        typeof snapshot === "object" &&
        !Array.isArray(snapshot) &&
        Buffer.byteLength(encoded) <= 4096
      ) {
        // Measure and send the same detached snapshot, including toJSON effects.
        status.data = snapshot as Record<string, unknown>;
      } else diagnostic("status data omitted: invalid or above 4096 bytes");
    } catch {
      diagnostic("status data omitted: not JSON serializable");
    }
  }
  return status;
}
function errorText(read: () => unknown, fallback: string): string {
  try {
    return String(read()) || fallback;
  } catch {
    return fallback;
  }
}
function errorPayload(cause: unknown): {
  type: string;
  message: string;
  details: { stack: string[] };
} {
  try {
    const isError = cause instanceof Error;
    const type = isError ? errorText(() => cause.constructor.name, "Error") : "Error";
    const message = errorText(() => (isError ? cause.message : cause), "error");
    let stack: string[] = [];
    if (isError) {
      try {
        const raw = cause.stack;
        if (typeof raw === "string") stack = raw.split("\n").slice(0, 20);
      } catch {
        // A broken stack accessor must not discard the other error fields.
      }
    }
    const details = { stack };
    while (bytes(details) > 8192) details.stack.pop();
    return { type: truncate(type, 128), message: truncate(message, 4096), details };
  } catch {
    // Include field access, coercion and payload construction in the fallback.
    return { type: "Error", message: "function failed", details: { stack: [] } };
  }
}
class RequestFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`request rejected (HTTP ${status})`);
    this.status = status;
  }
}
class ResultWriteError extends Error {}
function serializeResult(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined && encoded !== "null") return encoded;
  } catch {
    // Local and deployed result failures share the same bounded error type.
  }
  throw new ResultWriteError("result is not a non-null JSON value");
}

async function request(
  url: string,
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
  timeout: number,
  retries: boolean,
  success: number,
  input = false,
  abort?: AbortSignal,
): Promise<unknown> {
  // Reject malformed URLs before the retry loop. Manual redirect handling
  // preserves the actual 3xx status without following a credentialed request.
  const endpoint = new URL(url);
  for (let attempt = 0; ; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const response = await fetch(endpoint, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: abort ? AbortSignal.any([timeoutSignal, abort]) : timeoutSignal,
      });
      // Cancellation is fatal on every call, including status and upload.
      if (response.status === 401) process.exit(1);
      if (response.status !== success) {
        await response.body?.cancel();
        throw new RequestFailure(response.status);
      }
      if (input) return await response.json();
      // Completion includes the response body, not only receipt of headers.
      await response.arrayBuffer();
      return undefined;
    } catch (cause) {
      const retryable =
        cause instanceof RequestFailure
          ? cause.status >= 500 && cause.status <= 599
          : cause instanceof TypeError ||
            (cause instanceof Error &&
              (cause.name === "TimeoutError" || cause.name === "AbortError"));
      if (!retries || !retryable || attempt === 3 || abort?.aborted) throw cause;
      await pause(1000 * 2 ** attempt);
    }
  }
}
function startHeartbeat(period: number, tick: () => void): () => void {
  let timer: ReturnType<typeof setInterval>;
  let closed = false;
  let deadline = performance.now() + period;
  const arm = () => {
    if (closed) return;
    // Node clamps delays above its signed 32-bit bound to one millisecond.
    // Re-arm bounded chunks against a monotonic deadline instead of pinging early.
    const delay = Math.min(2147483647, Math.max(1, Math.ceil(deadline - performance.now())));
    timer = setInterval(() => {
      clearInterval(timer);
      if (performance.now() >= deadline) {
        tick();
        deadline = performance.now() + period;
      }
      arm();
    }, delay);
    timer.unref();
  };
  arm();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

class StatusGate {
  private latest = '{"message":"started"}';
  private pending = false;
  private busy = false;
  private closed = false;
  private nextSlot = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<() => void>();
  private readonly abort = new AbortController();
  private readonly send: (body: string, abort: AbortSignal) => Promise<unknown>;
  constructor(send: (body: string, abort: AbortSignal) => Promise<unknown>) {
    this.send = send;
  }
  status(message: string, progress?: number, data?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.latest = JSON.stringify(statusPayload(message, progress, data));
    } catch {
      diagnostic("status omitted: invalid payload");
      return Promise.resolve();
    }
    // A queued call never blocks its caller beyond three seconds. Its latest
    // payload may remain pending until a slot, or until the terminal call returns.
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(bound);
        this.waiters.delete(done);
        resolve();
      };
      const bound = setTimeout(done, 3000);
      this.waiters.add(done);
      this.pending = true;
      this.schedule();
    });
  }
  tick(): void {
    if (!this.closed) {
      this.pending = true;
      this.schedule();
    }
  }
  close(): void {
    this.closed = true;
    this.pending = false;
    clearTimeout(this.timer);
    this.abort.abort();
    for (const done of this.waiters) done();
    this.waiters.clear();
  }
  private schedule(): void {
    if (this.closed || this.busy || !this.pending || this.timer) return;
    const delay = this.nextSlot - performance.now();
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, Math.ceil(delay));
      this.timer.unref();
      return;
    }
    this.busy = true;
    this.pending = false;
    const waiters = [...this.waiters];
    this.waiters.clear();
    void this.attempt(this.latest, waiters);
  }
  private async attempt(body: string, waiters: (() => void)[]): Promise<void> {
    try {
      await this.send(body, this.abort.signal);
    } catch (cause) {
      if (!this.closed) {
        if (cause instanceof RequestFailure && cause.status === 429) this.pending = true;
        diagnostic(
          cause instanceof RequestFailure
            ? `status dropped (HTTP ${cause.status})`
            : "status dropped: request failed or timed out",
        );
      }
    } finally {
      this.nextSlot = performance.now() + 1000;
      this.busy = false;
      for (const done of waiters) done();
      this.schedule();
    }
  }
}
async function exit(code: number): Promise<never> {
  // Drain output before terminating; large local results must not be cut off.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.write("", () => resolve());
        }),
    ),
  );
  process.exit(code);
}

export async function run<Input = unknown, Output = unknown>(
  handler: Handler<Input, Output>,
): Promise<never> {
  process.once("SIGTERM", () => process.exit(1));
  const runId = process.env.KRUN_RUN_ID;
  const functionName = process.env.KRUN_FUNCTION;
  const gateway = process.env.KRUN_GATEWAY_URL;
  const token = process.env.KRUN_TOKEN;
  const maximum = process.env.KRUN_MAX_RESULT_BYTES;
  const heartbeatWindow = process.env.KRUN_HEARTBEAT_TIMEOUT;
  const upload = process.env.KRUN_RESULT_UPLOAD_URL;
  if (!gateway) {
    try {
      const input = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8")) as Input;
      const context: Context = {
        runId: runId ?? "local",
        function: functionName ?? basename(process.argv[1] ?? "local"),
        status: async (message, progress, data) => {
          line(statusPayload(message, progress, data), true);
        },
        log: (value) => line(value, true),
      };
      const value = await handler(input, context);
      if (value !== null && value !== undefined)
        process.stdout.write(`${serializeResult(value)}\n`);
      return await exit(0);
    } catch (cause) {
      line(errorPayload(cause), true);
      return await exit(1);
    }
  }
  if (!runId || !functionName || !token) {
    diagnostic("missing required krun run environment");
    return await exit(1);
  }
  const version = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  const headers = {
    authorization: `Bearer ${token}`,
    "user-agent": `krun-sdk-node/${version}`,
    "content-type": "application/json",
  };
  const base = `${gateway.replace(/\/$/, "")}/internal/v1/runs/${encodeURIComponent(runId)}`;
  const gate = new StatusGate((body, abort) =>
    request(`${base}/status`, "POST", body, headers, 3000, false, 204, false, abort),
  );
  const seconds = Number(heartbeatWindow);
  const stopHeartbeat =
    heartbeatWindow && Number.isFinite(seconds) && seconds > 0
      ? startHeartbeat((seconds * 1000) / 3, () => gate.tick())
      : () => {};
  let code = 1;
  const report = async (cause: unknown) => {
    try {
      await request(
        `${base}/error`,
        "PUT",
        JSON.stringify(errorPayload(cause)),
        headers,
        10_000,
        true,
        204,
      );
    } catch {
      diagnostic("error report failed");
    }
  };
  try {
    let input: Input;
    try {
      input = (await request(
        `${base}/input`,
        "GET",
        undefined,
        headers,
        10_000,
        true,
        200,
        true,
      )) as Input;
    } catch {
      diagnostic("input request failed");
      gate.close();
      stopHeartbeat();
      return await exit(1);
    }
    let value: Output;
    try {
      value = await handler(input, {
        runId,
        function: functionName,
        status: (message, progress, data) => gate.status(message, progress, data),
        log: (entry) => line(entry, false),
      });
    } catch (cause) {
      diagnostic("handler failed");
      await report(cause);
      return await finish(1);
    }
    if (value !== null && value !== undefined) {
      try {
        const body = serializeResult(value);
        const cap =
          maximum && /^\d+$/.test(maximum) && Number.isSafeInteger(Number(maximum))
            ? Number(maximum)
            : 262144;
        const length = Buffer.byteLength(body);
        if (length <= cap) await request(`${base}/result`, "PUT", body, headers, 10_000, true, 204);
        else if (upload)
          await request(
            upload,
            "PUT",
            body,
            {
              "content-type": "application/json",
              "content-length": String(length),
              "user-agent": headers["user-agent"],
            },
            300_000,
            true,
            200,
          );
        else throw new ResultWriteError("result exceeds the inline cap without an upload URL");
      } catch (cause) {
        // Do not include fetch errors, URLs, response bodies or credentials in diagnostics.
        const failure = new ResultWriteError(
          cause instanceof RequestFailure
            ? `result write rejected (HTTP ${cause.status})`
            : "result serialization or write failed",
        );
        diagnostic(failure.message);
        await report(failure);
        return await finish(1);
      }
    }
    code = 0;
  } finally {
    gate.close();
    stopHeartbeat();
  }
  return await exit(code);
  async function finish(result: number): Promise<never> {
    gate.close();
    stopHeartbeat();
    return await exit(result);
  }
}
