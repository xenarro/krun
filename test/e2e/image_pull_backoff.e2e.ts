import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("image_pull_backoff");
beforeAll(() => h.up());
afterAll(() => h.close());
it("projects ImagePullBackOff while scheduled then enforces the real 60-second deadline", async () => {
  const created = await h.submit();
  const pending = await h.until(
    created,
    (run) => run.jobStatus?.reason === "ImagePullBackOff",
    50_000,
  );
  expect(pending.state).toBe("SCHEDULED");
  await h.jobExists(pending);
  const run = await h.terminal(created, "FAILED", 100_000);
  expect(run.failureReason).toBe("DEADLINE_EXCEEDED");
  await h.privacy();
});
