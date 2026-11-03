import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { admissionVerdict, jobOccupancy, schedulerMetricsScript } from "../e2e/lib/backpressure.js";

it("scrapes scheduler metrics with both the default and explicit admin addresses", () => {
  for (const [address, port] of [
    [undefined, "9090"],
    [":9091", "9091"],
  ] as const) {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `globalThis.fetch = async (target) => ({ok:true,text:async()=>String(target)});${schedulerMetricsScript}`,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: address === undefined ? {} : { KRUN_ADMIN_LISTEN_ADDR: address },
      },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`http://127.0.0.1:${port}/metrics`);
    expect(child.stderr).toBe("");
  }
});

const rejected = (limit = "function", reason = "QUEUE_FULL") => ({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Queue is full",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason,
        domain: "krun.io",
        metadata: { limit },
      },
    ],
  },
});
it("distinguishes queue pressure from rate limits, transport errors and wrong quota scope", () => {
  expect(admissionVerdict(429, "1", rejected(), "function")).toBe("full");
  expect(admissionVerdict(429, "1", rejected("key"), "key")).toBe("full");
  for (const [status, retry, body, limit] of [
    [429, "1", rejected("function", "RATE_LIMITED"), "function"],
    [429, null, rejected(), "function"],
    [429, "1", rejected("key"), "function"],
    [503, "1", rejected(), "function"],
    [429, "1", { error: { code: 429 } }, "function"],
  ] as const)
    expect(() => admissionVerdict(status, retry, body, limit)).toThrow(
      "Invalid backpressure admission",
    );
});
const job = (name: string, status = {}) => ({
  metadata: { name, uid: name, labels: { "krun.io/function": "owned" } },
  status,
});
it("counts pending, active and deleting Jobs, excluding only terminal conditions", () => {
  expect(
    jobOccupancy(
      [
        job("pending"),
        job("active", { active: 1 }),
        { ...job("deleting"), metadata: { ...job("deleting").metadata, deletionTimestamp: "now" } },
      ],
      "owned",
    ),
  ).toBe(3);
  expect(
    jobOccupancy(
      [
        job("done", { conditions: [{ type: "Complete", status: "True" }] }),
        job("failed", { conditions: [{ type: "Failed", status: "True" }] }),
      ],
      "owned",
    ),
  ).toBe(0);
  expect(
    jobOccupancy(
      [job("not-terminal", { conditions: [{ type: "Complete", status: "False" }] })],
      "owned",
    ),
  ).toBe(1);
});
it("rejects malformed and foreign Job evidence instead of treating it as zero", () => {
  for (const jobs of [
    [{}],
    [job("a"), job("a")],
    [
      {
        ...job("foreign"),
        metadata: { name: "foreign", uid: "foreign", labels: { "krun.io/function": "other" } },
      },
    ],
  ])
    expect(() => jobOccupancy(jobs, "owned")).toThrow("Invalid backpressure Job inventory");
});
