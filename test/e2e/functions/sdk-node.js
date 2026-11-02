import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { run } from "@krun/sdk";

export async function handle(input, ctx) {
  await ctx.status("loading", 0.1);
  if (input?.action === "error") throw new Error("sdk-fixture-error");
  if (input?.action === "heartbeat") await setTimeout(75_000);
  return { rows: 42 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(handle);
}
