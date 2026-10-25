import { DateTime } from "effect";
import { z } from "zod";
import { failureReasons, type RunFilter, states } from "./model.js";

// The public grammar produces the existing typed Store terms. The gateway can
// use safeParse to map failures to FILTER_INVALID; no HTTP policy lives here.
export const runFilterSchema = z.string().transform((expression, context): RunFilter => {
  const terms: NonNullable<RunFilter["terms"]>[number][] = [];
  if (expression.trim() === "") return { terms };
  for (const text of expression.trim().split(/\s+AND\s+/)) {
    const state = /^state\s*(!=|=)\s*([A-Z_]+)$/.exec(text);
    const failure = /^failureReason\s*=\s*([A-Z_]+)$/.exec(text);
    const time = /^createTime\s*(>=|<=|>|<)\s*"([^"]+)"$/.exec(text);
    const stateValue = states.find((value) => value.toUpperCase() === state?.[2]);
    const failureValue = failureReasons.find((value) => value.toUpperCase() === failure?.[1]);
    if (state && stateValue !== undefined) {
      terms.push({ field: "state", operator: state[1] === "=" ? "=" : "!=", value: stateValue });
    } else if (failure && failureValue !== undefined) {
      terms.push({ field: "failureReason", operator: "=", value: failureValue });
    } else if (time) {
      const parsed = z.iso.datetime({ offset: true }).safeParse(time[2]);
      if (parsed.success) {
        const operator = z.enum([">=", "<=", ">", "<"]).parse(time[1]);
        const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(parsed.data)?.[1] ?? "";
        const nonAligned = /[1-9]/.test(fraction.slice(3));
        // Runs live on a millisecond grid; retain exact comparison semantics
        // without floating-point fractions or changing the declared DateTime type.
        // >= a fractional instant is > its floor; < is <= its floor. This is
        // equivalent to ceiling those bounds, without crossing the RFC3339 range
        // at year-end. Aligned operands and the other two operators stay intact.
        const normalizedOperator = nonAligned
          ? operator === ">="
            ? ">"
            : operator === "<"
              ? "<="
              : operator
          : operator;
        terms.push({
          field: "createTime",
          operator: normalizedOperator,
          value: DateTime.makeUnsafe(parsed.data),
        });
        continue;
      }
      context.issues.push({ code: "custom", message: "Invalid run filter", input: expression });
      return z.NEVER;
    } else {
      context.issues.push({ code: "custom", message: "Invalid run filter", input: expression });
      return z.NEVER;
    }
  }
  return { terms };
});
