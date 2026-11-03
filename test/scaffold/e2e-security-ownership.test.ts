import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { securityKey } from "../e2e/lib/security.js";
import { securityAcceptance } from "../e2e/lib/security-harness.js";

type Mode =
  | "foreign201"
  | "foreign500"
  | "own500"
  | "creator201"
  | "undeclared201"
  | "own201"
  | "redirect"
  | "child"
  | "cancel-status"
  | "cancel-identity"
  | "before-identity"
  | "terminal-identity"
  | "terminal-creator"
  | "residue";
const rejection = (reason: "RUN_NOT_FOUND" | "TOKEN_INVALID" | "CALLBACK_NOT_ALLOWED") => {
  const [code, status, message] = {
    RUN_NOT_FOUND: [404, "NOT_FOUND", "Run not found"],
    TOKEN_INVALID: [401, "UNAUTHENTICATED", "Token invalid"],
    CALLBACK_NOT_ALLOWED: [400, "INVALID_ARGUMENT", "Callback is not allowed"],
  }[reason];
  return {
    error: {
      code,
      status,
      message,
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "krun.io" },
        ...(reason === "CALLBACK_NOT_ALLOWED"
          ? [
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [
                  { field: "callback.url", description: "Callback is not allowed" },
                ],
              },
            ]
          : []),
      ],
    },
  };
};
const exercise = async (mode: Mode) => {
  const name = "krun-test-security-ownership";
  const key = randomBytes(32).toString("hex");
  const owner = securityKey(key, "owner"),
    other = securityKey(key, "other");
  const childMode = [
    "child",
    "cancel-status",
    "cancel-identity",
    "before-identity",
    "terminal-identity",
    "terminal-creator",
    "residue",
  ].includes(mode);
  const rows = ["owner", "other", "child"].map((principal, index) => ({
    name: `functions/${name}${principal === "child" ? "-schema" : ""}/runs/0192f000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    state: "RUNNING",
    attempt: 1,
    priority: 0,
    createdBy: principal === "other" ? "e2e-security-other" : "e2e-security-owner",
    createTime: "2026-01-01T00:00:00.000Z",
    input: { fixture: principal === "other" ? 2 : 1 },
    runtimeStatus: { message: "holding", reportTime: "2026-01-01T00:00:00.000Z" },
  }));
  const first = rows[0],
    second = rows[1],
    child = rows[2];
  if (!first || !second || !child) throw new Error("Missing controlled fixture");
  const foreign = {
    ...first,
    name: "functions/krun-test-unrelated/runs/0192f000-0000-7000-8000-000000000009",
    createdBy: "foreign-principal",
  };
  const stats = {
    creates: 0,
    tracked: 0,
    foreignMutations: 0,
    cancellations: 0,
    adminCancellations: 0,
    ownerCancellations: 0,
    childReads: 0,
    readsAfterCancel: 0,
    inventoryReads: 0,
    functionsRemoved: 0,
  };
  const applied = new Map<string, unknown>();
  const reply = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url?.slice("/v1/".length) ?? "";
      if (path.endsWith(":cancel")) {
        stats.cancellations++;
        if (path !== `${child.name}:cancel`) stats.foreignMutations++;
        if (req.headers.authorization === `Bearer ${key}`) stats.adminCancellations++;
        if (req.headers.authorization === `Bearer ${owner}`) stats.ownerCancellations++;
        reply(
          res,
          mode === "cancel-identity" ? foreign : { ...child, state: "CANCELLING" },
          mode === "cancel-status" ? 500 : 200,
        );
      } else if (req.method === "POST") {
        stats.creates++;
        if (!childMode) {
          if (stats.creates > 1) return reply(res, { error: {} }, 500);
          if (mode === "redirect") {
            res.writeHead(307, { location: `/v1/${foreign.name}:cancel` });
            res.end();
            return;
          }
          const body =
            mode === "own201" || mode === "own500"
              ? first
              : mode === "creator201"
                ? { ...first, createdBy: "e2e-security-other" }
                : mode === "undeclared201"
                  ? child
                  : foreign;
          return reply(res, body, mode.endsWith("500") ? 500 : 201);
        }
        if (stats.creates <= 2) return reply(res, stats.creates === 1 ? first : second, 201);
        if (path === `functions/${name}/runs`)
          return reply(res, rejection("CALLBACK_NOT_ALLOWED"), 400);
        return reply(res, child, 201);
      } else if (path === child.name) {
        stats.childReads++;
        if (stats.cancellations) stats.readsAfterCancel++;
        reply(
          res,
          mode === "before-identity" || (stats.cancellations && mode === "terminal-identity")
            ? foreign
            : {
                ...child,
                state: stats.cancellations ? "CANCELLED" : "RUNNING",
                createdBy:
                  stats.cancellations && mode === "terminal-creator"
                    ? "foreign-principal"
                    : child.createdBy,
              },
        );
      } else {
        const run = rows.find((r) => r.name === path);
        if (!run) return reply(res, { error: {} }, 404);
        const authorized = req.headers.authorization === `Bearer ${run === second ? other : owner}`;
        reply(res, authorized ? run : rejection("RUN_NOT_FOUND"), authorized ? 200 : 404);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing controlled listener");
  const h = securityAcceptance({
    name,
    namespace: "krun-test-owned",
    jobsNamespace: "krun-test-owned-jobs",
    kubeconfig: "/krun-test-owned/config",
    url: `http://127.0.0.1:${address.port}`,
    key,
    mode: "embedded",
    live() {
      stats.tracked++;
    },
    async pod(run) {
      return run.name === first.name ? "pod-first" : "pod-second";
    },
    privateYaml() {
      /* Controlled transport fixture, not native privacy evidence. */
    },
    kube(args, operation, input) {
      if (operation === "Read owned security Function")
        return JSON.stringify(
          applied.get(args[2] ?? "") ?? {
            metadata: { generation: 1 },
            spec: { image: `example.invalid/fixture@sha256:${"a".repeat(64)}` },
          },
        );
      if (operation === "Read actual Job Pod YAML privately") return "fixture: true";
      if (operation === "Actual Job token request") {
        const target = rows.find((r) => r.name.endsWith(`/${input?.trim()}`));
        if (!target) throw new Error("Unowned controlled input read");
        const own = args[4] === "pod-first" ? first : second;
        const status = own === target ? 200 : 401;
        return `${JSON.stringify(status === 200 ? target.input : rejection("TOKEN_INVALID"))}\nkrun-security-status:${status}`;
      }
      if (operation === "Apply owned security Function") {
        const value = JSON.parse(input ?? "{}");
        applied.set(value.metadata.name, {
          metadata: { generation: 1 },
          spec: value.spec,
          status: {
            observedGeneration: 1,
            conditions: [{ type: "Ready", status: "False", reason: "SchemaInvalid" }],
          },
        });
        return "";
      }
      if (operation === "Clean owned rejected Function") {
        applied.delete(args[2] ?? "");
        stats.functionsRemoved++;
        return "";
      }
      if (operation === "Read back rejected Function cleanup") return "";
      if (operation === "Read owned unexpected Run cleanup inventory") {
        if (
          args[1] !== "jobs,secrets" ||
          args[3] !== "krun-test-owned-jobs" ||
          !args.includes(
            `krun.io/function-name=${name}-schema,krun.io/run-id=${child.name.split("/").at(-1)}`,
          )
        )
          throw new Error("Cleanup inventory escaped exact ownership");
        stats.inventoryReads++;
        return JSON.stringify({
          items: mode === "residue" && stats.inventoryReads === 1 ? [{}] : [],
        });
      }
      throw new Error("Unexpected controlled Kubernetes boundary");
    },
  });
  let failed = false,
    closeFailed = false;
  try {
    try {
      await h.run({ fixture: 1 }, { fixture: 2 });
    } catch {
      failed = true;
    }
    try {
      await h.close();
    } catch {
      closeFailed = true;
    }
    return { ...stats, failed, closeFailed };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
};

for (const mode of [
  "foreign201",
  "foreign500",
  "own500",
  "creator201",
  "undeclared201",
  "redirect",
] as const) {
  it(`never treats ${mode} as ownership or follows it into privileged cleanup`, async () => {
    const value = await exercise(mode);
    expect(value.failed).toBe(true);
    expect(value.closeFailed).toBe(false);
    expect(value.tracked).toBe(0);
    expect(value.foreignMutations).toBe(0);
    expect(value.cancellations).toBe(0);
  });
}
it("retains a successful exact-parent/exact-creator own admission", async () => {
  const value = await exercise("own201");
  expect(value.failed).toBe(true);
  expect(value.closeFailed).toBe(false);
  expect(value.tracked).toBe(1);
  expect(value.cancellations).toBe(0);
});
for (const mode of ["child", "residue"] as const)
  it(`cleans declared unexpected admissions through the owner and complete readback: ${mode}`, async () => {
    const value = await exercise(mode);
    expect(value.failed).toBe(true);
    expect(value.closeFailed).toBe(false);
    expect(value.tracked).toBe(2);
    expect(value.cancellations).toBe(1);
    expect(value.foreignMutations).toBe(0);
    expect(value.adminCancellations).toBe(0);
    expect(value.ownerCancellations).toBe(1);
    expect(value.childReads).toBeGreaterThanOrEqual(2);
    expect(value.readsAfterCancel).toBeGreaterThanOrEqual(1);
    expect(value.inventoryReads).toBe(mode === "residue" ? 2 : 1);
    expect(value.functionsRemoved).toBe(1);
  });
for (const mode of [
  "cancel-status",
  "cancel-identity",
  "before-identity",
  "terminal-identity",
  "terminal-creator",
] as const)
  it(`rejects inconsistent cleanup ${mode} and still removes owned Functions`, async () => {
    const value = await exercise(mode);
    expect(value.failed).toBe(true);
    expect(value.closeFailed).toBe(true);
    expect(value.adminCancellations).toBe(0);
    expect(value.foreignMutations).toBe(0);
    expect(value.cancellations).toBe(mode === "before-identity" ? 0 : 1);
    expect(value.functionsRemoved).toBe(1);
  });
