import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  functionDurationSchema,
  functionIdentitySchema,
  functionImageSchema,
} from "../../packages/shared/src/functions/schema.ts";
import { renderFunctionArtifacts, writeFunctionArtifacts } from "../../scripts/crd-artifacts.ts";

const roots: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.env.RUNNER_TEMP ?? tmpdir(), "krun-test-crd-"),
  );
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const plainPath = "deploy/crds/functions.krun.io.yaml";
const chartPath = "deploy/helm/krun/templates/crd-functions.yaml";
const editorPath = "docs/schemas/function-v1alpha1.json";
// Deliberately synthetic policy variants, not the approved Function contract.
// The renderer must carry whatever requiredness/minima its caller supplies.
const fixture = (requiredInput = false, minimum?: number) => ({
  spec: z.strictObject({
    image: functionImageSchema,
    literal: z.string().default("{{ .Release.Name }}"),
    inputSchema: requiredInput
      ? z.record(z.string(), z.unknown())
      : z.record(z.string(), z.unknown()).optional(),
    runAsUser: functionIdentitySchema,
    runAsGroup: functionIdentitySchema,
    queueTimeout: functionDurationSchema.default("1h"),
    heartbeatTimeout: functionDurationSchema.optional(),
    nodeSelector: z.record(z.string(), z.string()).optional(),
    ...(minimum === undefined ? {} : { maxQueued: z.int().min(minimum).default(1000) }),
    env: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
  }),
  status: z.strictObject({ observedGeneration: z.int().optional() }),
});

