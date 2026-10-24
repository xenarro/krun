import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Effect } from "effect";
import { DatabaseError } from "./errors.js";
import type { JsonObject } from "./model.js";

// Hash the API3.3 body projection, not NewRun: normalize absent priority to
// zero and callback to null before any Function callback fallback is applied.
export const requestHash = (request: {
  readonly input: JsonObject;
  readonly priority?: number;
  readonly callback?: { readonly url: string };
}) =>
  Effect.try({
    try: () =>
      canonicalize({
        input: request.input,
        priority: request.priority ?? 0,
        callback: request.callback ?? null,
      }),
    catch: () => new DatabaseError({ operation: "request-hash" }),
  }).pipe(
    Effect.flatMap((value) =>
      typeof value === "string"
        ? Effect.try({
            try: () => createHash("sha256").update(value).digest("hex"),
            catch: () => new DatabaseError({ operation: "request-hash" }),
          })
        : Effect.fail(new DatabaseError({ operation: "request-hash" })),
    ),
  );
