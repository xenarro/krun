import { setTimeout } from "node:timers/promises";

// Real external systems only. Keep private response bodies/errors out of failures.
export const eventually = async <T>(
  read: () => Promise<T>,
  judge: (value: T) => "done" | "wait" | "fail",
  label: string,
  timeoutMs = 120_000,
  intervalMs = 200,
): Promise<T> => {
  const end = performance.now() + timeoutMs;
  let readFailed = false;
  while (performance.now() < end) {
    let value: T;
    try {
      value = await read();
      readFailed = false;
    } catch {
      readFailed = true;
      await setTimeout(Math.min(intervalMs, Math.max(0, end - performance.now())));
      continue;
    }
    const verdict = judge(value);
    if (verdict === "done") return value;
    if (verdict === "fail") throw new Error(`${label} reached an invalid state`);
    await setTimeout(Math.min(intervalMs, Math.max(0, end - performance.now())));
  }
  throw new Error(`${label} timed out${readFailed ? " after a read error" : ""}`);
};
