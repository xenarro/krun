import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
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

const webhookReceiver = async (hold = false) => {
  const hits: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  let closed = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    response.once("close", () => {
      closed = true;
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      hits.push({ headers: request.headers, body: Buffer.concat(chunks) });
      if (!hold) {
        response.statusCode = 204;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned webhook port");
  return {
    hits,
    closed: () => closed,
    url: `http://127.0.0.1:${address.port}/hook`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

it("elected process delivers an actual terminal Store callback with rotated signatures and exported metric", async () => {
  const receiver = await webhookReceiver();
  const secrets = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const process = await startSchedulerProcess({
    image,
    seed: true,
    webhook: { url: receiver.url, secret: secrets.join(",") },
  });
  try {
    await schedulerUntil(() => process.kube.snapshot().jobs === 1);
    process.kube.complete();
    await schedulerUntil(async () => (await process.delivery())?.state === "delivered");
    expect(receiver.hits).toHaveLength(1);
    const hit = receiver.hits[0];
    if (!hit) throw new Error("No owned webhook attempt");
    const signature = String(hit.headers["x-krun-signature"]);
    const timestamp = signature.split(",")[0]?.slice(2);
    expect(Number(timestamp)).toBeGreaterThan(0);
    expect(signature.split(",")).toHaveLength(3);
    for (const secret of secrets) {
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(hit.body)
        .digest();
      expect(
        signature
          .split(",")
          .slice(1)
          .some((part) => {
            const actual = Buffer.from(part.slice(3), "hex");
            return actual.length === expected.length && timingSafeEqual(actual, expected);
          }),
      ).toBe(true);
      expect(process.output().includes(secret)).toBe(false);
    }
    expect(String(hit.headers.traceparent)).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
    const payload = JSON.parse(hit.body.toString());
    expect(payload.state).toBe("SUCCEEDED");
    expect(payload).not.toHaveProperty("input");
    expect(payload).not.toHaveProperty("result");
    expect(payload).not.toHaveProperty("logTail");
    const metrics = await (await process.response("/metrics"))?.text();
    expect(metrics).toContain('krun_deliveries_total{state="delivered"} 1');
    expect(metrics).not.toContain("krun_deliveries_total_total");
    expect(await process.stop()).toEqual({ code: 0, signal: null });
    expect(process.kube.events).toContain("lease-cleared:watches=0");
  } finally {
    await process.close();
    await receiver.close();
  }
}, 20000);

it("standby process leaves a configured physical pending outbox unclaimed", async () => {
  const receiver = await webhookReceiver();
  const process = await startSchedulerProcess({
    image,
    seed: true,
    standby: true,
    webhook: { url: receiver.url, secret: randomBytes(32).toString("hex"), terminal: true },
  });
  try {
    await schedulerUntil(async () => (await process.response("/readyz"))?.status === 200);
    expect(await (await process.response("/readyz"))?.json()).toEqual({
      status: "ok",
      leader: false,
    });
    expect((await process.delivery())?.state).toBe("pending");
    expect((await process.delivery())?.attempt).toBe(0);
    expect(receiver.hits).toHaveLength(0);
    const metrics = await (await process.response("/metrics"))?.text();
    expect(metrics).not.toContain("krun_deliveries_total{");
    expect(await process.stop()).toEqual({ code: 0, signal: null });
  } finally {
    await process.close();
    await receiver.close();
  }
}, 20000);

for (const mode of ["SIGTERM", "leadership loss"] as const)
  it(`actual ${mode} aborts a held webhook without consuming its pending retry`, async () => {
    const receiver = await webhookReceiver(true);
    const process = await startSchedulerProcess({
      image,
      seed: true,
      webhook: { url: receiver.url, secret: randomBytes(32).toString("hex"), terminal: true },
    });
    try {
      await schedulerUntil(() => receiver.hits.length === 1);
      const before = await process.delivery();
      expect(before?.state).toBe("pending");
      expect(before?.attempt).toBe(0);
      if (mode === "SIGTERM") expect(await process.stop()).toEqual({ code: 0, signal: null });
      else {
        process.kube.steal();
        expect(await process.exited).toEqual({ code: 1, signal: null });
      }
      await schedulerUntil(receiver.closed);
      if (!image) expect(await process.delivery()).toEqual(before);
      // Image tmpfs is removed with its container; do not invent a post-exit
      // SQL read there. Unit/host controls read back the retained lease.
      expect(process.output()).not.toContain("Webhook delivery attempt failed; outcome persisted");
      expect(receiver.hits).toHaveLength(1);
      expect(process.kube.snapshot().watches).toBe(0);
    } finally {
      await process.close();
      await receiver.close();
    }
  }, 20000);
