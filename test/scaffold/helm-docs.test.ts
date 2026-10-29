import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const chart = "deploy/helm/krun";
const directories: string[] = [];

function text(base: string, path: string): string {
  return readFileSync(join(base, path), "utf8");
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "krun-test-helm-docs-"));
  directories.push(directory);
  mkdirSync(join(directory, chart), { recursive: true });
  mkdirSync(join(directory, "scripts"));
  for (const path of [
    "Makefile",
    "scripts/gen-helm-docs.ts",
    `${chart}/Chart.yaml`,
    `${chart}/values.yaml`,
    `${chart}/README.md.gotmpl`,
    `${chart}/README.md`,
  ]) {
    copyFileSync(join(root, path), join(directory, path));
  }
  return directory;
}

function generate(directory: string, env = process.env) {
  return spawnSync(process.execPath, [join(directory, "scripts/gen-helm-docs.ts")], {
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function rows(
  markdown: string,
): Map<string, { type: string; value: unknown; description: string }> {
  const result = new Map<string, { type: string; value: unknown; description: string }>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Key ") || line.startsWith("|---")) continue;
    const fields = line.split(" | ");
    const key = fields[0]!.slice(2);
    expect(result.has(key), `duplicate documentation key ${key}`).toBe(false);
    expect(fields).toHaveLength(4);
    const encoded = fields[2]!;
    expect(encoded.startsWith("`") && encoded.endsWith("`")).toBe(true);
    result.set(key, {
      type: fields[1]!,
      value: JSON.parse(encoded.slice(1, -1)),
      description: fields[3]!.replace(/ \|$/, ""),
    });
  }
  return result;
}

// helm-docs documents a described list as one value, with its complete default.
// Nonempty maps remain groups: every scalar, empty map and list gets its own row.
function values(value: unknown, prefix = ""): Map<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      return new Map(
        entries.flatMap(([key, child]) => {
          const segment = /[. ]/.test(key) ? `"${key}"` : key;
          return [...values(child, prefix ? `${prefix}.${segment}` : segment)];
        }),
      );
    }
  }
  return new Map([[prefix, value]]);
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("documents every actual value exactly once, with the real default, type and a description", () => {
  const actual = rows(text(root, `${chart}/README.md`));
  const expected = values(parse(text(root, `${chart}/values.yaml`)));
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [key, value] of expected) {
    const row = actual.get(key)!;
    expect(row.value, key).toEqual(value);
    const type = Array.isArray(value)
      ? "list"
      : typeof value === "object"
        ? "object"
        : typeof value === "boolean"
          ? "bool"
          : typeof value === "number"
            ? Number.isInteger(value)
              ? "int"
              : "float"
            : "string";
    expect(row.type, key).toBe(type);
    expect(row.description.length, `missing description for ${key}`).toBeGreaterThan(12);
  }
});

