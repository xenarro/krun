import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { chartAcceptance } from "../e2e/lib/chart-harness.js";
import { recoveryAcceptance } from "../e2e/lib/recovery-harness.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("../e2e/lib/chart-harness.js", () => ({ chartAcceptance: vi.fn() }));

// Explicit command/readiness unit model around the actual factory. Not native
// Kubernetes, replication, or performance evidence; native acceptance is separate.
type Resource = {
  kind: string;
  metadata: { name: string; namespace: string; uid: string; labels: Record<string, string> };
};
const fixture = (fault: string) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const image = `localhost:5001/krun@sha256:${"a".repeat(64)}`;
  const original = {
    metadata: { labels: { original: "kept" } },
    spec: {
      initContainers: [{ name: "migrate", image }],
      containers: [
        { name: "gateway", image },
        { name: "scheduler", image },
      ],
    },
  };
  const m = {
    template: structuredClone(original),
    replicas: 1,
    serving: true,
    uid: 1,
    secret: undefined as Resource | undefined,
    helper: undefined as Resource | undefined,
    helperPhase: "Pending",
    helperReads: 0,
    helperAck: false,
    unsafeRestarts: 0,
    events: [] as string[],
    deletedUids: [] as string[],
    files: new Map<string, string>(),
  };
  const restart = () => {
    if (m.helper && m.helperPhase === "Pending") m.unsafeRestarts++;
    m.serving = true;
    m.uid++;
  };
  vi.mocked(readFileSync).mockImplementation(((file: unknown) => {
    const name = String(file);
    if (name.endsWith("state.json"))
      return JSON.stringify({
        owner,
        mode: "embedded",
        image,
        minioSecrets: ["unit-not-live-key", "unit-not-live-secret"],
      });
    if (name.endsWith("kubeconfig"))
      return JSON.stringify({
        "current-context": "kind-krun-test-e2e",
        clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }],
      });
    const value = m.files.get(name);
    if (value === undefined) throw new Error("Unknown unit file");
    return value;
  }) as unknown as typeof readFileSync);
  vi.mocked(writeFileSync).mockImplementation((file, value) => {
    m.files.set(String(file), String(value));
  });
  vi.mocked(rmSync).mockImplementation((file) => {
    m.files.delete(String(file));
  });
  vi.mocked(chartAcceptance).mockReturnValue({
    waitReady: async () => {
      restart();
      return [{ metadata: { name: "e2e-0", uid: `uid-${m.uid}` } }];
    },
  } as ReturnType<typeof chartAcceptance>);
  const result = (stdout = "", status = 0) =>
    ({
      pid: 0,
      output: [null, stdout, ""],
      stdout,
      stderr: "",
      status,
      signal: null,
    }) as unknown as ReturnType<typeof spawnSync>;
  vi.mocked(spawnSync).mockImplementation(((
    exe: string,
    argv: string[],
    options: { input?: string },
  ) => {
    if (exe === "docker")
      return result(argv[0] === "push" ? `e2e: digest: sha256:${"b".repeat(64)} size: 123` : "");
    if (exe === "helm") {
      if (argv[0] === "history") return result(JSON.stringify([{ revision: 3 }]));
      if (argv[0] === "upgrade") {
        m.template.spec.initContainers = [
          { name: "litestream-restore", image },
          { name: "litestream", image },
          { name: "migrate", image },
        ];
        return result();
      }
      if (argv[0] === "rollback") {
        m.events.push("rollback");
        m.template = structuredClone(original);
        restart();
        return result();
      }
    }
    expect(exe).toBe("kubectl");
    expect(argv).toContain("--kubeconfig");
    expect(argv).toContain("--context");
    const a = [...argv];
    for (const key of ["--kubeconfig", "--context"]) {
      const i = a.indexOf(key);
      a.splice(i, 2);
    }
    if (a[0] === "create") {
      const value = JSON.parse(options.input ?? "{}");
      const type = value.kind === "Secret" ? "secret" : "helper";
      m.events.push(`create-${type}`);
      if (type === "helper" && fault === "helper-unknown-no-commit") return result("", 1);
      const object = { ...value, metadata: { ...value.metadata, uid: `${type}-uid` } };
      if (fault === `${type}-foreign`)
        object.metadata.labels = { "krun.io/e2e-recovery-invocation": "foreign" };
      m[type] = object;
      if (type === "helper") m.helperAck = fault !== "helper-lost-reply";
      return result("", fault === `${type}-lost-reply` || fault === `${type}-foreign` ? 1 : 0);
    }
    if (a[0] === "patch") {
      const file = a[a.indexOf("--patch-file") + 1] ?? "";
      m.template = JSON.parse(m.files.get(file) ?? "{}").spec.template;
      return result();
    }
    if (a[0] === "scale") {
      const zero = a.includes("--replicas=0");
      m.events.push(zero ? "scale-zero" : "scale-one");
      m.replicas = zero ? 0 : 1;
      if (zero) m.serving = false;
      else restart();
      return result();
    }
    if (a[0] === "exec") return result(a.includes("litestream") ? "" : "readable");
    if (a[0] === "logs") return result("krun-test-database-removed-orphans-present");
    if (a[0] === "delete") {
      const raw = a.indexOf("--raw");
      if (raw >= 0) {
        const type = (a[raw + 1] ?? "").includes("/pods/") ? "helper" : "secret";
        const file = a[a.indexOf("--filename") + 1] ?? "";
        const body = JSON.parse(m.files.get(file) ?? "{}");
        expect(body.preconditions.uid).toBe(m[type]?.metadata.uid);
        m.events.push(`delete-${type}`);
        if (type === "helper" && fault === "helper-delete-fails") return result("", 1);
        m.deletedUids.push(body.preconditions.uid);
        m[type] = undefined;
        return result();
      }
      // Original code's unfenced deletes are modeled to reproduce its failure.
      if (a[1] === "secret") {
        m.secret = undefined;
        m.events.push("delete-secret");
      } else if (m.helper && a[2] === m.helper.metadata.name) {
        m.helper = undefined;
        m.events.push("delete-helper");
      } else m.serving = false;
      return result();
    }
    if (a[0] === "get") {
      if (a[1] === "namespace")
        return result(JSON.stringify({ metadata: { labels: { "krun.io/e2e-owner": owner } } }));
      if (a[1] === "statefulset")
        return result(
          JSON.stringify({
            metadata: { name: "e2e", labels: { "app.kubernetes.io/instance": "e2e" } },
            spec: {
              replicas: m.replicas,
              template: m.template,
              volumeClaimTemplates: [{ metadata: { name: "data" } }],
            },
          }),
        );
      if (a[1] === "pods")
        return result(
          JSON.stringify({
            items: m.serving
              ? [{ metadata: { name: "e2e-0", uid: `uid-${m.uid}` }, status: { phase: "Running" } }]
              : [],
          }),
        );
      if (a[1] === "secret") return result(m.secret ? JSON.stringify(m.secret) : "");
      if (a[1] === "pod") {
        if (fault === "helper-read-fails" && m.helper) return result("", 1);
        if (!m.helper) return result("");
        m.helperReads++;
        if (m.helperAck && m.helperReads > 1) m.helperPhase = "Succeeded";
        return result(JSON.stringify({ ...m.helper, status: { phase: m.helperPhase } }));
      }
    }
    throw new Error("Unexpected unit command");
  }) as typeof spawnSync);
  return m;
};
it("runs actual recovery factory cleanup in the safe success order", async () => {
  const m = fixture("normal");
  await recoveryAcceptance().restore("01930000-0000-7000-8000-000000000001");
  expect(m.helper).toBeUndefined();
  expect(m.secret).toBeUndefined();
  expect(m.unsafeRestarts).toBe(0);
  expect(m.events.indexOf("delete-helper")).toBeLessThan(m.events.indexOf("scale-one"));
  expect(m.deletedUids.sort()).toEqual(["helper-uid", "secret-uid"]);
  expect(m.files.size).toBe(0);
});
it.each(["helper-lost-reply", "secret-lost-reply"])(
  "reconciles accepted create after %s without restarting beside a helper",
  async (fault) => {
    const m = fixture(fault);
    await expect(
      recoveryAcceptance().restore("01930000-0000-7000-8000-000000000001"),
    ).rejects.toThrow();
    expect(m.helper).toBeUndefined();
    expect(m.secret).toBeUndefined();
    expect(m.unsafeRestarts).toBe(0);
  },
);
it.each(["helper-delete-fails", "helper-read-fails", "helper-foreign", "helper-unknown-no-commit"])(
  "keeps the PVC workload stopped when helper absence is unproven: %s",
  async (fault) => {
    const m = fixture(fault);
    await expect(
      recoveryAcceptance().restore("01930000-0000-7000-8000-000000000001"),
    ).rejects.toThrow();
    expect(m.events).not.toContain("scale-one");
    expect(m.events).not.toContain("rollback");
    expect(m.replicas).toBe(0);
    expect(m.unsafeRestarts).toBe(0);
    if (fault === "helper-foreign") expect(m.events).not.toContain("delete-helper");
  },
);
it("never deletes/adopts a pre-existing foreign Secret after create collision", async () => {
  const m = fixture("secret-foreign");
  await expect(
    recoveryAcceptance().restore("01930000-0000-7000-8000-000000000001"),
  ).rejects.toThrow();
  expect(m.secret).toBeDefined();
  expect(m.events).not.toContain("delete-secret");
  expect(m.events).not.toContain("rollback");
});
