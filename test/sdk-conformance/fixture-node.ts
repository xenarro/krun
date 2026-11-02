import { createInterface } from "node:readline";
import type { Context } from "../../sdk/node/src/index.js";

const [, , sdk, handler, mutation] = process.argv;
if (!sdk) throw new Error("missing SDK entry");
const { run } = await import(sdk);
// Intentional wire mutations in this fixture process only; SDK source is untouched.
if (mutation?.startsWith("media-")) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, options = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(options.headers);
    const method = options.method ?? "GET";
    if (new URL(url).pathname.startsWith("/internal/")) {
      if (
        (mutation === "media-writes" && method !== "GET") ||
        (mutation === "media-get" && method === "GET")
      )
        headers.set("content-type", "text/plain");
      if (mutation === "media-empty-get" && method === "GET") headers.set("content-type", "");
      if (mutation === "media-parameters")
        headers.set("content-type", "Application/JSON; charset=UTF-8");
      if (mutation === "media-omit") headers.delete("content-type");
    }
    return original(input, { ...options, headers });
  };
}
const lines = createInterface({ input: process.stdin });
const released = new Promise<void>((resolve) => lines.once("line", () => resolve()));
await run(async (input: Record<string, unknown>, ctx: Context) => {
  switch (handler) {
    case "echo":
      return input;
    case "void":
      return undefined;
    case "status_then_heartbeat":
      await ctx.status("loading", 0.1);
      await released;
      return { rows: 42 };
    case "two_status": {
      const messages = mutation === "swap-statuses" ? ["second", "first"] : ["first", "second"];
      await Promise.all(messages.map((message) => ctx.status(message)));
      return { rows: 42 };
    }
    case "slow_result":
      await ctx.status("loading", 0.1);
      return { rows: 42 };
    case "status_input":
      await ctx.status(
        input.message as string,
        input.progress as number,
        input.data as Record<string, unknown>,
      );
      return undefined;
    case "wait_void":
      await released;
      return undefined;
    case "throws": {
      class SharedError extends Error {}
      Object.defineProperty(SharedError, "name", { value: input.type });
      throw new SharedError(input.message as string);
    }
    default:
      throw new Error("unknown conformance handler");
  }
});
