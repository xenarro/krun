import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderInternalOpenApi } from "../../apps/gateway/dev/openapi.ts";
import { internalContracts } from "../../apps/gateway/src/internal-contracts.ts";

const walk = (value: unknown, visit: (node: Record<string, unknown>) => void) => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === "object") {
    visit(value as Record<string, unknown>);
    for (const item of Object.values(value)) walk(item, visit);
  }
};
it("internal OpenAPI3.1 has the four normative executable route contracts and per-run auth", async () => {
  const document = await renderInternalOpenApi();
  const contract = readFileSync(new URL("../../docs/INTERNAL-API.md", import.meta.url), "utf8");
  const methods = [...contract.matchAll(/\| `([A-Za-z]+)` \| `(GET|POST|PUT) ([^`]+)` \|/g)];
  expect(methods).toHaveLength(4);
  expect(Object.keys(internalContracts)).toHaveLength(4);
  expect(document.openapi).toBe("3.1.0");
  for (const row of methods) {
    const operation =
      document.paths?.[row[3] ?? ""]?.[row[2]?.toLowerCase() as "get" | "post" | "put"];
    expect(operation?.operationId).toBe(row[1]);
    expect(operation?.security).toEqual([{ runToken: [] }]);
    if (row[1] !== "GetInput") expect(operation?.responses?.["204"]).not.toHaveProperty("content");
  }
  expect(Object.keys(document.paths ?? {})).toHaveLength(4);
});
it("internal OpenAPI is deterministic and generated artifact agrees;no nullable nodes or closed response enums", async () => {
  const a = await renderInternalOpenApi(),
    b = await renderInternalOpenApi();
  expect(a).toEqual(b);
  const written = JSON.parse(
    readFileSync(new URL("../../docs/api/openapi-internal.json", import.meta.url), "utf8"),
  );
  expect(written).toEqual(a);
  walk(a, (node) => {
    expect(node.nullable).not.toBe(true);
    expect(node.type).not.toBe("null");
    if (Array.isArray(node.type)) expect(node.type).not.toContain("null");
  });
  for (const item of Object.values(a.paths ?? {}))
    for (const operation of [item?.get, item?.post, item?.put])
      walk(operation?.responses, (node) => expect(node).not.toHaveProperty("enum"));
  expect(JSON.stringify(a)).toContain("UNAUTHENTICATED");
});