it("projects real Zod input schemas without strict-object pruning or map loss", () => {
  const schemas = fixture();
  const before = z.toJSONSchema(schemas.spec, { target: "openapi-3.0", io: "input" });
  const artifacts = renderFunctionArtifacts(schemas);
  expect(Object.keys(artifacts).sort()).toEqual([plainPath, chartPath, editorPath].sort());
  const crd = parse(artifacts[plainPath]);
  expect(crd.apiVersion).toBe("apiextensions.k8s.io/v1");
  expect(crd.metadata.name).toBe("functions.krun.io");
  expect(crd.spec).toMatchObject({
    group: "krun.io",
    scope: "Namespaced",
    names: {
      kind: "Function",
      listKind: "FunctionList",
      plural: "functions",
      singular: "function",
      shortNames: ["kfn"],
    },
  });
  expect(crd.spec.versions).toHaveLength(1);
  const version = crd.spec.versions[0];
  expect(version).toMatchObject({
    name: "v1alpha1",
    served: true,
    storage: true,
    subresources: { status: {} },
  });
  expect(version.additionalPrinterColumns).toEqual([
    { name: "READY", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
    { name: "IMAGE", type: "string", jsonPath: ".spec.image" },
    { name: "AGE", type: "date", jsonPath: ".metadata.creationTimestamp" },
  ]);
  const root = version.schema.openAPIV3Schema;
  const spec = root.properties.spec;
  expect(root.additionalProperties).toBeUndefined();
  expect(root.required).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  expect(spec.additionalProperties).toBeUndefined();
  expect(spec.properties.env.items.additionalProperties).toBeUndefined();
  expect(spec.properties.inputSchema).toEqual({
    type: "object",
    "x-kubernetes-preserve-unknown-fields": true,
  });
  expect(spec.properties.nodeSelector.additionalProperties).toEqual({ type: "string" });
  expect(spec.properties.nodeSelector.propertyNames).toBeUndefined();
  expect(spec.properties.runAsUser.default).toBe(65532);
  expect(spec.properties.runAsGroup.default).toBe(65532);
  expect(spec.properties.queueTimeout.pattern).toBe("^\\d+(ms|s|m|h)$");
  expect(spec.properties.heartbeatTimeout.pattern).toBe("^\\d+(ms|s|m|h)$");
  expect(spec.properties.image.pattern).toBe("@sha256:");
  expect(spec["x-kubernetes-validations"]).toEqual([
    { rule: "self.image.contains('@sha256:')", message: "image must contain @sha256:" },
  ]);
  const editor = JSON.parse(artifacts[editorPath]);
  expect(editor.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(editor.properties.apiVersion.const).toBe("krun.io/v1alpha1");
  expect(editor.properties.kind.const).toBe("Function");
  expect(editor.properties.spec.additionalProperties).toBe(false);
  expect(editor.properties.spec.required).not.toContain("runAsUser");
  expect(editor.properties.spec.properties.inputSchema).not.toHaveProperty(
    "x-kubernetes-preserve-unknown-fields",
  );
  expect(editor.properties.spec).not.toHaveProperty("x-kubernetes-validations");
  expect(editor.properties.metadata.additionalProperties).toEqual({});
  expect(z.toJSONSchema(schemas.spec, { target: "openapi-3.0", io: "input" })).toEqual(before);
});

it("does not select the outstanding public requiredness or minimum policy", () => {
  for (const required of [false, true])
    for (const minimum of [undefined, 0, 1]) {
      const schemas = fixture(required, minimum);
      const crd = parse(renderFunctionArtifacts(schemas)[plainPath]);
      const projected = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec;
      const original = z.toJSONSchema(schemas.spec, { target: "openapi-3.0", io: "input" });
      expect(projected.required).toEqual(original.required);
      expect(projected.properties.maxQueued?.minimum).toBe(minimum);
    }
});

for (const install of [false, true])
  for (const keep of [false, true]) {
    it(`renders actual Helm with install=${install}, keep=${keep}`, () => {
      const dir = scratch();
      const files = writeFunctionArtifacts(dir, fixture());
      expect(files.sort()).toEqual([plainPath, chartPath, editorPath].sort());
      writeFileSync(
        join(dir, "deploy/helm/krun/Chart.yaml"),
        "apiVersion: v2\nname: krun-test-crd\nversion: 0.0.0\n",
      );
      const rendered = execFileSync(
        "helm",
        [
          "template",
          "krun-test-crd",
          join(dir, "deploy/helm/krun"),
          "--set",
          `crds.install=${install}`,
          "--set",
          `crds.keep=${keep}`,
        ],
        { encoding: "utf8" },
      );
      const documents = parseAllDocuments(rendered).filter((doc) => doc.contents !== null);
      if (!install) {
        expect(documents).toHaveLength(0);
        return;
      }
      expect(documents).toHaveLength(1);
      expect(documents[0]?.errors).toEqual([]);
      const chart = documents[0]?.toJSON();
      const plain = parse(readFileSync(join(dir, plainPath), "utf8"));
      expect(chart.spec).toEqual(plain.spec);
      expect(chart.metadata.annotations).toEqual(
        keep ? { "helm.sh/resource-policy": "keep" } : undefined,
      );
      delete chart.metadata.annotations;
      expect(chart).toEqual(plain);
    });
  }

it("writes byte-stable artifacts and repairs isolated generated drift", () => {
  const one = scratch(),
    two = scratch();
  const schemas = fixture();
  const first = renderFunctionArtifacts(schemas);
  expect(renderFunctionArtifacts(schemas)).toEqual(first);
  writeFunctionArtifacts(one, schemas);
  writeFunctionArtifacts(two, schemas);
  for (const path of [plainPath, chartPath, editorPath]) {
    const a = readFileSync(join(one, path), "utf8");
    expect(a).toBe(readFileSync(join(two, path), "utf8"));
    expect(a.endsWith("\n")).toBe(true);
    expect(a).not.toMatch(/&a\d|\*a\d/);
  }
  writeFileSync(join(one, plainPath), "krun-test-corrupted-artifact\n");
  expect(readFileSync(join(one, plainPath), "utf8")).not.toBe(first[plainPath]);
  writeFunctionArtifacts(one, schemas);
  expect(readFileSync(join(one, plainPath), "utf8")).toBe(first[plainPath]);
});

it("native Node regeneration reads current TypeScript source, not stale dist", () => {
  const dir = scratch();
  const require = createRequire(import.meta.url);
  const zod = pathToFileURL(require.resolve("zod")).href;
  const helper = new URL("../../scripts/crd-artifacts.ts", import.meta.url).href;
  writeFileSync(
    join(dir, "entry.mjs"),
    `import {spec,status} from './schema.ts';\nimport {renderFunctionArtifacts} from ${JSON.stringify(helper)};\nconst out=renderFunctionArtifacts({spec,status});\nconsole.log(JSON.parse(out[${JSON.stringify(editorPath)}]).properties.spec.properties.runAsUser.default);\n`,
  );
  for (const value of [65532, 4242]) {
    writeFileSync(
      join(dir, "schema.ts"),
      `import {z} from ${JSON.stringify(zod)};\nconst value: number=${value};\nexport const spec=z.strictObject({image:z.string().regex(/@sha256:/),inputSchema:z.record(z.string(),z.unknown()).optional(),runAsUser:z.int().default(value)});\nexport const status=z.strictObject({});\n`,
    );
    expect(
      execFileSync(process.execPath, [join(dir, "entry.mjs")], { encoding: "utf8" }).trim(),
    ).toBe(String(value));
  }
});

it("rejects unsupported structural key restrictions instead of dropping constraints", () => {
  const schemas = fixture();
  const spec = schemas.spec.extend({
    nodeSelector: z.record(z.string().regex(/^krun-test-/), z.string()),
  });
  expect(() => renderFunctionArtifacts({ ...schemas, spec })).toThrow(/propertyNames/);
});

it("does not traverse instance defaults as if they were schema definitions", () => {
  const schemas = fixture();
  const literal = {
    propertyNames: { type: "number" },
    additionalProperties: false,
    $ref: "#local",
  };
  const spec = schemas.spec.extend({
    note: z
      .strictObject({
        propertyNames: z.strictObject({ type: z.string() }),
        additionalProperties: z.boolean(),
        $ref: z.string(),
      })
      .default(literal),
  });
  const crd = parse(renderFunctionArtifacts({ ...schemas, spec })[plainPath]);
  expect(
    crd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.note.default,
  ).toEqual(literal);
});

it.each([
  [
    "non-strict spec",
    () => ({ ...fixture(), spec: z.object({ inputSchema: z.record(z.string(), z.unknown()) }) }),
  ],
  ["missing inputSchema", () => ({ ...fixture(), spec: z.strictObject({ image: z.string() }) })],
  ["non-object status", () => ({ ...fixture(), status: z.string() })],
  [
    "untyped field outside inputSchema",
    () => ({ ...fixture(), spec: fixture().spec.extend({ unknown: z.unknown() }) }),
  ],
  [
    "tuple field",
    () => ({ ...fixture(), spec: fixture().spec.extend({ tuple: z.tuple([z.string()]) }) }),
  ],
])("fails closed for %s", (_name, build) => {
  expect(() => renderFunctionArtifacts(build())).toThrow();
});

it("validates all schemas before replacing existing generated artifacts", () => {
  const dir = scratch();
  const schemas = fixture();
  const artifacts = renderFunctionArtifacts(schemas);
  writeFunctionArtifacts(dir, schemas);
  expect(() => writeFunctionArtifacts(dir, { ...schemas, status: z.string() })).toThrow(/objects/);
  for (const path of [plainPath, chartPath, editorPath] as const) {
    expect(readFileSync(join(dir, path), "utf8")).toBe(artifacts[path]);
  }
});
