import { Data } from "effect";

// Parser/driver diagnostics can contain the entire Secret. Keep only bounded
// classifications and the numeric entry position, never native causes/inputs.
export class KeysConfigInvalid extends Data.TaggedError("KeysConfigInvalid")<{
  readonly reason: "read" | "yaml" | "schema" | "duplicate_name" | "glob" | "role";
  readonly field: "file" | "keys" | "name" | "key" | "scopes" | "functions" | "maxQueued";
  readonly entry?: number | undefined;
}> {
  override get message(): string {
    return "Invalid API keys configuration";
  }
}

export class KeyInvalid extends Data.TaggedError("KeyInvalid") {
  override get message(): string {
    return "Invalid API key";
  }
}
