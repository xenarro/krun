import { fileURLToPath } from "node:url";
import { writeInternalOpenApi, writePublicOpenApi } from "../apps/gateway/dev/openapi.ts";

await writePublicOpenApi(fileURLToPath(new URL("../", import.meta.url)));
await writeInternalOpenApi(fileURLToPath(new URL("../", import.meta.url)));
