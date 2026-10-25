import { randomBytes } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import { Effect, Layer } from "effect";
import ipaddr from "ipaddr.js";
import { describe, expect, it } from "vitest";
import {
  CallbackNotAllowed,
  DnsLookup,
  makeWebhookPolicy,
  postWebhook,
  resolveAndCheck,
  sign,
} from "./index.js";

const policy = (cidrs: string[] = []) =>
  makeWebhookPolicy({
    KRUN_WEBHOOK_ALLOWED_HOSTS: ["receiver.krun-test.invalid"],
    KRUN_WEBHOOK_ALLOWED_CIDRS: cidrs.map((cidr) => ipaddr.parseCIDR(cidr)),
  });
const resolver = (records: readonly LookupAddress[]) =>
  Layer.succeed(DnsLookup, { lookup: () => Effect.succeed(records) });
const changing = (first: string, next: string) => {
  let reads = 0;
  const record: LookupAddress = Object.defineProperty({ address: first, family: 4 }, "address", {
    get: () => (++reads === 1 ? first : next),
  });
  return { record, reads: () => reads };
};
const listen = (server: Server, hostname: string, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("Owned receiver missing port"));
      else resolve(address.port);
    });
  });
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });

describe("the checked resolver snapshot is the connected target", () => {
  it("reads a getter-backed address once and pins that exact checked public value", async () => {
    const cfg = await Effect.runPromise(policy());
    const answers = changing("93.184.216.34", "127.0.0.1");
    const target = await Effect.runPromise(
      resolveAndCheck("https://receiver.krun-test.invalid/", cfg).pipe(
        Effect.provide(resolver([answers.record])),
      ),
    );
    expect(target.address).toBe("93.184.216.34");
    expect(cfg.addressesAllowed([target.address])).toBe(true);
    expect(answers.reads()).toBe(1);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("does not reread a replaceable array record after checking its address", async () => {
    const cfg = await Effect.runPromise(policy());
    let reads = 0;
    const records: LookupAddress[] = Object.defineProperty(
      [{ address: "93.184.216.34", family: 4 }],
      0,
      { get: () => ({ address: ++reads === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }) },
    );
    const target = await Effect.runPromise(
      resolveAndCheck("https://receiver.krun-test.invalid/", cfg).pipe(
        Effect.provide(resolver(records)),
      ),
    );
    expect(target.address).toBe("93.184.216.34");
    expect(reads).toBe(1);
  });

  it("normalizes the checked mapped value rather than a later record value", async () => {
    const cfg = await Effect.runPromise(policy());
    const answers = changing("::ffff:93.184.216.34", "::ffff:127.0.0.1");
    const target = await Effect.runPromise(
      resolveAndCheck("https://receiver.krun-test.invalid/", cfg).pipe(
        Effect.provide(resolver([answers.record])),
      ),
    );
    expect(target).toMatchObject({ address: "93.184.216.34", family: 4 });
    expect(answers.reads()).toBe(1);
  });

  it("keeps all-answer fail-closed behavior without retrying changing values", async () => {
    const cfg = await Effect.runPromise(policy());
    const first = changing("93.184.216.34", "127.0.0.1");
    const second = changing("127.0.0.1", "93.184.216.34");
    const error = await Effect.runPromise(
      Effect.flip(resolveAndCheck("https://receiver.krun-test.invalid/", cfg)).pipe(
        Effect.provide(resolver([first.record, second.record])),
      ),
    );
    expect(error).toMatchObject({ _tag: "CallbackNotAllowed", reason: "address" });
    expect(first.reads()).toBe(1);
    expect(second.reads()).toBe(1);
  });

  it("sanitizes provider field-read failures instead of retaining the raw error", async () => {
    const cfg = await Effect.runPromise(policy());
    const marker = "owned-provider-field-read-error";
    const record: LookupAddress = Object.defineProperty(
      { address: "93.184.216.34", family: 4 },
      "address",
      {
        get: () => {
          throw new Error(marker);
        },
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(resolveAndCheck("https://receiver.krun-test.invalid/", cfg)).pipe(
        Effect.provide(resolver([record])),
      ),
    );
    expect(error).toBeInstanceOf(CallbackNotAllowed);
    expect(error.reason).toBe("address");
    expect(JSON.stringify(error).includes(marker)).toBe(false);
  });

  it("rejects malformed provider address values without connecting", async () => {
    const cfg = await Effect.runPromise(policy());
    const record = { address: "93.184.216.34", family: 4 };
    Reflect.set(record, "address", null);
    const error = await Effect.runPromise(
      Effect.flip(resolveAndCheck("https://receiver.krun-test.invalid/", cfg)).pipe(
        Effect.provide(resolver([record])),
      ),
    );
    expect(error).toMatchObject({ _tag: "CallbackNotAllowed", reason: "address" });
  });

  it("sends only to the checked native loopback receiver, never the excluded address", async () => {
    let allowedHits = 0;
    let deniedHits = 0;
    const allowed = createServer((req, res) => {
      allowedHits++;
      req.resume();
      res.writeHead(204).end();
    });
    const denied = createServer((req, res) => {
      deniedHits++;
      req.resume();
      res.writeHead(204).end();
    });
    const port = await listen(denied, "127.0.0.1");
    try {
      await listen(allowed, "127.0.0.2", port);
      const cfg = await Effect.runPromise(policy(["127.0.0.2/32"]));
      expect(cfg.addressesAllowed(["127.0.0.1"])).toBe(false);
      const answers = changing("127.0.0.2", "127.0.0.1");
      const body = new TextEncoder().encode("{}");
      const signature = await Effect.runPromise(sign(body, [randomBytes(32).toString("base64")]));
      const status = await Effect.runPromise(
        postWebhook(`http://receiver.krun-test.invalid:${port}/`, cfg, body, {
          deliveryId: "0192f000-0000-7000-8000-000000000001",
          runId: "0192f000-0000-7000-8000-000000000002",
          signature,
        }).pipe(Effect.provide(resolver([answers.record]))),
      );
      expect(status).toBe(204);
      expect(deniedHits).toBe(0);
      expect(allowedHits).toBe(1);
      expect(answers.reads()).toBe(1);
    } finally {
      if (allowed.listening) await close(allowed);
      await close(denied);
    }
  });
});
