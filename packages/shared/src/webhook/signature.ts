import { createHmac } from "node:crypto";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { WebhookSigningError } from "./errors.js";

const secretsSchema = z.array(z.string().min(1)).nonempty();

/** One fresh send-time timestamp; hash the same raw bytes that will be transmitted. */
export const sign = (
  body: Uint8Array,
  secrets: readonly string[],
): Effect.Effect<string, WebhookSigningError> =>
  Effect.gen(function* () {
    const keys = yield* Effect.try({
      try: () => secretsSchema.parse(secrets),
      catch: () => new WebhookSigningError({ reason: "configuration" }),
    });
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () => {
        const seconds = Math.floor(now / 1000);
        const digests = keys.map(
          (secret) =>
            `v1=${createHmac("sha256", secret).update(`${seconds}.`).update(body).digest("hex")}`,
        );
        return `t=${seconds},${digests.join(",")}`;
      },
      catch: () => new WebhookSigningError({ reason: "sign" }),
    });
  });
