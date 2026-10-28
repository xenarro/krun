import { afterAll, beforeAll, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("large_result");
beforeAll(() => h.up());
afterAll(() => h.close());
it("uploads one MiB from the isolated Job and downloads raw bytes through the real public 307", async () => {
  const input = h.input();
  const created = await h.submit(input);
  const run = await h.terminal(created, "SUCCEEDED");
  await h.largeResult(run, input);
  await h.privacy();
});
