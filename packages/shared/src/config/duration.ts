import { z } from "zod";

// Keep the wire schema transform-free for Function/CRD generation.
export const durationPattern = "^\\d+(ms|s|m|h)$";
export const durationStringSchema = z.string().regex(new RegExp(durationPattern));

const durationUnits = [
  ["ms", 1],
  ["s", 1000],
  ["m", 60000],
  ["h", 3600000],
] as const;

// One representability rule for configuration and Function wire durations.
export const durationToMilliseconds = (value: string): number | undefined => {
  if (!durationStringSchema.safeParse(value).success) return undefined;
  const unit = durationUnits.find(([suffix]) => value.endsWith(suffix));
  if (!unit) return undefined;
  const millis = Number(value.slice(0, -unit[0].length)) * unit[1];
  return Number.isSafeInteger(millis) ? millis : undefined;
};

// Equal-width unsigned decimal interval, using only RE2-compatible syntax.
const digitInterval = (lower: string, upper: string): string => {
  if (lower === upper) return lower;
  if (lower === "0".repeat(lower.length) && upper === "9".repeat(upper.length)) {
    return lower.length === 1 ? "\\d" : `\\d{${lower.length}}`;
  }
  const lo = Number(lower[0]),
    hi = Number(upper[0]);
  if (lo === hi) return `${lo}${digitInterval(lower.slice(1), upper.slice(1))}`;
  if (lower.length === 1) return `[${lo}-${hi}]`;
  const width = lower.length - 1;
  const alternatives = [
    `${lo}${digitInterval(lower.slice(1), "9".repeat(width))}`,
    ...(hi - lo > 1 ? [`[${lo + 1}-${hi - 1}]\\d{${width}}`] : []),
    `${hi}${digitInterval("0".repeat(width), upper.slice(1))}`,
  ];
  return `(?:${alternatives.join("|")})`;
};

// Static bounded patterns encode floors and safe-integer overflow identically
// in JS, JSON Schema and Kubernetes RE2; no CEL int() conversion is required.
export const durationRangePattern = (minimumMillis: number): string => {
  const alternatives = durationUnits.map(([unit, scale]) => {
    const minimum = (BigInt(minimumMillis) + BigInt(scale) - 1n) / BigInt(scale);
    const maximum = BigInt(Number.MAX_SAFE_INTEGER) / BigInt(scale);
    const lo = minimum.toString(),
      hi = maximum.toString();
    const lengths: string[] = [];
    for (let width = lo.length; width <= hi.length; width++) {
      const lower = width === lo.length ? lo : `1${"0".repeat(width - 1)}`;
      const upper = width === hi.length ? hi : "9".repeat(width);
      lengths.push(digitInterval(lower, upper));
    }
    return `0*(?:${lengths.join("|")})${unit}`;
  });
  return `^(?:${alternatives.join("|")})$`;
};
