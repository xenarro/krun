import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
const release = "krun-test-network-policy";
const platform = "krun-test-platform";
const jobs = "krun-test-jobs";
const runHelm = (
  mode: string,
  values: Record<string, unknown> = {},
  notes = false,
  namespace = platform,
) => {
  const r = spawnSync(
    "helm",
    [
      ...(notes
        ? ["install", "--dry-run=client", "--kubeconfig", "/dev/null", "--output", "json"]
        : ["template"]),
      release,
      chart,
      "--namespace",
      namespace,
      "--set",
      "apiKeys.existingSecret=krun-test-unused",
      "--set",
      "db.postgres.existingSecret=krun-test-unused",
      "--set",
      `db.mode=${mode}`,
      "--set",
      "gateway.replicas=1",
      "--set-json",
      JSON.stringify({
        ...values,
        jobsNamespace: { name: jobs, ...((values.jobsNamespace as Record<string, unknown>) ?? {}) },
      }),
    ],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};
const render = (mode: string, values: Record<string, unknown> = {}, namespace = platform) =>
  parseAllDocuments(runHelm(mode, values, false, namespace))
    .filter((d) => d.contents !== null)
    .map((d) => {
      expect(d.errors).toEqual([]);
      return d.toJSON();
    })
    .filter((d) => d.kind === "NetworkPolicy");
const policy = (docs: ReturnType<typeof render>, name: string) => {
  const p = docs.find((d) => d.metadata.name === name);
  expect(p, name).toBeDefined();
  return p;
};
const port = (n: number, protocol = "TCP") => ({ protocol, port: n });
const ns = (name: string) => ({ matchLabels: { "kubernetes.io/metadata.name": name } });
const labels = { "app.kubernetes.io/name": "krun", "app.kubernetes.io/instance": release };
const gateway = { ...labels, "krun.io/gateway": "true" };
const storage = {
  enabled: true,
  endpoint: "http://storage.example.test:9000",
  bucket: "krun-test",
  existingSecret: "krun-test-unused",
  egress: [{ ipBlock: { cidr: "192.0.2.0/24" } }],
};

for (const mode of ["postgres", "embedded"]) {
  for (const create of [true, false]) {
    it(`isolates only release pods and exposes exact ingress in ${mode}, create=${create}`, () => {
      const docs = render(mode, { jobsNamespace: { create } });
      const own = docs.filter((d) => d.metadata.namespace === platform);
      expect(own.map((d) => d.metadata.name).sort()).toEqual([
        "krun-allow-admin",
        "krun-allow-internal",
        "krun-allow-public",
        "krun-deny-ingress",
      ]);
      for (const p of own) {
        expect(p.apiVersion).toBe("networking.k8s.io/v1");
        expect(p.metadata.labels["app.kubernetes.io/instance"]).toBe(release);
        expect(p.spec.policyTypes).toEqual(["Ingress"]);
        expect(p.spec.egress).toBeUndefined();
        expect(p.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
      }
      expect(policy(docs, "krun-deny-ingress").spec).toEqual({
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress"],
      });
      expect(policy(docs, "krun-allow-public").spec).toEqual({
        podSelector: { matchLabels: gateway },
        policyTypes: ["Ingress"],
        ingress: [{ ports: [port(8080)] }],
      });
      expect(policy(docs, "krun-allow-internal").spec).toEqual({
        podSelector: { matchLabels: gateway },
        policyTypes: ["Ingress"],
        ingress: [{ from: [{ namespaceSelector: ns(jobs) }], ports: [port(8081)] }],
      });
      expect(policy(docs, "krun-allow-admin").spec).toEqual({
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress"],
        ingress: [{ ports: mode === "embedded" ? [port(9090), port(9091)] : [port(9090)] }],
      });
    });
    it(`gates only the exact jobs policies in ${mode}, create=${create}`, () => {
      const docs = render(mode, {
        jobsNamespace: { create },
        config: { maxRunning: create ? 100 : 300 },
      });
      const own = docs.filter((d) => d.metadata.namespace === jobs);
      expect(own.map((d) => d.metadata.name).sort()).toEqual(
        create ? ["krun-jobs-allow-dns", "krun-jobs-allow-gateway", "krun-jobs-deny-all"] : [],
      );
      if (!create) return;
      expect(policy(docs, "krun-jobs-deny-all").spec).toEqual({
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      });
      expect(policy(docs, "krun-jobs-allow-dns").spec).toEqual({
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: ns("kube-system"),
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [port(53, "UDP"), port(53)],
          },
        ],
      });
      expect(policy(docs, "krun-jobs-allow-gateway").spec).toEqual({
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: ns(platform),
                podSelector: { matchLabels: { "krun.io/gateway": "true" } },
              },
            ],
            ports: [port(8081)],
          },
        ],
      });
      for (const p of own) expect(p.spec.ingress).toBeUndefined();
    });
  }
  it.each(["true", "null"])(
    `quotes namespace identities and keeps policy identities distinct for %s in ${mode}`,
    (namespace) => {
      const docs = render(mode, { jobsNamespace: { name: namespace } }, namespace);
      expect(new Set(docs.map((p) => `${p.metadata.namespace}/${p.metadata.name}`)).size).toBe(
        docs.length,
      );
      expect(docs.every((p) => p.metadata.namespace === namespace)).toBe(true);
      expect(
        policy(docs, "krun-jobs-allow-gateway").spec.egress[0].to[0].namespaceSelector,
      ).toEqual(ns(namespace));
      expect(policy(docs, "krun-allow-internal").spec.ingress[0].from[0].namespaceSelector).toEqual(
        ns(namespace),
      );
    },
  );
  it(`keeps release ingress but no jobs-scope policies for an external coincident namespace in ${mode}`, () => {
    const docs = render(mode, {
      jobsNamespace: { name: platform, create: false },
      config: { maxRunning: 300 },
    });
    expect(docs.map((d) => d.metadata.name).sort()).toEqual([
      "krun-allow-admin",
      "krun-allow-internal",
      "krun-allow-public",
      "krun-deny-ingress",
    ]);
    expect(docs.every((d) => d.metadata.namespace === platform)).toBe(true);
    expect(policy(docs, "krun-allow-internal").spec.ingress[0].from).toEqual([
      { namespaceSelector: ns(platform) },
    ]);
  });
  it(`preserves custom DNS peers including NodeLocal ipBlock and AND shape in ${mode}`, () => {
    const peers = [
      {
        namespaceSelector: ns("krun-test-dns"),
        podSelector: { matchExpressions: [{ key: "dns", operator: "In", values: ["yes"] }] },
      },
      { ipBlock: { cidr: "169.254.20.10/32" } },
    ];
    expect(
      policy(render(mode, { jobsNamespace: { dnsEgress: peers } }), "krun-jobs-allow-dns").spec
        .egress,
    ).toEqual([{ to: peers, ports: [port(53, "UDP"), port(53)] }]);
  });
  it(`empty explicit DNS and storage peers grant no destination in ${mode}`, () => {
    const docs = render(mode, {
      jobsNamespace: { dnsEgress: [] },
      objectStorage: { ...storage, egress: [] },
    });
    for (const name of ["krun-jobs-allow-dns", "krun-jobs-allow-object-storage"])
      expect(policy(docs, name).spec.egress).toEqual([]);
  });
  it(`wraps extra CIDRs in ipBlock with except and no port restriction in ${mode}`, () => {
    const cidrs = [
      { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "192.168.0.0/16"] },
      { cidr: "2001:db8::/32", except: ["2001:db8:1::/48"] },
    ];
    expect(
      policy(
        render(mode, { jobsNamespace: { egressCIDRs: cidrs } }),
        "krun-jobs-allow-egress-cidrs",
      ).spec,
    ).toEqual({
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [{ to: cidrs.map((ipBlock) => ({ ipBlock })) }],
    });
  });
  it(`copies storage selector peers and metrics selector bodies verbatim in ${mode}`, () => {
    const peers = [
      { namespaceSelector: ns("krun-test-minio"), podSelector: { matchLabels: { app: "minio" } } },
      { ipBlock: { cidr: "192.0.2.0/24", except: ["192.0.2.64/26"] } },
    ];
    const metrics = {
      matchLabels: { monitoring: "true" },
      matchExpressions: [{ key: "environment", operator: "NotIn", values: ["untrusted"] }],
    };
    const docs = render(mode, {
      objectStorage: { ...storage, egress: peers },
      networkPolicy: { metricsFrom: metrics },
    });
    expect(policy(docs, "krun-jobs-allow-object-storage").spec.egress).toEqual([
      { to: peers, ports: [port(9000)] },
    ]);
    expect(policy(docs, "krun-allow-admin").spec.ingress[0].from).toEqual([
      { namespaceSelector: metrics },
    ]);
  });
  it.each([
    ["http://storage.example.test", 80],
    ["https://storage.example.test", 443],
    ["http://storage.example.test:9000", 9000],
    ["https://storage.example.test:9443/path", 9443],
    ["https://storage.example.test/path:9000?hint=:80", 443],
    ["https://[2001:db8::1]", 443],
    ["http://[2001:db8::1]:9000/path", 9000],
    ["HTTPS://storage.example.test/path", 443],
    ["https://storage.example.test:80", 80],
    ["http:storage.example.test:9000", 9000],
    ["https:storage.example.test:9443", 9443],
    ["http:/storage.example.test:9000", 9000],
    ["https:///storage.example.test:9443", 9443],
    ["http:////storage.example.test:9000", 9000],
    ["https:\\storage.example.test:9443", 9443],
    ["http:\\\\storage.example.test:9000", 9000],
    ["https://storage.example.test:9443\\path:9000", 9443],
    ["http:[2001:db8::1]:9000", 9000],
    ["https:/[2001:db8::1]:9443", 9443],
    ["HTTPS:storage.example.test:9443", 9443],
    ["http:storage.example.test", 80],
    ["https:storage.example.test", 443],
    ["  https:storage.example.test:9443  ", 9443],
    ["h\tttps:storage.example.test:94\r\n43", 9443],
    ["https:storage.example.test:0009443", 9443],
    ["https:storage.example.test:", 443],
    ["http://%73torage.example.test:9000", 9000],
    ["https://%73torage.example.test:9443", 9443],
    ["\u0001http:storage.example.test:9000\u001f", 9000],
  ])(`parses storage endpoint %s as exact port %s in ${mode}`, (endpoint, expected) => {
    expect(
      policy(
        render(mode, { objectStorage: { ...storage, endpoint } }),
        "krun-jobs-allow-object-storage",
      ).spec.egress[0].ports,
    ).toEqual([port(expected)]);
  });
  it(`no optional jobs egress survives create=false or storage disabled in ${mode}`, () => {
    const external = render(mode, {
      jobsNamespace: { create: false, egressCIDRs: [{ cidr: "192.0.2.0/24" }] },
      objectStorage: storage,
    });
    expect(external.filter((d) => d.metadata.namespace === jobs)).toEqual([]);
    expect(
      render(mode, { objectStorage: { ...storage, enabled: false } }).some(
        (d) => d.metadata.name === "krun-jobs-allow-object-storage",
      ),
    ).toBe(false);
  });
  it.each([
    ["0.0.0.0/0", undefined, true],
    ["::/0", [], true],
    ["0.0.0.0/0", ["10.0.0.0/8"], false],
    ["::/0", ["fc00::/7"], false],
    ["192.0.2.0/24", undefined, false],
  ])(`NOTES warns only for unrestricted CIDR %s, except=%j in ${mode}`, (cidr, except, warn) => {
    const output = JSON.parse(
      runHelm(
        mode,
        {
          jobsNamespace: { create: false, egressCIDRs: [{ cidr, ...(except ? { except } : {}) }] },
        },
        true,
      ),
    );
    const notes = output.info.notes ?? "";
    expect(notes.includes("WARNING")).toBe(warn);
    if (warn) {
      expect(notes).toContain(cidr);
      expect(notes).toContain("jobsNamespace.egressCIDRs");
    }
  });
}
