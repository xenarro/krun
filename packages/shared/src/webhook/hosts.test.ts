import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeWebhookPolicy } from "./index.js";

it("keeps configuration field-read errors bounded after sharing pure host compilation", async () => {
  const marker = "owned-host-config-field-error";
  const config = Object.defineProperty(
    { KRUN_WEBHOOK_ALLOWED_HOSTS: ["*"], KRUN_WEBHOOK_ALLOWED_CIDRS: [] },
    "KRUN_WEBHOOK_ALLOWED_HOSTS",
    {
      get: () => {
        throw new Error(marker);
      },
    },
  );
  const error = await Effect.runPromise(Effect.flip(makeWebhookPolicy(config)));
  expect(error).toMatchObject({ _tag: "ConfigInvalid", variable: "KRUN_WEBHOOK_ALLOWED_HOSTS" });
  expect(JSON.stringify(error).includes(marker)).toBe(false);
});
