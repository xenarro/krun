import { type KubeApiError, kubeApiStatus } from "@krun/shared/dist/k8s/errors.js";
import type { RunError } from "@krun/shared/dist/store/model.js";
import { Clock, DateTime, Effect, Metric, Option, Ref } from "effect";

export type CreationDecision =
  | { readonly kind: "already_exists" }
  | {
      readonly kind: "permanent";
      readonly failureReason: "job_create_failed";
      readonly error: RunError;
    }
  | {
      readonly kind: "transient";
      readonly quota: boolean;
      readonly backoffSeconds: number;
      readonly retryAt: number;
      readonly pauseSeconds?: number;
    };

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const httpDateMillis = (value: string, now: number): number | undefined => {
  const imf =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/.exec(
      value,
    );
  const obsolete =
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<year>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) GMT$/.exec(
      value,
    );
  const asctime =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{2}| \d) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}) (?<year>\d{4})$/.exec(
      value,
    );
  const parts = (imf ?? obsolete ?? asctime)?.groups;
  if (parts === undefined) return undefined;
  const current = DateTime.makeUnsafe(now);
  const currentYear = DateTime.toPartsUtc(current).year;
  let year = Number(parts.year);
  if (obsolete !== null) {
    year += Math.floor(currentYear / 100) * 100;
    if (year < currentYear - 50) year += 100;
  }
  const month = months.indexOf(parts.month ?? "") + 1;
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (hour > 23 || minute > 59 || second > 60) return undefined;
  const make = (year: number) => {
    const parsed = DateTime.make({
      year,
      month,
      day,
      hour,
      minute,
      second: Math.min(second, 59),
      millisecond: 0,
    });
    if (Option.isNone(parsed)) return undefined;
    const actual = DateTime.toPartsUtc(parsed.value);
    // DateTime normalizes calendar overflow; invalid HTTP dates must use the default instead.
    if (actual.year !== year || actual.month !== month || actual.day !== day) return undefined;
    return DateTime.toEpochMillis(parsed.value) + (second === 60 ? 1000 : 0);
  };
  const parsed = make(year);
  if (parsed === undefined) return undefined;
  // RFC9110: an RFC850 date more than fifty years ahead means the most recent
  // past year with those last two digits. The boundary uses the full UTC instant.
  return obsolete !== null && parsed > DateTime.toEpochMillis(DateTime.add(current, { years: 50 }))
    ? make(year - 100)
    : parsed;
};
const retrySeconds = (header: string | undefined, now: number): number => {
  if (header === undefined) return 1;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Math.min(60, Number(value));
  const parsed = httpDateMillis(value, now);
  return parsed === undefined ? 1 : Math.min(60, Math.max(0, Math.ceil((parsed - now) / 1000)));
};

/** Build inside the leader term. This policy does not retry API calls, mutate the
 * Store or hold permits while waiting; the later loop owns release-before-pause.
 * A permanent decision contains persistence-only Status data: never log it.
 */
export const makeCreationPolicy = Effect.gen(function* () {
  const states = yield* Ref.make<
    ReadonlyMap<string, { readonly failures: number; readonly until: number }>
  >(new Map());
  return {
    failed: (functionName: string, error: KubeApiError): Effect.Effect<CreationDecision> =>
      Effect.gen(function* () {
        const detail = kubeApiStatus(error);
        if (error.status === 409 && detail.reason === "AlreadyExists")
          return { kind: "already_exists" } as const;
        const quota =
          error.status === 403 &&
          detail.reason === "Forbidden" &&
          /exceeded quota/i.test(detail.message);
        yield* Metric.update(
          Metric.withAttributes(
            Metric.counter("krun_job_create_errors_total", { incremental: true }),
            { function: functionName, code: String(error.status ?? 0) },
          ),
          1,
        );
        if (quota)
          yield* Metric.update(
            Metric.withAttributes(
              Metric.counter("krun_quota_rejections_total", { incremental: true }),
              { function: functionName },
            ),
            1,
          );
        if (
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429 &&
          !quota
        )
          return {
            kind: "permanent",
            failureReason: "job_create_failed",
            error: {
              source: "krun",
              message: detail.message,
              details: { code: error.status, reason: detail.reason },
            },
          };
        const now = yield* Clock.currentTimeMillis;
        const backoff = yield* Ref.modify(states, (current) => {
          const failures = current.get(functionName)?.failures ?? 0;
          const seconds = Math.min(2 ** failures, 60);
          const next = new Map(current);
          next.set(functionName, {
            failures: Math.min(failures + 1, 6),
            until: now + seconds * 1000,
          });
          return [seconds, next];
        });
        return {
          kind: "transient",
          quota,
          backoffSeconds: backoff,
          retryAt: now + backoff * 1000,
          ...(error.status === 429 ? { pauseSeconds: retrySeconds(detail.retryAfter, now) } : {}),
        };
      }),
    succeeded: (functionName: string) =>
      Ref.update(states, (current) => {
        const next = new Map(current);
        next.delete(functionName);
        return next;
      }),
    isBackingOff: (functionName: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return ((yield* Ref.get(states)).get(functionName)?.until ?? 0) > now;
      }),
    pause: (decision: CreationDecision) =>
      decision.kind === "transient" && decision.pauseSeconds !== undefined
        ? Effect.sleep(decision.pauseSeconds * 1000)
        : Effect.void,
  };
});
