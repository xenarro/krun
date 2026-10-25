import { fileURLToPath } from "node:url";
import { writePublicOpenApi } from "../apps/gateway/dev/openapi.ts";

await writePublicOpenApi(fileURLToPath(new URL("../", import.meta.url)));
