import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

for (const language of ["node", "python"] as const)
  describe(language, () => {
    const h = scenario(`sdk_${language}_heartbeat`);
    beforeAll(() => h.up());
    afterAll(() => h.close());
    it("remains RUNNING beyond its heartbeat window through automatic SDK reports", async () => {
      const created = await h.submit({ ...h.input(), action: "heartbeat" });
      const first = await h.until(
        created,
        (run) => run.state === "RUNNING" && run.runtimeStatus?.message === "loading",
      );
      await h.jobExists(first);
      const initialReport = Date.parse(first.runtimeStatus?.reportTime ?? "");
      expect(Number.isFinite(initialReport)).toBe(true);
      const alive = await h.until(
        created,
        (run) =>
          run.state === "RUNNING" &&
          Date.parse(run.runtimeStatus?.reportTime ?? "") - initialReport >= 30_000,
      );
      expect(alive.runtimeStatus).toMatchObject({ message: "loading", progress: 0.1 });
      await h.jobExists(alive);
      const run = await h.terminal(created, "SUCCEEDED");
      expect(run.result).toEqual({ rows: 42 });
      expect(run.failureReason).toBeUndefined();
      await h.privacy();
    });
  });
