import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("exit_code_status");
beforeAll(() => h.up());
afterAll(() => h.close());
it("retains two accepted statuses then classifies exit 3 within ten seconds", async () => {
  const created = await h.submit();
  const first = await h.until(created, (run) => run.runtimeStatus?.message === "first", 30_000);
  const run = await h.terminal(created, "FAILED");
  expect(run.failureReason).toBe("EXIT_CODE");
  expect(run.jobStatus?.exitCode).toBe(3);
  expect(run.runtimeStatus?.message).toBe("second");
  expect(Date.parse(run.runtimeStatus?.reportTime ?? "")).toBeGreaterThan(
    Date.parse(first.runtimeStatus?.reportTime ?? ""),
  );
  expect(run.logTail).toContain("krun-e2e-exit-three");
  await h.exitedWithin(run, 3, 10_000);
  await h.privacy();
});
