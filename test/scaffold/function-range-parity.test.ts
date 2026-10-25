import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { publicSchemas } from "../../apps/gateway/src/public-contracts.ts";
import {
  functionResourceSchema,
  functionSpecSchema,
} from "../../packages/shared/src/functions/schema.ts";

const root = new URL("../../", import.meta.url);
const editor = JSON.parse(
  readFileSync(fileURLToPath(new URL("docs/schemas/function-v1alpha1.json", root)), "utf8"),
);
const crd = parse(
  readFileSync(fileURLToPath(new URL("deploy/crds/functions.krun.io.yaml", root)), "utf8"),
);
const ajv = new Ajv2020({ strict: true, formats: fullFormats, logger: false });
const validate = ajv.compile(editor);
for (const field of ["maxConcurrency", "maxQueued", "activeDeadlineSeconds"] as const) {
  it(`keeps ${field} range identical across canonical/editor/CRD/public boundaries`, () => {
    const canonical = z.toJSONSchema(functionSpecSchema.shape[field]);
    const publicField = z.toJSONSchema(publicSchemas.Function.shape[field]);
    const editorField = editor.properties.spec.properties[field];
    const crdField = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties[field];
    for (const schema of [canonical, publicField, editorField, crdField])
      expect(schema.maximum).toBe(2147483647);
    const resource = (value: number) => ({
      apiVersion: "krun.io/v1alpha1",
      kind: "Function",
      metadata: { name: "krun-test-range" },
      spec: {
        image: `example.invalid/job@sha256:${"a".repeat(64)}`,
        inputSchema: { type: "object" },
        [field]: value,
      },
    });
    for (const value of [2147483647, 2147483648, -1, 0]) {
      const allowed = value === 2147483647 || (field === "maxQueued" && value === 0);
      expect(functionResourceSchema.safeParse(resource(value)).success).toBe(allowed);
      expect(validate(resource(value))).toBe(allowed);
    }
  });
}
