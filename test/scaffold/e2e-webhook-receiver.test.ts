import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, it } from "vitest";
import { makeWebhookReceiver } from "../e2e/lib/webhook-receiver.js";

const fn = "krun-test-webhook-control";
const runId = "0192f000-0000-7000-8000-000000000001";
const body = () => ({
  name: `functions/${fn}/runs/${runId}`,
  state: "SUCCEEDED",
  attempt: 1,
  priority: 0,
  createdBy: "e2e",
  createTime: "2026-10-27T00:00:00.000Z",
  endTime: "2026-10-27T00:00:01.000Z",
  runtimeStatus: { message: "opaque café ✓", reportTime: "2026-10-27T00:00:01.000Z" },
});
const keys = () => [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")] as const;
const now = 1_793_059_201_000;
const sign = (bytes: Buffer, secrets: readonly string[], time = now) => {
  const t = Math.floor(time / 1000);
  return `t=${t},${secrets.map((key) => `v1=${createHmac("sha256", key).update(`${t}.`).update(bytes).digest("hex")}`).join(",")}`;
};
const control = async (
  test: (context: {
    send: (bytes: Buffer, signature: string, id?: string) => Promise<number>;
    snapshot: ReturnType<typeof makeWebhookReceiver>["snapshot"];
    secrets: readonly [string, string];
  }) => Promise<void>,
) => {
  const secrets = keys();
  const receiver = makeWebhookReceiver(secrets, fn, () => now);
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");
  const address = receiver.server.address();
  if (!address || typeof address === "string") throw new Error("No receiver listener");
  try {
    await test({
      secrets,
      snapshot: receiver.snapshot,
      async send(bytes, signature, id = randomUUID()) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/hook?private-canary=opaque`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-krun-signature": signature,
              "x-krun-delivery": id,
              "x-krun-run-id": runId,
              traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(2000),
          },
        );
        await response.arrayBuffer();
        return response.status;
      },
    });
  } finally {
    receiver.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
};

it("independently verifies both rotation keys over exact raw bytes and records 500 then 200", async () => {
  await control(async ({ send, snapshot, secrets }) => {
    const bytes = Buffer.from(JSON.stringify(body(), null, 2));
    const id = randomUUID();
    expect(await send(bytes, sign(bytes, secrets), id)).toBe(500);
    expect(await send(bytes, sign(bytes, [...secrets].reverse()), id)).toBe(200);
    const records = snapshot();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.responseStatus)).toEqual([500, 200]);
    for (const record of records) {
      expect(record.valid).toBe(true);
      expect(record.v1Count).toBe(2);
      expect(record.deliveryId).toBe(id);
      expect(record.runId).toBe(runId);
      expect(record.sameBody).toBe(true);
    }
    const publicOutput = JSON.stringify(records);
    for (const value of [...secrets, sign(bytes, secrets), bytes.toString(), "private-canary"])
      expect(publicOutput.includes(value)).toBe(false);
  });
});

it.each([
  "tampered-byte",
  "wrong-key",
  "stale-time",
  "future-time",
  "missing-key",
  "duplicate-key",
  "malformed-hex",
  "full-run",
  "wrong-function",
  "wrong-run-id",
] as const)("rejects %s rather than reporting a signed delivery", async (mode) => {
  await control(async ({ send, snapshot, secrets }) => {
    let bytes = Buffer.from(JSON.stringify(body()));
    let signature = sign(bytes, secrets);
    if (mode === "tampered-byte") bytes = Buffer.concat([bytes, Buffer.from(" ")]);
    if (mode === "wrong-key") signature = sign(bytes, keys());
    if (mode === "stale-time") signature = sign(bytes, secrets, now - 301_000);
    if (mode === "future-time") signature = sign(bytes, secrets, now + 301_000);
    if (mode === "missing-key") signature = sign(bytes, secrets.slice(0, 1));
    if (mode === "duplicate-key") signature = sign(bytes, [secrets[0], secrets[0]]);
    if (mode === "malformed-hex") signature = signature.replace(/v1=[a-f0-9]{64}$/, "v1=00");
    if (mode === "full-run")
      bytes = Buffer.from(JSON.stringify({ ...body(), result: { opaque: true } }));
    if (mode === "wrong-function")
      bytes = Buffer.from(JSON.stringify({ ...body(), name: `functions/foreign/runs/${runId}` }));
    if (mode === "wrong-run-id")
      bytes = Buffer.from(
        JSON.stringify({
          ...body(),
          name: `functions/${fn}/runs/0192f000-0000-7000-8000-000000000002`,
        }),
      );
    if (["full-run", "wrong-function", "wrong-run-id"].includes(mode))
      signature = sign(bytes, secrets);
    expect(await send(bytes, signature)).toBe(401);
    expect(snapshot()).toHaveLength(1);
    expect(snapshot()[0]?.valid).toBe(false);
  });
});

it("records changed delivery identities and bytes so the e2e observer cannot confuse retries", async () => {
  await control(async ({ send, snapshot, secrets }) => {
    const first = Buffer.from(JSON.stringify(body()));
    const second = Buffer.from(JSON.stringify(body(), null, 2));
    const id = randomUUID();
    expect(await send(first, sign(first, secrets), id)).toBe(500);
    expect(await send(second, sign(second, secrets), randomUUID())).toBe(200);
    expect(snapshot()[1]?.sameBody).toBe(false);
    expect(snapshot()[1]?.deliveryId === snapshot()[0]?.deliveryId).toBe(false);
  });
});
