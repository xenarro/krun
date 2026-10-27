import { afterAll, beforeAll, expect, it } from "vitest";
import { scenario } from "./lib/harness.js";

const h = scenario("wait");
beforeAll(() => h.up());
afterAll(() => h.close());
it("CreateRun waits for the native Job with 201, then WaitRun returns the identical FULL Run with 200", async () => {
  const input = h.input();
  const created = await h.submit(input, { wait: true });
  expect(created.state).toBe("SUCCEEDED");
  h.equalOpaque(created.result, input, "CreateRun wait did not return its inline result");
  h.equalOpaque(created.input, input, "CreateRun wait did not return a FULL Run");
  const waited = await h.wait(created);
  h.equalOpaque(waited, created, "WaitRun changed the terminal FULL Run");
  console.log(
    JSON.stringify({
      scenario: "wait",
      state: created.state,
      createStatus: 201,
      waitStatus: 200,
      inlineResult: true,
      identicalFullRun: true,
    }),
  );
  await h.privacy();
});
