import { afterAll, beforeAll, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("webhook");
beforeAll(() => h.up());
afterAll(() => h.close());
it("retries one native signed delivery after 500 with stable identity and both rotation signatures", async () => {
  const input = h.input();
  const created = await h.submit(input, { callback: true });
  const run = await h.terminal(created, "SUCCEEDED");
  h.equalOpaque(run.result, input, "Callback Run did not retain its inline result");
  await h.deliveries(run);
  await h.privacy();
});
