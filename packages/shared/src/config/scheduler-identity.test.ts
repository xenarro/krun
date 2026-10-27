import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseSchedulerConfig } from "./index.js";

for (const name of ["krun-scheduler-0", "scheduler.example", "a".repeat(63)]) {
  it.effect("parses an explicit scheduler pod identity", () =>
    Effect.gen(function* () {
      const config = yield* parseSchedulerConfig({
        KRUN_DB_MODE: "embedded",
        KRUN_NAMESPACE: "krun-test",
        KRUN_POD_NAME: name,
      });
      expect(config.KRUN_POD_NAME).toBe(name);
    }),
  );
}
for (const name of ["UPPER", "a/b", "a..b", "a".repeat(64), "-invalid"]) {
  it.effect("rejects invalid pod identity with a name-only diagnostic", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parseSchedulerConfig({
          KRUN_DB_MODE: "embedded",
          KRUN_NAMESPACE: "krun-test",
          KRUN_POD_NAME: name,
        }),
      );
      expect(error.variable).toBe("KRUN_POD_NAME");
      expect(JSON.stringify(error)).not.toContain(name);
    }),
  );
}
for (const name of [undefined, ""]) {
  it.effect("isolated component config can omit identity;the serving process requires it", () =>
    Effect.gen(function* () {
      const config = yield* parseSchedulerConfig({
        KRUN_DB_MODE: "embedded",
        KRUN_NAMESPACE: "krun-test",
        KRUN_POD_NAME: name,
      });
      expect(config.KRUN_POD_NAME).toBeUndefined();
    }),
  );
}
