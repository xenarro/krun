import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Context, Effect, Layer } from "effect";
import ipaddr from "ipaddr.js";
import picomatch from "picomatch";
import { z } from "zod";
import { ConfigInvalid, type GatewayConfig } from "../config/index.js";
import { functionSpecSchema } from "../functions/schema.js";
import { CallbackNotAllowed } from "./errors.js";

type Cidr = GatewayConfig["KRUN_WEBHOOK_ALLOWED_CIDRS"][number];
type WebhookConfig = Pick<
  GatewayConfig,
  "KRUN_WEBHOOK_ALLOWED_HOSTS" | "KRUN_WEBHOOK_ALLOWED_CIDRS"
>;
export interface WebhookPolicy {
  readonly hostAllowed: (hostname: string) => boolean;
  readonly addressesAllowed: (addresses: readonly string[]) => boolean;
}

export class DnsLookup extends Context.Service<
  DnsLookup,
  {
    readonly lookup: (
      hostname: string,
    ) => Effect.Effect<readonly LookupAddress[], CallbackNotAllowed>;
  }
>()("krun/WebhookDnsLookup") {}

export const DnsLookupLive = Layer.succeed(DnsLookup, {
  lookup: (hostname) =>
    Effect.tryPromise({
      try: () => lookup(hostname, { all: true, verbatim: true }),
      catch: () => new CallbackNotAllowed({ reason: "unresolvable" }),
    }),
});

const addressAllowed = (value: string, cidrs: readonly Cidr[]): boolean => {
  // DNS answers must be actual IP addresses, not ipaddr's permissive legacy IPv4 syntax.
  if (isIP(value) === 0) return false;
  const address = ipaddr.process(value);
  return (
    address.range() === "unicast" ||
    cidrs.some(
      ([network, prefix]) => network.kind() === address.kind() && address.match(network, prefix),
    )
  );
};

/** Compile once from parsed configuration; snapshot rather than retaining mutable caller arrays. */
export const makeWebhookPolicy = (
  config: WebhookConfig,
): Effect.Effect<WebhookPolicy, ConfigInvalid> =>
  Effect.gen(function* () {
    const matches = yield* Effect.try({
      try: () =>
        picomatch(
          [...config.KRUN_WEBHOOK_ALLOWED_HOSTS].map((host) => host.toLowerCase()),
          { nocase: false, dot: true },
        ),
      catch: () => new ConfigInvalid({ variable: "KRUN_WEBHOOK_ALLOWED_HOSTS" }),
    });
    const cidrs = yield* Effect.try({
      try: () =>
        config.KRUN_WEBHOOK_ALLOWED_CIDRS.map(([address, prefix]) =>
          ipaddr.parseCIDR(`${address.toString()}/${prefix}`),
        ),
      catch: () => new ConfigInvalid({ variable: "KRUN_WEBHOOK_ALLOWED_CIDRS" }),
    });
    return Object.freeze({
      hostAllowed: (hostname: string) => matches(hostname.toLowerCase()),
      // Fail closed for empty/mixed answers; a connector must never fall back to an unchecked answer.
      addressesAllowed: (addresses: readonly string[]) =>
        addresses.length > 0 && addresses.every((address) => addressAllowed(address, cidrs)),
    });
  });

export interface PinnedTarget {
  readonly url: string;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

const callbackUrl = functionSpecSchema.shape.callback
  .unwrap()
  .shape.url.regex(/^https?:\/\//i)
  .refine((url) => !/[\s\\]/u.test(url))
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      // Undici fetch rejects userinfo. Reject before resolution rather than accepting an unusable target.
      if (url.username || url.password) {
        ctx.addIssue({ code: "custom", message: "Unusable callback URL" });
        return z.NEVER;
      }
      return url;
    } catch {
      ctx.addIssue({ code: "custom", message: "Unusable callback URL" });
      return z.NEVER;
    }
  });

/** Call both at submission and afresh for each attempted send; never cache a DNS result. */
export const resolveAndCheck = (
  url: string,
  policy: WebhookPolicy,
): Effect.Effect<PinnedTarget, CallbackNotAllowed, DnsLookup> =>
  Effect.gen(function* () {
    const parsed = callbackUrl.safeParse(url);
    if (!parsed.success) return yield* Effect.fail(new CallbackNotAllowed({ reason: "url" }));
    const hostname = parsed.data.hostname.replace(/^\[|\]$/g, "");
    if (!policy.hostAllowed(hostname))
      return yield* Effect.fail(new CallbackNotAllowed({ reason: "host" }));
    const literalFamily = isIP(hostname);
    const records =
      literalFamily === 0
        ? yield* (yield* DnsLookup).lookup(hostname)
        : [{ address: hostname, family: literalFamily }];
    // Own the primitive values once: provider records/array entries can be non-stable.
    const addresses = yield* Effect.try({
      try: () =>
        Object.freeze(z.array(z.string()).parse(Array.from(records, (record) => record.address))),
      catch: () => new CallbackNotAllowed({ reason: "address" }),
    });
    if (!policy.addressesAllowed(addresses))
      return yield* Effect.fail(new CallbackNotAllowed({ reason: "address" }));
    const first = addresses[0];
    if (!first) return yield* Effect.fail(new CallbackNotAllowed({ reason: "unresolvable" }));
    const address = ipaddr.process(first).toString();
    return Object.freeze({ url, hostname, address, family: isIP(address) === 4 ? 4 : 6 });
  });
