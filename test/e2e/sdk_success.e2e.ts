import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

for (const language of ["node", "python"] as const)
  describe(language, () => {
    const h = scenario(`sdk_${language}_success`);
    beforeAll(() => h.up());
    afterAll(() => h.close());
    it("runs the vendored SDK template to an exact inline result", async () => {
      const run = await h.terminal(await h.submit(h.input()), "SUCCEEDED");
      expect(run.result).toEqual({ rows: 42 });
      expect(run.failureReason).toBeUndefined();
      await h.privacy();
    });
  });
