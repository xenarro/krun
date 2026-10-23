import { expect, it } from "@effect/vitest";
import { durationStringSchema } from "./duration.js";

it("keeps Function duration values as strings using the exact SPEC grammar", () => {
  for (const value of ["0ms", "1ms", "10s", "20m", "720h"]) {
    expect(durationStringSchema.parse(value)).toBe(value);
  }
  for (const value of ["", "1", "1d", "-1s", "1.5s", " 1s", "1s ", "1S", "1e3ms"]) {
    expect(durationStringSchema.safeParse(value).success).toBe(false);
  }
});
