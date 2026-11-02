import { pathToFileURL } from "node:url";
import { run } from "@krun/sdk";

export async function handle(input, ctx) {
  await ctx.status("loading", 0.1);
  return { rows: 42 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(handle);
}
