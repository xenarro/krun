import { expect, it } from "vitest";
import { podSchema } from "../e2e/lib/pod.js";

const pod = (terminated: unknown) => ({
  metadata: { name: "krun-test-pod", labels: {} },
  spec: { automountServiceAccountToken: false, containers: [{ name: "function", env: [] }] },
  status: { containerStatuses: [{ name: "function", state: { terminated } }] },
});
it("accepts native never-started container timestamps without inventing an exit time", () => {
  expect(podSchema.safeParse(pod({ exitCode: 137, finishedAt: null })).success).toBe(true);
  expect(podSchema.safeParse(pod({ exitCode: 137 })).success).toBe(true);
});
it("retains a real native finishedAt for the ten-second exit witness", () => {
  const time = "2026-10-27T12:00:00.123456Z";
  expect(
    podSchema.parse(pod({ exitCode: 3, finishedAt: time })).status?.containerStatuses?.[0]?.state
      .terminated?.finishedAt,
  ).toBe(time);
});
