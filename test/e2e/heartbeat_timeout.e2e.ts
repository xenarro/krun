import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("heartbeat_timeout");
beforeAll(() => h.up());
afterAll(() => h.close());
it("fails a silent running Job within sixty seconds after its one accepted heartbeat", async () => {
  const created = await h.submit();
  const active = await h.until(
    created,
    (run) => run.state === "RUNNING" && run.runtimeStatus?.message === "alive",
    30_000,
  );
  await h.jobExists(active);
  const run = await h.terminal(created, "FAILED", 60_000);
  expect(run.failureReason).toBe("HEARTBEAT_TIMEOUT");
  expect(run.logTail).toContain("krun-e2e-heartbeat-silent");
  await h.jobGone(run);
  h.withinReportDeadline(run, 60_000);
  await h.privacy();
});