it("regenerates the committed README through actual make generate, twice without drift", () => {
  const directory = fixture();
  const expected = text(directory, `${chart}/README.md`);
  rmSync(join(directory, `${chart}/README.md`));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync("make", ["generate"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(text(directory, `${chart}/README.md`)).toBe(expected);
  }
  for (const path of ["Chart.yaml", "values.yaml", "README.md.gotmpl"]) {
    expect(text(directory, `${chart}/${path}`)).toBe(text(root, `${chart}/${path}`));
  }
});

it("derives new keys, changed zero defaults and changed descriptions from values.yaml", () => {
  const directory = fixture();
  writeFileSync(
    join(directory, `${chart}/values.yaml`),
    text(directory, `${chart}/values.yaml`)
      .replace('tracesSampleRatio: "0.1"', 'tracesSampleRatio: "0"')
      .replace(
        "Parent-based root trace sampling ratio from zero to one, preserved as a string, including zero; used only with a non-empty OTLP endpoint.",
        "Changed fixture-only sampling description.",
      ) + "\n# -- A fixture-only new documented value.\ndocumentationProbe: false\n",
  );
  const result = generate(directory);
  expect(result.status, result.stderr).toBe(0);
  const actual = rows(text(directory, `${chart}/README.md`));
  expect(actual.get("observability.tracesSampleRatio")?.value).toBe("0");
  expect(actual.get("observability.tracesSampleRatio")?.description).toBe(
    "Changed fixture-only sampling description.",
  );
  expect(actual.get("documentationProbe")).toEqual({
    type: "bool",
    value: false,
    description: "A fixture-only new documented value.",
  });
});

it("derives chart metadata and prose from their source, not a hand-maintained table", () => {
  const directory = fixture();
  writeFileSync(
    join(directory, `${chart}/Chart.yaml`),
    text(directory, `${chart}/Chart.yaml`).replace("version: 0.0.0", "version: 0.0.1"),
  );
  writeFileSync(
    join(directory, `${chart}/README.md.gotmpl`),
    text(directory, `${chart}/README.md.gotmpl`) + "\nFixture-only operator note.\n",
  );
  const result = generate(directory);
  expect(result.status, result.stderr).toBe(0);
  const actual = text(directory, `${chart}/README.md`);
  expect(actual).toContain("0.0.1");
  expect(actual).toContain("Fixture-only operator note.");
});

it("uses its repository path even from another cwd and leaves unrelated charts untouched", () => {
  const directory = fixture();
  const unrelated = join(directory, "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "Chart.yaml"), "apiVersion: v2\nname: unrelated\nversion: 1.0.0\n");
  writeFileSync(join(unrelated, "README.md"), "Do not change this chart.\n");
  const result = spawnSync(process.execPath, [join(directory, "scripts/gen-helm-docs.ts")], {
    cwd: unrelated,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(text(directory, `${chart}/README.md`)).toBe(text(root, `${chart}/README.md`));
  expect(text(unrelated, "README.md")).toBe("Do not change this chart.\n");
});

it.each([
  "values",
  "template",
  "missing-chart",
  "missing-template",
  "missing-binary",
  "undocumented",
])("fails closed for %s without overwriting a valid README", (failure) => {
  const directory = fixture();
  const before = text(directory, `${chart}/README.md`);
  if (failure === "values") writeFileSync(join(directory, `${chart}/values.yaml`), "broken: [\n");
  if (failure === "template")
    writeFileSync(join(directory, `${chart}/README.md.gotmpl`), "{{ broken");
  if (failure === "missing-chart") rmSync(join(directory, `${chart}/Chart.yaml`));
  if (failure === "missing-template") rmSync(join(directory, `${chart}/README.md.gotmpl`));
  if (failure === "undocumented") {
    writeFileSync(
      join(directory, `${chart}/values.yaml`),
      text(directory, `${chart}/values.yaml`) + "\nundocumentedFixtureValue: true\n",
    );
  }
  const result = generate(
    directory,
    failure === "missing-binary" ? { ...process.env, PATH: "" } : process.env,
  );
  expect(result.status, result.stdout).not.toBe(0);
  expect(text(directory, `${chart}/README.md`)).toBe(before);
});

it.each([
  ["empty", ""],
  ["whitespace", " \n\t "],
  ["prose-only", "An incomplete operator note."],
  ["header-only", '{{ template "chart.header" . }}'],
  [
    "missing-values",
    text(root, `${chart}/README.md.gotmpl`).replace('{{ template "chart.valuesSection" . }}', ""),
  ],
  [
    "wrong-header",
    text(root, `${chart}/README.md.gotmpl`).replace(
      '{{ template "chart.header" . }}',
      "# wrong-chart",
    ),
  ],
  [
    "duplicate-values",
    text(root, `${chart}/README.md.gotmpl`) + '\n{{ template "chart.valuesSection" . }}',
  ],
  [
    "wrong-default",
    text(root, `${chart}/README.md`).replace(
      "| config.maxRunning | int | `100` |",
      "| config.maxRunning | int | `101` |",
    ),
  ],
])(
  "rejects %s template output through make generate without replacing the README",
  (_name, template) => {
    const directory = fixture();
    const before = text(directory, `${chart}/README.md`);
    writeFileSync(join(directory, `${chart}/README.md.gotmpl`), template);
    const result = spawnSync("make", ["generate"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(text(directory, `${chart}/README.md`)).toBe(before);
  },
);

it("rejects undocumented values even when the editable template removes its own guard", () => {
  const directory = fixture();
  const before = text(directory, `${chart}/README.md`);
  writeFileSync(join(directory, `${chart}/README.md.gotmpl`), before);
  writeFileSync(
    join(directory, `${chart}/values.yaml`),
    text(directory, `${chart}/values.yaml`) + "\nundocumentedFixtureValue: true\n",
  );
  const result = generate(directory);
  expect(result.status).not.toBe(0);
  expect(text(directory, `${chart}/README.md`)).toBe(before);
});

it("preserves legitimate escaped newlines in generated default values", () => {
  const directory = fixture();
  writeFileSync(
    join(directory, `${chart}/values.yaml`),
    text(directory, `${chart}/values.yaml`) +
      '\n# -- A fixture with a real newline default.\nescapedDocumentationValue: "first\\nsecond"\n',
  );
  const result = generate(directory);
  expect(result.status, result.stderr).toBe(0);
  expect(text(directory, `${chart}/README.md`)).toContain("first\\nsecond");
});

it("documents the actual embedded PVC/database paths from the rendered containers", () => {
  const result = spawnSync(
    "helm",
    [
      "template",
      "krun-test-docs",
      join(root, chart),
      "--set",
      "apiKeys.existingSecret=krun-test-docs-keys",
      "--set",
      "db.mode=embedded",
      "--set",
      "gateway.replicas=1",
      "--set",
      "scheduler.replicas=1",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const statefulset = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON())
    .find((document) => document?.kind === "StatefulSet");
  const readme = text(root, `${chart}/README.md`);
  expect(readme).toContain("shared PVC is mounted at `/data`");
  expect(readme).toContain("`/data/krun.db`");
  expect(readme).not.toContain("/var/lib/krun");
  for (const container of [
    ...statefulset.spec.template.spec.initContainers,
    ...statefulset.spec.template.spec.containers,
  ]) {
    expect(
      container.volumeMounts.find((mount: { name: string }) => mount.name === "data").mountPath,
    ).toBe("/data");
    expect(container.env.find((env: { name: string }) => env.name === "KRUN_DB_PATH").value).toBe(
      "/data/krun.db",
    );
  }
});

it.each(["postgres", "embedded"])(
  "documents wired storage/webhook values against actual %s serving env",
  (mode) => {
    const settings = {
      apiKeys: { existingSecret: "krun-test-docs-keys" },
      db: { mode, postgres: { existingSecret: "krun-test-docs-db" } },
      gateway: { replicas: 1 },
      objectStorage: {
        enabled: true,
        endpoint: "http://store.example.test:9000",
        bucket: "krun-test-docs",
        region: "us-east-1",
        existingSecret: "krun-test-docs-storage",
      },
      webhooks: {
        allowedHosts: ["callback.example.test"],
        allowedCIDRs: ["192.0.2.0/24"],
        existingSecret: "krun-test-docs-webhook",
      },
    };
    const result = spawnSync(
      "helm",
      ["template", "krun-test-docs", join(root, chart), "--set-json", JSON.stringify(settings)],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const serving = parseAllDocuments(result.stdout)
      .map((document) => document.toJSON())
      .filter((document) => ["Deployment", "StatefulSet"].includes(document?.kind))
      .flatMap((document) => document.spec.template.spec.containers);
    expect(serving).toHaveLength(2);
    for (const container of serving) {
      expect(
        container.env.filter(
          (env: { name: string }) =>
            [
              "KRUN_S3_ENDPOINT",
              "KRUN_S3_BUCKET",
              "KRUN_S3_REGION",
              "KRUN_S3_ACCESS_KEY",
              "KRUN_S3_SECRET_KEY",
            ].includes(env.name) || env.name.startsWith("KRUN_WEBHOOK_"),
        ),
      ).toHaveLength(container.name === "scheduler" ? 8 : 7);
      expect(
        container.env.find((env: { name: string }) => env.name === "KRUN_S3_REGION").value,
      ).toBe("us-east-1");
      expect(
        container.env.find((env: { name: string }) => env.name === "KRUN_WEBHOOK_SECRET"),
      ).toEqual(
        container.name === "scheduler"
          ? {
              name: "KRUN_WEBHOOK_SECRET",
              valueFrom: { secretKeyRef: { name: "krun-test-docs-webhook", key: "secret" } },
            }
          : undefined,
      );
    }
    const readme = text(root, `${chart}/README.md`);
    expect(readme).toContain("S3 settings are wired into both serving processes");
    expect(readme).toContain("no runtime region default");
    for (const key of [
      "objectStorage.enabled",
      "objectStorage.endpoint",
      "objectStorage.bucket",
      "objectStorage.region",
      "objectStorage.existingSecret",
      "webhooks.allowedHosts",
      "webhooks.allowedCIDRs",
      "webhooks.existingSecret",
    ]) {
      expect(rows(readme).get(key)?.description).not.toContain("not wired");
    }
  },
);

it("propagates generator errors through make generate", () => {
  const directory = fixture();
  rmSync(join(directory, `${chart}/README.md.gotmpl`));
  const result = spawnSync("make", ["generate"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status).not.toBe(0);
});

it("documents retained ownership, safe reinstall and the plain operator-managed CRD", () => {
  const readme = text(root, `${chart}/README.md`);
  for (const phrase of [
    "crds.install=false",
    "crds.keep=true",
    "deleting it deletes every Function",
    "same\nrelease name/namespace",
    "kubectl apply -f deploy/crds/functions.krun.io.yaml",
    "kubectl annotate crd functions.krun.io",
    "kubectl annotate namespace JOBS_NAMESPACE",
    "meta.helm.sh/release-name=RELEASE",
    "meta.helm.sh/release-namespace=PLATFORM_NAMESPACE --overwrite",
  ])
    expect(readme).toContain(phrase);
});

it("installs the pinned checksum-verified real generator before CI tests and generation", () => {
  const workflow = parse(text(root, ".github/workflows/ci.yml"));
  const steps = workflow.jobs.verify.steps as { name?: string; run?: string }[];
  const install = steps.findIndex((step) => step.name === "Install helm-docs");
  expect(install).toBeGreaterThan(-1);
  expect(install).toBeLessThan(steps.findIndex((step) => step.run === "make check"));
  const command = steps[install]!.run!;
  expect(command).toContain("/v1.14.2/helm-docs_1.14.2_Linux_x86_64.tar.gz");
  expect(command).toContain("a8cf72ada34fad93285ba2a452b38bdc5bd52cc9a571236244ec31022928d6cc");
  expect(command).toContain("sha256sum --check");
  expect(command).toContain("GITHUB_PATH");
  expect(command.indexOf("sha256sum --check")).toBeLessThan(command.indexOf("tar -xzf"));
});
