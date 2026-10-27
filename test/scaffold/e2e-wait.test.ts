import { afterEach, beforeEach, expect, it, vi } from "vitest";

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

import { eventually } from "../e2e/lib/wait.js";

it("returns a positive witness rather than a truthy empty observation", async () => {
  expect(
    await eventually(
      async () => 7,
      (value) => (value === 7 ? "done" : "wait"),
      "witness",
      20,
    ),
  ).toBe(7);
});
it("fails immediately on a contradictory terminal state", async () => {
  let reads = 0;
  await expect(
    eventually(
      async () => {
        reads++;
        return "FAILED";
      },
      () => "fail",
      "terminal",
      100,
    ),
  ).rejects.toThrow("terminal reached an invalid state");
  expect(reads).toBe(1);
});
it("does not count a failed API read as an absent resource", async () => {
  await expect(
    eventually(
      async () => {
        now = 10;
        throw new Error("private remote value");
      },
      () => "done",
      "absence",
      2,
      1,
    ),
  ).rejects.toThrow("absence timed out after a read error");
});
it("does not echo a private read error into diagnostics", async () => {
  const result = await eventually(
    async () => {
      now = 10;
      throw new Error("private remote value");
    },
    () => "done",
    "safe",
    2,
    1,
  ).catch((error: Error) => error.message);
  expect(result).not.toContain("private remote value");
});
