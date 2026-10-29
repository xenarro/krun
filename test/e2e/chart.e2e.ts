import { afterAll, beforeAll, expect, it } from "vitest";
import { chartAcceptance } from "./lib/chart-harness.js";
import { scenario } from "./lib/harness.js";

const chart = chartAcceptance();
const run = scenario("success", chart.client);
beforeAll(async () => {
  await chart.start();
  await run.up();
});
afterAll(async () => {
  try {
    await run.close();
  } finally {
    await chart.close();
  }
});

it("enforces the chart's actual internal/public/admin and MinIO data-plane policies", async () => {
  await chart.policies();
});

it("rejects a hand-created tag-only Job through the installed digest admission policy", () => {
  chart.admission();
});

it("upgrades and rolls back Ready chart workloads with successful Runs and real scheduler handover", async () => {
  const input = run.input();
  const retained = await run.terminal(await run.submit(input), "SUCCEEDED");
  await run.privacy();
  let original = await chart.waitReady();
  let elected = chart.mode === "postgres" ? await chart.leader() : undefined;
  const originalHook = chart.mode === "postgres" ? chart.hook() : undefined;
  for (const operation of ["upgrade", "rollback"] as const) {
    const oldUids = new Set(original.map((pod) => pod.metadata.uid));
    const started = performance.now();
    const change = chart.change(operation);
    let during: Awaited<ReturnType<typeof run.submit>> | undefined;
    if (chart.mode === "postgres") {
      await chart.rolling(oldUids, change.active);
      expect(change.active()).toBe(true);
      during = await run.submit(run.input());
    }
    await change.done;
    original = await chart.waitReady(oldUids);
    expect(original.every((pod) => !oldUids.has(pod.metadata.uid))).toBe(true);
    chart.assertLogLevel(operation === "upgrade" ? "debug" : "info");
    if (during) await run.terminal(during, "SUCCEEDED");
    await run.terminal(await run.submit(run.input()), "SUCCEEDED");
    const readback = await run.get(retained);
    run.equalOpaque(readback, retained, "Stored pre-upgrade Run changed across chart lifecycle");
    let handoverUpperBoundMs: number | undefined;
    if (chart.mode === "postgres") {
      const next = await chart.leader(oldUids);
      if (!next || !elected || !originalHook)
        throw new Error("Missing native leader or migration witness");
      expect(next.leaseUid).toBe(elected.leaseUid);
      expect(next.holder).not.toBe(elected.holder);
      expect(next.gauges.map((g) => g.value).sort()).toEqual([0, 1]);
      elected = next;
      handoverUpperBoundMs = Math.ceil(performance.now() - started);
      expect(handoverUpperBoundMs).toBeLessThan(86400 * 1000);
      if (operation === "upgrade")
        expect(Date.parse(chart.hook().started_at)).toBeGreaterThan(
          Date.parse(originalHook.started_at),
        );
    }
    await run.privacy();
    console.log(
      JSON.stringify({
        scenario: "chart",
        mode: chart.mode,
        operation,
        targetRevision: operation === "rollback" ? 1 : 2,
        ready: true,
        newPodUids: true,
        runAfterChangeSucceeded: true,
        retainedPreUpgradeRunReadable: true,
        ...(chart.mode === "postgres"
          ? {
              runSubmittedDuringActualRolloutSucceeded: true,
              oneLeaderWithMatchingLease: true,
              holderAndGaugeMovedToNewPod: true,
              sameLeaseUid: true,
              handoverUpperBoundMs,
              ...(operation === "upgrade" ? { migrateHookExecuted: true } : {}),
            }
          : {}),
      }),
    );
  }
});
