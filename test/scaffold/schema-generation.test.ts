import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { afterEach, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { durationToMilliseconds } from "../../packages/shared/src/config/duration.ts";
import {
  functionResourceSchema,
  functionSpecSchema,
  functionStatusSchema,
} from "../../packages/shared/src/functions/schema.ts";
import { renderFunctionArtifacts, writeFunctionArtifacts } from "../../scripts/crd-artifacts.ts";

const schemas = { spec: functionSpecSchema, status: functionStatusSchema };
const paths = [
  "deploy/crds/functions.krun.io.yaml",
  "deploy/helm/krun/templates/crd-functions.yaml",
  "docs/schemas/function-v1alpha1.json",
] as const;
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

it("stores exactly the real artifacts derived from canonical source schemas", () => {
  const rendered = renderFunctionArtifacts(schemas);
  for (const path of paths) expect(read(path)).toBe(rendered[path]);
  const crd = parse(read(paths[0]));
  const version = crd.spec.versions[0];
  expect(crd.spec).toMatchObject({ scope: "Namespaced", names: { shortNames: ["kfn"] } });
  expect(version.subresources).toEqual({ status: {} });
  expect(version.additionalPrinterColumns[0].jsonPath).toBe(
    '.status.conditions[?(@.type=="Ready")].status',
  );
  const root = version.schema.openAPIV3Schema;
  const spec = root.properties.spec;
  expect(spec.required).toEqual(["image", "inputSchema"]);
  expect(spec.properties.inputSchema).toEqual({
    type: "object",
    "x-kubernetes-preserve-unknown-fields": true,
  });
  expect(spec.properties.runAsUser.default).toBe(65532);
  expect(spec.properties.runAsGroup.default).toBe(65532);
  expect(spec.properties.queueTimeout.pattern).toBe("^\\d+(ms|s|m|h)$");
  expect(spec.properties.heartbeatTimeout.pattern).toBe("^\\d+(ms|s|m|h)$");
  expect(spec.properties.queueTimeout.allOf[0].pattern).toBeTruthy();
  expect(root.properties.status.properties.conditions).toMatchObject({
    maxItems: 1,
    "x-kubernetes-list-type": "map",
    "x-kubernetes-list-map-keys": ["type"],
  });
  expect(root.properties.metadata.properties.name.maxLength).toBe(63);
  // Kubernetes owns metadata requiredness; adding required here invalidates
  // the CRD even though editor/CLI create input requires an explicit name.
  expect(root.properties.metadata.required).toBeUndefined();
  expect(spec["x-kubernetes-validations"][0].rule).toBe("self.image.contains('@sha256:')");
  const editor = JSON.parse(read(paths[2]));
  expect(editor.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(editor.required).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  expect(editor.properties.spec.additionalProperties).toBe(false);
  expect(JSON.stringify(editor)).not.toContain("x-kubernetes-");
  const evaluator = new Ajv2020({ strict: true, allErrors: true, formats: fullFormats });
  const fromEditor = evaluator.compile(editor);
  const input = {
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: { name: "krun-test-source", labels: { team: "test" } },
    spec: {
      image: `example.invalid/krun-test@sha256:${"0".repeat(64)}`,
      inputSchema: {
        properties: { item: { $ref: "#/$defs/Thing" } },
        $defs: { Thing: { type: "string" } },
      },
    },
  };
  expect(fromEditor(input)).toBe(true);
  expect(functionResourceSchema.safeParse(input).success).toBe(true);
  for (const specPatch of [
    { queueTimeout: "0ms" },
    { heartbeatTimeout: "29s" },
    { activeDeadlineSeconds: 0 },
    { maxQueued: -1 },
    { queueTimeout: "9007199254740992ms" },
  ])
    expect(fromEditor({ ...input, spec: { ...input.spec, ...specPatch } })).toBe(false);
});

it("keeps callback wire acceptance and opaque own keys identical in published schemas", () => {
  const check = new Ajv2020({ strict: true, allErrors: true, formats: fullFormats }).compile(
    JSON.parse(read(paths[2])),
  );
  const crdSpec = parse(read(paths[0])).spec.versions[0].schema.openAPIV3Schema.properties.spec;
  const base = {
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: { name: "krun-test-callback" },
    spec: { image: `example.invalid/krun-test@sha256:${"0".repeat(64)}`, inputSchema: {} },
  };
  const accepted = [
    "https://example.invalid/path",
    "HTTP://example.invalid:8080/%20?q=x#f",
    "https://[2001:db8::1]/",
    "https://[::ffff:192.0.2.1]/",
    "mailto:team@example.invalid",
    "urn:example:krun",
  ];
  const rejected = [
    "https://",
    " https://example.invalid/",
    "https://example.invalid/ ",
    "https://example.invalid/a b",
    "https://example.invalid/%ZZ",
    "https://exa\nmple.invalid/",
    "https://example.invalid/\\path",
    "https://[]/",
    "https://[:::1]/",
    "https://example.invalid/#a#b",
  ];
  for (const [urls, expected] of [
    [accepted, true],
    [rejected, false],
  ] as const) {
    for (const url of urls) {
      const input = { ...base, spec: { ...base.spec, callback: { url } } };
      const parsed = functionResourceSchema.safeParse(input);
      expect(parsed.success, url).toBe(expected);
      expect(check(input), url).toBe(expected);
      if (parsed.success) expect(parsed.data.spec.callback?.url).toBe(url);
    }
  }
  for (let code = 0; code <= 32; code++) {
    for (const url of [
      `https://exa${String.fromCharCode(code)}mple.invalid/`,
      `https://example.invalid/a${String.fromCharCode(code)}`,
      `${String.fromCharCode(code)}https://example.invalid/`,
    ]) {
      const input = { ...base, spec: { ...base.spec, callback: { url } } };
      expect(functionResourceSchema.safeParse(input).success).toBe(false);
      expect(check(input)).toBe(false);
    }
  }
  const callbackSchema = crdSpec.properties.callback.properties.url;
  expect(callbackSchema.format).toBe("uri");
  expect(callbackSchema.pattern).toBe(
    JSON.parse(read(paths[2])).properties.spec.properties.callback.properties.url.pattern,
  );
  for (const url of accepted) expect(new RegExp(callbackSchema.pattern).test(url)).toBe(true);
  for (const url of rejected) expect(new RegExp(callbackSchema.pattern).test(url)).toBe(false);
  const inputSchema = JSON.parse(
    '{"__proto__":{"type":"string"},"constructor":{"prototype":{"marker":true}},"properties":{"__proto__":{"type":"string"}}}',
  );
  const input = { ...base, spec: { ...base.spec, inputSchema } };
  expect(check(input)).toBe(true);
  const parsed = functionResourceSchema.parse(input).spec.inputSchema;
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(inputSchema));
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
});

it("keeps editor duration semantics identical across units, leading zeros and overflow", () => {
  const evaluator = new Ajv2020({ strict: true, allErrors: true, formats: fullFormats });
  const check = evaluator.compile(JSON.parse(read(paths[2])));
  const base = {
    apiVersion: "krun.io/v1alpha1",
    kind: "Function",
    metadata: { name: "krun-test-floor" },
    spec: { image: `example.invalid/krun-test@sha256:${"0".repeat(64)}`, inputSchema: {} },
  };
  for (const [field, minimum] of [
    ["queueTimeout", 1],
    ["heartbeatTimeout", 30000],
  ] as const) {
    const cases = [
      "0ms",
      "0000s",
      "1d",
      "1.5s",
      "30s\n",
      "30000ms",
      "00030s",
      "9007199254740992ms",
    ];
    for (const [unit, scale] of [
      ["ms", 1],
      ["s", 1000],
      ["m", 60000],
      ["h", 3600000],
    ] as const) {
      for (let amount = 0; amount <= 600; amount++)
        cases.push(`${amount}${unit}`, `000${amount}${unit}`);
      const max = BigInt(Number.MAX_SAFE_INTEGER) / BigInt(scale);
      for (const amount of [max - 1n, max, max + 1n])
        cases.push(`${amount}${unit}`, `000${amount}${unit}`);
    }
    for (const value of cases) {
      const millis = durationToMilliseconds(value);
      const expected = millis !== undefined && millis >= minimum;
      const input = { ...base, spec: { ...base.spec, [field]: value } };
      expect(check(input), `${field}=${value}`).toBe(expected);
      expect(functionResourceSchema.safeParse(input).success, `${field}=${value}`).toBe(expected);
    }
  }
});

for (const install of [false, true])
  for (const keep of [false, true])
    it(`renders real chart install=${install} keep=${keep}`, () => {
      const chart = fileURLToPath(new URL("../../deploy/helm/krun", import.meta.url));
      const output = execFileSync(
        "helm",
        [
          "template",
          "krun-test-function-schema",
          chart,
          "--set",
          `crds.install=${install}`,
          "--set",
          `crds.keep=${keep}`,
          "--set",
          "apiKeys.existingSecret=krun-test-schema-keys",
          "--set",
          "db.postgres.existingSecret=krun-test-schema-db",
        ],
        { encoding: "utf8" },
      );
      const docs = parseAllDocuments(output).filter(
        (doc) => doc.contents !== null && doc.toJSON().kind === "CustomResourceDefinition",
      );
      expect(docs).toHaveLength(install ? 1 : 0);
      if (!install) return;
      expect(docs[0]?.errors).toEqual([]);
      const actual = docs[0]?.toJSON();
      const plain = parse(read(paths[0]));
      expect(actual.spec).toEqual(plain.spec);
      expect(actual.metadata.annotations).toEqual(
        keep ? { "helm.sh/resource-policy": "keep" } : undefined,
      );
      delete actual.metadata.annotations;
      expect(actual).toEqual(plain);
    });

it("regenerates canonical artifacts deterministically and repairs isolated drift", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "krun-test-canonical-gen-"));
  roots.push(dir);
  writeFunctionArtifacts(dir, schemas);
  const before = paths.map((path) => readFileSync(join(dir, path), "utf8"));
  for (const [index, path] of paths.entries()) expect(before[index]).toBe(read(path));
  writeFileSync(join(dir, paths[0]), "krun-test-drift\n");
  const changed = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--",
      fileURLToPath(new URL(`../../${paths[0]}`, import.meta.url)),
      join(dir, paths[0]),
    ],
    { encoding: "utf8" },
  );
  expect(changed.status).toBe(1);
  expect(changed.stdout).toContain("krun-test-drift");
  writeFunctionArtifacts(dir, schemas);
  for (const [index, path] of paths.entries())
    expect(readFileSync(join(dir, path), "utf8")).toBe(before[index]);
});
