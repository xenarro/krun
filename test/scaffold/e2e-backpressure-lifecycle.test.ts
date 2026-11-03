import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { backpressureAcceptance } from "../e2e/lib/backpressure-harness.js";

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: processes.spawn }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  processes.spawn.mockReset();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise<void>((done) => setImmediate(done));
const fixture = (failure?: "transport" | "validation") => {
  const name = "krun-test-lifecycle";
  const runs = new Map<string, Record<string, unknown>>();
  const batch = deferred<void>();
  const stop = deferred<void>();
  const held: (() => void)[] = [];
  let firstFailure: (() => void) | undefined;
  let creates = 0;
  let cancels = 0;
  let sweepSettled = false;
  let lateMutations = 0;
  let holding = failure !== undefined;
  let onStop = () => {};
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      stop.resolve();
      setImmediate(() => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
        onStop();
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", null, signal));
      });
      return true;
    }),
  });
  processes.spawn.mockReturnValue(child);
  const reply = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json", "retry-after": "1" },
    });
  vi.stubGlobal("fetch", async (target: string, options: RequestInit = {}) => {
    const path = new URL(target).pathname.slice("/v1/".length);
    if (options.method === "POST" && path === `functions/${name}/runs`) {
      creates++;
      if (creates === 11)
        return reply(
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Queue is full",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "krun.io",
                  reason: "QUEUE_FULL",
                  metadata: { limit: "key" },
                },
              ],
            },
          },
          429,
        );
      // End setup after the ten real admissions and their cancellation stage;
      // no ownership-seeding seam or 3,000-request simulation is necessary.
      if (creates > 11) throw new Error("Controlled admission boundary");
      const resource = `functions/${name}/runs/0192f000-0000-7000-8000-${String(creates).padStart(12, "0")}`;
      const run = {
        name: resource,
        state: "QUEUED",
        attempt: 0,
        priority: 0,
        createdBy: "e2e-backpressure",
        createTime: "2026-01-01T00:00:00.000Z",
        input: {},
      };
      runs.set(resource, run);
      return reply(run, 201);
    }
    if (options.method === "POST" && path.endsWith(":cancel")) {
      cancels++;
      if (sweepSettled && holding) lateMutations++;
      const run = runs.get(path.slice(0, -":cancel".length));
      if (!run) throw new Error("Unowned cancellation in lifecycle fixture");
      const accepted = () => {
        run.state = "CANCELLED";
        return reply(run);
      };
      if (holding && cancels <= 8) {
        const pending = new Promise<Response>((resolve, reject) => {
          if (cancels === 1)
            firstFailure = () =>
              failure === "transport"
                ? reject(new Error("Controlled transport failure"))
                : resolve(reply({}));
          else held.push(() => resolve(accepted()));
        });
        if (cancels === 8) {
          firstFailure?.();
          batch.resolve();
        }
        return pending;
      }
      return accepted();
    }
    if (path === `functions/${name}/runs`)
      return reply({
        runs: [...runs.values()].map(({ input: _input, ...run }) => run),
      });
    throw new Error("Unexpected lifecycle API operation");
  });
  const h = backpressureAcceptance({
    name,
    namespace: "krun-test-lifecycle",
    jobsNamespace: "krun-test-lifecycle-jobs",
    kubeconfig: "/owned-lifecycle/kubeconfig",
    url: "http://controlled.invalid",
    key: randomBytes(32).toString("hex"),
    mode: "controlled-lifecycle",
    kube(args) {
      if (args[0] === "get" && args[1] === "jobs")
        return JSON.stringify({ metadata: { resourceVersion: "1" }, items: [] });
      if (args[0] === "get" && args[1] === "resourcequota")
        return args.includes("--ignore-not-found")
          ? ""
          : JSON.stringify({ status: { hard: { "count/jobs.batch": "0" } } });
      if (args[0] === "apply" || args[0] === "delete") return "";
      throw new Error("Unexpected lifecycle Kubernetes operation");
    },
    children: [] as ChildProcess[],
    live() {},
  });
  const emit = (uid: string, terminal = false) =>
    child.stdout.write(
      `${JSON.stringify({
        type: "MODIFIED",
        object: {
          metadata: { name: uid, uid, labels: { "krun.io/function": name } },
          ...(terminal ? { status: { conditions: [{ type: "Complete", status: "True" }] } } : {}),
        },
      })}\n`,
    );
  return {
    h,
    child,
    emit,
    batch: batch.promise,
    stopped: stop.promise,
    finishOnStop(callback: () => void) {
      onStop = callback;
    },
    settleSweep() {
      sweepSettled = true;
    },
    release() {
      for (const reply of held) reply();
    },
    stopHolding() {
      holding = false;
    },
    counts: () => ({ cancels, lateMutations }),
  };
};

it.each(["transport", "validation"] as const)(
  "joins all cancellation siblings before propagating a %s failure",
  async (failure) => {
    const f = fixture(failure);
    let settled = false;
    const running = f.h.run({}).then(
      () => {
        settled = true;
        f.settleSweep();
        return "resolved";
      },
      () => {
        settled = true;
        f.settleSweep();
        return "rejected";
      },
    );
    await f.batch;
    await turn(); // Drain promise continuations, not a timed sleep.
    const escaped = settled;
    f.release();
    expect(await running).toBe("rejected");
    const counts = f.counts();
    f.stopHolding();
    await f.h.close();
    expect(escaped).toBe(false);
    expect(counts).toEqual({ cancels: 10, lateMutations: 0 });
  },
);

it.each(["capacity", "malformed", "error", "exit", "drain", "partial", "late-job"] as const)(
  "rejects a late %s watch failure through final teardown",
  async (failure) => {
    const f = fixture();
    await expect(f.h.run({})).rejects.toThrow("mutation is not replayed");
    const violate = () => {
      if (failure === "capacity") for (let i = 0; i < 6; i++) f.emit(`late-${i}`);
      else if (failure === "late-job") f.emit("post-stop-job");
      else f.child.stdout.write(failure === "partial" ? '{"type":' : "malformed\n");
    };
    if (failure === "exit") f.child.emit("exit", 1, null);
    else if (failure === "error") f.child.emit("error", new Error("Controlled watch failure"));
    else if (["drain", "partial", "late-job"].includes(failure)) f.finishOnStop(violate);
    else violate();
    await expect(f.h.close()).rejects.toThrow(
      failure === "late-job" ? "Nonterminal native Jobs remained" : "Backpressure Job watch failed",
    );
  },
);

it("keeps the watch live until the final native Job settles and joins its close", async () => {
  const f = fixture();
  await expect(f.h.run({})).rejects.toThrow("mutation is not replayed");
  f.emit("last-job");
  let settled = false;
  const closing = f.h.close().finally(() => {
    settled = true;
  });
  await turn();
  const escaped = settled;
  const stoppedEarly = f.child.kill.mock.calls.length;
  f.emit("last-job", true);
  await closing;
  expect(escaped).toBe(false);
  expect(stoppedEarly).toBe(0);
  expect(f.child.signalCode).toBe("SIGTERM");
});
