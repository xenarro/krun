import { Data } from "effect";

// Bounded discriminants only: never retain native errors, URLs, headers or payloads.
export class CallbackNotAllowed extends Data.TaggedError("CallbackNotAllowed")<{
  readonly reason: "url" | "scheme" | "host" | "address" | "unresolvable";
}> {}

export class WebhookSigningError extends Data.TaggedError("WebhookSigningError")<{
  readonly reason: "configuration" | "sign";
}> {}

export class WebhookTransportError extends Data.TaggedError("WebhookTransportError")<{
  readonly reason: "headers" | "request" | "status" | "timeout" | "cleanup";
  readonly status?: number;
}> {}
