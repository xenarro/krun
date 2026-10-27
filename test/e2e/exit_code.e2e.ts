import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("exit_code");
beforeAll(() => h.up());
afterAll(() => h.close());
it("classifies exit 1 within ten seconds of native pod termination with logTail", async () => {
  const created = await h.submit();
  const run = await h.terminal(created, "FAILED");
  expect(run.failureReason).toBe("EXIT_CODE");
  expect(run.logTail).toContain("krun-e2e-exit-one");
  await h.exitedWithin(run, 1, 10_000);
  await h.privacy();
});
