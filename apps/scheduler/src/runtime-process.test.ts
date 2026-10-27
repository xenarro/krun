import { expect, it } from "vitest";
import {
  schedulerUntil,
  startSchedulerProcess,
} from "../../../test/fake-kube/scheduler-process.js";

const image = process.env.KRUN_TEST_SCHEDULER_IMAGE;

it("standby serves liveness and gated readiness,never starts leader resources,and shuts down", async () => {
  const process = await startSchedulerProcess({ image, standby: true, holdFunctions: true });
  try {
    await schedulerUntil(async () => (await process.response("/healthz"))?.status === 200);
    expect((await process.response("/readyz"))?.status).toBe(503);
    expect(process.kube.events.some((event) => /jobs|pods|secrets|PATCH/.test(event))).toBe(false);
    process.kube.releaseFunctions();
    await schedulerUntil(async () => (await process.response("/readyz"))?.status === 200);
    expect(await (await process.response("/readyz"))?.json()).toEqual({
      status: "ok",
      leader: false,
    });
    expect((await process.response("/v1/functions"))?.status).toBe(404);
    const metrics = await (await process.response("/metrics"))?.text();
    expect(metrics).toContain("krun_scheduler_leader 0");
    expect(metrics).toContain("krun_functions_synced 1");
    expect(await process.stop()).toEqual({ code: 0, signal: null });
    expect(process.kube.snapshot().holder).toBe("krun-test-other-scheduler");
    expect(process.kube.snapshot().watches).toBe(0);
  } finally {
    await process.close();
  }
}, 20000);

it("leader gates claiming on both initial LISTs,completes a real stored run,and releases after watches", async () => {
  const process = await startSchedulerProcess({ image, holdJobs: true, seed: true });
  try {
    await schedulerUntil(async () => (await process.response("/readyz"))?.status === 200);
    await schedulerUntil(() => process.kube.snapshot().holder === "krun-test-scheduler-pod");
    expect(await process.state()).toBe("queued");
    expect(process.kube.snapshot().jobs).toBe(0);
    process.kube.releaseJobLists();
    await schedulerUntil(() => process.kube.snapshot().jobs === 1);
    process.kube.complete();
    await schedulerUntil(async () => (await process.state()) === "succeeded");
    await schedulerUntil(
      () => process.kube.snapshot().jobs === 0 && process.kube.snapshot().secrets === 0,
    );
    const metrics = await (await process.response("/metrics"))?.text();
    expect(metrics).toContain("krun_scheduler_leader 1");
    expect(metrics).toContain('to="succeeded"');
    expect(await process.stop()).toEqual({ code: 0, signal: null });
    expect(process.kube.snapshot().holder).toBe("");
    expect(process.kube.events).toContain("lease-cleared:watches=0");
  } finally {
    await process.close();
  }
}, 20000);

it("leader loss terminates nonzero,stops watches,and never clears a successor Lease", async () => {
  const process = await startSchedulerProcess({ image });
  try {
    await schedulerUntil(() => process.kube.snapshot().holder === "krun-test-scheduler-pod");
    await schedulerUntil(() => process.kube.snapshot().watches === 3);
    process.kube.steal();
    expect(await process.exited).toEqual({ code: 1, signal: null });
    expect(process.kube.snapshot().holder).toBe("krun-test-other-scheduler");
    expect(process.kube.snapshot().watches).toBe(0);
    expect(process.kube.events.some((event) => event.startsWith("lease-cleared:"))).toBe(false);
  } finally {
    await process.close();
  }
}, 20000);

it("standby readiness fails on a real database error without sacrificing liveness", async () => {
  const process = await startSchedulerProcess({ image, standby: true });
  try {
    await schedulerUntil(async () => (await process.response("/readyz"))?.status === 200);
    await process.breakStore();
    expect((await process.response("/readyz"))?.status).toBe(503);
    expect((await process.response("/healthz"))?.status).toBe(200);
    expect(await process.stop()).toEqual({ code: 0, signal: null });
  } finally {
    await process.close();
  }
}, 20000);

it("configured result storage without its later adapter never fabricates terminal success", async () => {
  const process = await startSchedulerProcess({ image, seed: true, configuredStorage: true });
  try {
    await schedulerUntil(() => process.kube.snapshot().jobs === 1);
    process.kube.complete();
    await schedulerUntil(() => process.output().includes("ResultCheckError"));
    expect(await process.state()).toBe("scheduled");
    expect(process.kube.snapshot().jobs).toBe(1);
    expect(await process.stop()).toEqual({ code: 0, signal: null });
    expect(process.kube.snapshot().holder).toBe("");
  } finally {
    await process.close();
  }
}, 20000);
