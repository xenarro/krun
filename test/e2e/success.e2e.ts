import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("success");
beforeAll(() => h.up());
afterAll(() => h.close());
it("round-trips input through the real Job and retains its accepted runtime status", async () => {
  const input = h.input();
  const created = await h.submit(input);
  const run = await h.terminal(created, "SUCCEEDED");
  h.equalOpaque(run.result, input, "Input/result round-trip differs");
  expect(run.runtimeStatus?.message).toBe("round-trip");
  expect(run.runtimeStatus?.progress).toBe(1);
  expect(run.runtimeStatus?.reportTime).toMatch(/^\d{4}-.*Z$/);
  expect(run.failureReason).toBeUndefined();
  await h.privacy();
});
