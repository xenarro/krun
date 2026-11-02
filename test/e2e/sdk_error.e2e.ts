import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

for (const language of ["node", "python"] as const)
  describe(language, () => {
    const h = scenario(`sdk_${language}_error`);
    beforeAll(() => h.up());
    afterAll(() => h.close());
    it("reports a thrown handler error as FUNCTION before native exit 1", async () => {
      const run = await h.terminal(await h.submit({ ...h.input(), action: "error" }), "FAILED");
      expect(run.failureReason).toBe("EXIT_CODE");
      expect(run.error?.source).toBe("FUNCTION");
      expect(run.error?.message).toBe("sdk-fixture-error");
      expect(run.error?.type).toBe(language === "node" ? "Error" : "RuntimeError");
      expect(run.logTail).toContain("handler failed");
      await h.exitedWithin(run, 1, 10_000);
      await h.privacy();
    });
  });
