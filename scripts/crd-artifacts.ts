import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import {
  createFunctionResourceSchema,
  functionImageValidation,
  functionInputSchemaProjection,
  functionMetadataSchema,
} from "../packages/shared/src/functions/schema.ts";

type JsonSchema = z.core.JSONSchema.JSONSchema;
type ArtifactPath =
  | "deploy/crds/functions.krun.io.yaml"
  | "deploy/helm/krun/templates/crd-functions.yaml"
  | "docs/schemas/function-v1alpha1.json";
interface FunctionSchemas {
  readonly spec: z.ZodType;
  readonly status: z.ZodType;
}

// This is technical projection, not a source of Function field policy. The
// canonical schema owner supplies requiredness/minima/defaults in the Zod input.
const patternConstraint = (node: unknown): boolean =>
  node !== null &&
  typeof node === "object" &&
  "pattern" in node &&
  typeof node.pattern === "string" &&
  Object.keys(node).length === 1;
const project = (source: JsonSchema): JsonSchema => {
  const schema = { ...source };
  for (const key of [
    "$schema",
    "$defs",
    "$ref",
    "$dynamicRef",
    "patternProperties",
    "prefixItems",
    "unevaluatedProperties",
    "dependentSchemas",
    "if",
    "then",
    "else",
  ]) {
    if (key in schema) throw new Error(`Unsupported structural schema keyword: ${key}`);
  }
  if (typeof schema.type !== "string") throw new Error("Structural schema nodes require one type");
  if (schema.propertyNames !== undefined) {
    const names = schema.propertyNames;
    if (typeof names !== "object" || names.type !== "string" || Object.keys(names).length !== 1) {
      throw new Error("Unsupported structural schema keyword: propertyNames");
    }
    delete schema.propertyNames;
  }
  if (schema.additionalProperties === false) delete schema.additionalProperties;
  else if (typeof schema.additionalProperties === "object")
    schema.additionalProperties = project(schema.additionalProperties);
  if (schema.properties) {
    schema.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => {
        if (typeof value === "boolean")
          throw new Error("Structural property schemas require a type");
        return [name, project(value)];
      }),
    );
  }
  if (Array.isArray(schema.items)) throw new Error("Structural tuple schemas are unsupported");
  if (typeof schema.items === "object") schema.items = project(schema.items);
  if (schema.allOf !== undefined && !schema.allOf.every(patternConstraint))
    throw new Error("Structural allOf requires pattern-only constraints");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined)
      throw new Error(`Structural composition needs explicit projection: ${key}`);
  }
  if (schema.not !== undefined) throw new Error("Structural negation needs explicit projection");
  // Do not walk arbitrary data in default/examples as if it were schema syntax.
  return schema;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};
const yaml = (value: unknown) =>
  stringify(canonical(value), { lineWidth: 0, aliasDuplicateObjects: false });

export const renderFunctionArtifacts = ({
  spec,
  status,
}: FunctionSchemas): Record<ArtifactPath, string> => {
  const structural = (source: z.ZodType, opaqueInput = false): JsonSchema => {
    const convert = (target: "draft-2020-12" | "openapi-3.0"): JsonSchema => {
      const raw = z.toJSONSchema(source, {
        target,
        io: "input",
        reused: "inline",
        cycles: "throw",
        unrepresentable: functionInputSchemaProjection,
      });
      delete raw.$schema;
      if (raw.type !== "object") throw new Error("Function spec/status schemas must be objects");
      if (opaqueInput) {
        if (raw.additionalProperties !== false || !raw.properties?.inputSchema)
          throw new Error("Function spec must be a strict object defining inputSchema");
        raw.properties = {
          ...raw.properties,
          inputSchema: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
        };
      }
      return project(raw);
    };
    // Zod's OpenAPI 3.0 target can silently omit constrained record keys.
    // Validate the richer dialect first so projection cannot lose those rules.
    convert("draft-2020-12");
    return convert("openapi-3.0");
  };
  // Replace only this schema node, not arbitrary user schema instances. Keep
  // typed maps elsewhere; strip strict-object flags for native field pruning.
  const projected = structural(spec, true);
  const projectedStatus = structural(status);
  const conditions = projectedStatus.properties?.conditions;
  if (conditions && typeof conditions === "object") {
    conditions["x-kubernetes-list-type"] = "map";
    conditions["x-kubernetes-list-map-keys"] = ["type"];
  }
  projected["x-kubernetes-validations"] = [functionImageValidation];
  const crd = {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    metadata: { name: "functions.krun.io" },
    spec: {
      group: "krun.io",
      scope: "Namespaced",
      names: {
        kind: "Function",
        listKind: "FunctionList",
        plural: "functions",
        singular: "function",
        shortNames: ["kfn"],
      },
      versions: [
        {
          name: "v1alpha1",
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            {
              name: "READY",
              type: "string",
              jsonPath: '.status.conditions[?(@.type=="Ready")].status',
            },
            { name: "IMAGE", type: "string", jsonPath: ".spec.image" },
            { name: "AGE", type: "date", jsonPath: ".metadata.creationTimestamp" },
          ],
          schema: {
            openAPIV3Schema: {
              type: "object",
              required: ["apiVersion", "kind", "metadata", "spec"],
              properties: {
                apiVersion: { type: "string" },
                kind: { type: "string" },
                metadata: {
                  type: "object",
                  properties: {
                    name: project(
                      z.toJSONSchema(functionMetadataSchema.shape.name, {
                        target: "openapi-3.0",
                        io: "input",
                      }),
                    ),
                  },
                },
                spec: projected,
                status: projectedStatus,
              },
            },
          },
        },
      ],
    },
  };
  const resource = createFunctionResourceSchema(spec, status);
  const plain = yaml(crd);
  // Schema strings are YAML data, never Helm source. Escape their opening
  // delimiters before adding only our own install/keep template directives.
  const template = plain
    .replaceAll("{{", '{{ "{{" }}')
    .replace(
      "\nspec:\n",
      "\n  {{- if .Values.crds.keep }}\n  annotations:\n    helm.sh/resource-policy: keep\n  {{- end }}\nspec:\n",
    );
  return {
    "deploy/crds/functions.krun.io.yaml": plain,
    "deploy/helm/krun/templates/crd-functions.yaml": `{{- if .Values.crds.install }}\n${template}{{- end }}\n`,
    "docs/schemas/function-v1alpha1.json": `${JSON.stringify(canonical(z.toJSONSchema(resource, { target: "draft-2020-12", io: "input", reused: "inline", cycles: "throw", unrepresentable: functionInputSchemaProjection })), null, 2)}\n`,
  };
};

export const writeFunctionArtifacts = (root: string, schemas: FunctionSchemas): ArtifactPath[] => {
  const artifacts = renderFunctionArtifacts(schemas);
  const paths: ArtifactPath[] = [];
  for (const path of Object.keys(artifacts) as ArtifactPath[]) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, artifacts[path], "utf8");
    paths.push(path);
  }
  return paths;
};
