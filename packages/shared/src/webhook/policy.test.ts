import { randomBytes } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { Effect, Layer } from "effect";
import ipaddr from "ipaddr.js";
import { describe, expect, it } from "vitest";
import {
  CallbackNotAllowed,
  DnsLookup,
  DnsLookupLive,
  makeWebhookPolicy,
  type PinnedTarget,
  resolveAndCheck,
  type WebhookPolicy,
} from "./index.js";

const config = (hosts: string[] = ["*.example.com"], cidrs: string[] = []) => ({
  KRUN_WEBHOOK_ALLOWED_HOSTS: hosts,
  KRUN_WEBHOOK_ALLOWED_CIDRS: cidrs.map((cidr) => ipaddr.parseCIDR(cidr)),
});
const dns = (records: readonly LookupAddress[]) =>
  Layer.succeed(DnsLookup, { lookup: () => Effect.succeed(records) });
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flip(effect);

describe("webhook host and address policy", () => {
  it("compiles existing picomatch grammar once, folds case and retains dot semantics", async () => {
    const policy: WebhookPolicy = await Effect.runPromise(
      makeWebhookPolicy(config(["*.EXAMPLE.com", "@(hooks|notify).service.test"])),
    );
    for (const host of [
      "api.example.com",
      "a.b.example.com",
      ".hidden.example.com",
      "HOOKS.service.test",
      "notify.service.test",
    ]) {
      expect(policy.hostAllowed(host)).toBe(true);
    }
    for (const host of [
      "example.com",
      "evil-example.com",
      "api.example.com.evil",
      "evil.service.test",
    ]) {
      expect(policy.hostAllowed(host)).toBe(false);
    }
  });

  it("empty hosts deny even a public target; CIDRs cannot override hosts", async () => {
    const policy = await Effect.runPromise(makeWebhookPolicy(config([], ["0.0.0.0/0"])));
    expect(policy.hostAllowed("public.example")).toBe(false);
    const error = await Effect.runPromise(
      failure(resolveAndCheck("https://public.example/", policy)).pipe(
        Effect.provide(dns([{ address: "93.184.216.34", family: 4 }])),
      ),
    );
    expect(error).toMatchObject({ _tag: "CallbackNotAllowed", reason: "host" });
  });

  it.each([
    ["0.0.0.0", false],
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["224.0.0.1", false],
    ["240.0.0.1", false],
    ["192.0.0.1", false],
    ["192.0.2.1", false],
    ["198.18.0.1", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["ff02::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:192.168.1.1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["2002::1", false],
    ["93.184.216.34", true],
    ["2606:4700:4700::1111", true],
    ["::ffff:93.184.216.34", true],
    ["not-an-address", false],
    ["127.1", false],
  ])("uses ipaddr.process/range for %s (allowed=%s)", async (address, allowed) => {
    const policy = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    expect(policy.addressesAllowed([address])).toBe(allowed);
  });

  it("rejects empty/mixed DNS answers and permits explicit same-family CIDR exceptions", async () => {
    const ordinary = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    const exceptions = await Effect.runPromise(
      makeWebhookPolicy(config(["*"], ["10.0.0.0/8", "169.254.169.254/32", "fc00::/7"])),
    );
    expect(ordinary.addressesAllowed([])).toBe(false);
    expect(ordinary.addressesAllowed(["93.184.216.34", "127.0.0.1"])).toBe(false);
    for (const address of ["10.42.1.2", "::ffff:10.42.1.2", "169.254.169.254", "fd00::123"]) {
      expect(exceptions.addressesAllowed([address])).toBe(true);
    }
    expect(exceptions.addressesAllowed(["127.0.0.1"])).toBe(false);
    expect(exceptions.addressesAllowed(["10.42.1.2", "2606:4700:4700::1111"])).toBe(true);
  });

  it("snapshots configuration instead of allowing a later array mutation to widen policy", async () => {
    const cfg = config(["good.example.com"], ["10.0.0.0/8"]);
    const policy = await Effect.runPromise(makeWebhookPolicy(cfg));
    cfg.KRUN_WEBHOOK_ALLOWED_HOSTS.push("*");
    cfg.KRUN_WEBHOOK_ALLOWED_CIDRS.push(ipaddr.parseCIDR("127.0.0.0/8"));
    expect(policy.hostAllowed("evil.example")).toBe(false);
    expect(policy.addressesAllowed(["127.0.0.1"])).toBe(false);
  });

  it.each([
    "file:///etc/passwd",
    "ftp://api.example.com/a",
    "https:api.example.com",
    " https://api.example.com",
    "https://api.example.com\\@evil.test",
    "https://api.example.com/\nsecret",
    "https://user@api.example.com/",
  ])("fails unsupported/unusable URL before DNS: %s", async (url) => {
    let calls = 0;
    const policy = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    const error = await Effect.runPromise(
      failure(resolveAndCheck(url, policy)).pipe(
        Effect.provide(
          Layer.succeed(DnsLookup, {
            lookup: () => {
              calls++;
              return Effect.succeed([{ address: "93.184.216.34", family: 4 }]);
            },
          }),
        ),
      ),
    );
    expect(error._tag).toBe("CallbackNotAllowed");
    expect(calls).toBe(0);
  });

  it("checks every answer, resolves on every invocation and preserves the supplied URL", async () => {
    let calls = 0;
    const policy = await Effect.runPromise(makeWebhookPolicy(config()));
    const layer = Layer.succeed(DnsLookup, {
      lookup: () =>
        Effect.sync(() => {
          calls++;
          return [{ address: calls === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 }];
        }),
    });
    const url = "https://API.EXAMPLE.com:443/%2f?q=%41#fragment";
    const first: PinnedTarget = await Effect.runPromise(
      resolveAndCheck(url, policy).pipe(Effect.provide(layer)),
    );
    expect(first).toMatchObject({
      url,
      hostname: "api.example.com",
      address: "93.184.216.34",
      family: 4,
    });
    const error = await Effect.runPromise(
      failure(resolveAndCheck(url, policy)).pipe(Effect.provide(layer)),
    );
    expect(error).toMatchObject({ _tag: "CallbackNotAllowed", reason: "address" });
    expect(calls).toBe(2);
  });

  it("normalizes mapped IP literals without DNS, rejecting by default and accepting only explicit CIDRs", async () => {
    let calls = 0;
    const layer = Layer.succeed(DnsLookup, {
      lookup: () => {
        calls++;
        return Effect.succeed([]);
      },
    });
    const deny = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    const allow = await Effect.runPromise(makeWebhookPolicy(config(["*"], ["127.0.0.0/8"])));
    const url = "http://[::ffff:127.0.0.1]/";
    expect(
      await Effect.runPromise(failure(resolveAndCheck(url, deny)).pipe(Effect.provide(layer))),
    ).toMatchObject({ reason: "address" });
    expect(
      await Effect.runPromise(resolveAndCheck(url, allow).pipe(Effect.provide(layer))),
    ).toMatchObject({ address: "127.0.0.1", family: 4 });
    expect(calls).toBe(0);
  });

  it("rejects WHATWG legacy loopback IP spellings after canonical address checks", async () => {
    const policy = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    for (const url of [
      "http://127.1/",
      "http://0177.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect(
        await Effect.runPromise(
          failure(resolveAndCheck(url, policy)).pipe(Effect.provide(dns([]))),
        ),
      ).toMatchObject({ reason: "address" });
    }
  });

  it("rejects malformed RFC3986 wire strings instead of silently URL-normalizing them", async () => {
    const policy = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    for (const url of ["https://api.example.com/%ZZ", "https://api.example.com/é"]) {
      expect(
        await Effect.runPromise(
          failure(resolveAndCheck(url, policy)).pipe(
            Effect.provide(dns([{ address: "93.184.216.34", family: 4 }])),
          ),
        ),
      ).toMatchObject({ reason: "url" });
    }
  });

  it("real native localhost resolution is denied without a CIDR exception", async () => {
    const policy = await Effect.runPromise(makeWebhookPolicy(config(["*"])));
    const error = await Effect.runPromise(
      failure(resolveAndCheck("https://localhost/", policy)).pipe(Effect.provide(DnsLookupLive)),
    );
    expect(error).toMatchObject({ reason: "address" });
  });

  it("configuration compilation failures stay bounded and contain no operator input", async () => {
    const marker = randomBytes(32).toString("hex");
    const error = await Effect.runPromise(
      failure(makeWebhookPolicy(config([marker.repeat(2000)]))),
    );
    expect(error).toMatchObject({ _tag: "ConfigInvalid", variable: "KRUN_WEBHOOK_ALLOWED_HOSTS" });
    expect(JSON.stringify(error).includes(marker)).toBe(false);
  });

  it("does not retain raw DNS errors, URLs or arbitrary diagnostic text", async () => {
    const marker = randomBytes(24).toString("hex");
    const policy = await Effect.runPromise(makeWebhookPolicy(config()));
    const error = await Effect.runPromise(
      failure(resolveAndCheck(`https://api.example.com/${marker}`, policy)).pipe(
        Effect.provide(
          Layer.succeed(DnsLookup, {
            lookup: () => Effect.fail(new CallbackNotAllowed({ reason: "unresolvable" })),
          }),
        ),
      ),
    );
    expect(JSON.stringify(error).includes(marker)).toBe(false);
    expect(error).toMatchObject({ _tag: "CallbackNotAllowed", reason: "unresolvable" });
  });
});
