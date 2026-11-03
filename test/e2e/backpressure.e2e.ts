import { afterEach, beforeEach, it } from "vitest";
import { scenario } from "./lib/harness.js";

// Runner retries get fresh ownership and cleanup, never a second admission
// sequence against the previous attempt's accepted Runs or closed observers.
let h: ReturnType<typeof scenario>;
beforeEach(async () => {
  h = scenario("backpressure");
  await h.up();
});
afterEach(() => h.close());
it("enforces Function/key queue caps, native concurrency and retryable quota pressure", async () => {
  await h.backpressure();
  await h.privacy();
});
