import { fileURLToPath } from "node:url";
import {
  functionSpecSchema,
  functionStatusSchema,
} from "../packages/shared/src/functions/schema.ts";
import { writeFunctionArtifacts } from "./crd-artifacts.ts";

writeFunctionArtifacts(fileURLToPath(new URL("../", import.meta.url)), {
  spec: functionSpecSchema,
  status: functionStatusSchema,
});
