import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import swagger from "@fastify/swagger";
import { Effect } from "effect";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import {
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { z } from "zod";
import {
  publicContractProjection,
  publicContracts,
  publicSchemas,
} from "../src/public-contracts.ts";

type PublicDocument = Extract<
  Exclude<ReturnType<FastifyInstance["swagger"]>, string>,
  { openapi: string }
>;
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
// This app exists only for native onRoute/Swagger schema discovery. It never
// listens, acquires business services or installs placeholder production methods.
// A mistaken invocation fails closed instead of fabricating API success.
const documentationOnly = (): never => {
  throw new Error("Documentation-only route has no executable method implementation");
};
export const renderPublicOpenApi = (): Promise<PublicDocument> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => Fastify({ logger: false, exposeHeadRoutes: false })),
          (app) => Effect.promise(() => app.close()),
        );
        const conversion: NonNullable<
          Parameters<typeof createJsonSchemaTransform>[0]["zodToJsonConfig"]
        > = {
          unrepresentable: publicContractProjection,
          override: ({ zodSchema, jsonSchema }) => {
            // The provider's scoped registry does not inherit global .describe/
            // readOnly metadata. Copy authored per-node annotations via its public
            // converter hook; do not register global component IDs or walk internals.
            Object.assign(jsonSchema, z.globalRegistry.get(zodSchema));
          },
        };
        const registry = z.registry<{ id?: string; [key: string]: unknown }>();
        for (const [id, schema] of Object.entries(publicSchemas))
          registry.add(schema, { ...schema.meta(), id });
        yield* Effect.promise(async () => {
          await app.register(swagger, {
            mode: "dynamic",
            openapi: {
              openapi: "3.1.0",
              info: {
                title: "krun public API",
                version: "v1",
                description:
                  "Normative docs/API.md contract. This artifact does not imply that later PLAN method/listener tasks are implemented.",
              },
              components: {
                securitySchemes: {
                  bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    description: "API key; route scope,Function globs and run ownership apply.",
                  },
                },
              },
            },
            transform: createJsonSchemaTransform({
              schemaRegistry: registry,
              zodToJsonConfig: conversion,
            }),
            transformObject: createJsonSchemaTransformObject({
              schemaRegistry: registry,
              zodToJsonConfig: conversion,
            }),
            convertConstToEnum: false,
          });
          app.setValidatorCompiler(validatorCompiler);
          app.setSerializerCompiler(serializerCompiler);
          for (const contract of Object.values(publicContracts)) {
            const route: RouteOptions = {
              method: contract.method,
              url: contract.url,
              schema: contract.schema,
              handler: documentationOnly,
            };
            app.route(route);
          }
          await app.ready();
        });
        const document = app.swagger();
        if (!("openapi" in document) || document.openapi !== "3.1.0")
          return yield* Effect.die(new Error("Swagger did not produce OpenAPI 3.1"));
        for (const path of Object.values(document.paths ?? {}))
          for (const method of ["get", "post"] as const) {
            const operation = path?.[method];
            if (!operation) continue;
            operation.parameters = [
              ...(operation.parameters ?? []),
              {
                name: "X-Request-Id",
                in: "header",
                required: false,
                schema: { type: "string" },
                description:
                  "Single opaque value up to128 characters;missing/empty/oversized/invalid values are replaced by UUIDv7 and echoed.",
              },
            ];
            for (const [status, response] of Object.entries(operation.responses ?? {})) {
              if ("$ref" in response) continue;
              response.headers = {
                ...(response.headers ?? {}),
                "X-Request-Id": {
                  description: "Accepted or generated correlation ID.",
                  schema: { type: "string", maxLength: 128 },
                },
              };
              if (status === "429" || status === "503")
                response.headers["Retry-After"] = {
                  description: "Retry after 1 second.",
                  schema: { type: "integer", minimum: 1 },
                };
              if (status === "201") {
                response.headers.Location = {
                  description: "Created/replayed run's resource path.",
                  schema: { type: "string" },
                };
                response.headers["Idempotent-Replay"] = {
                  description: "The string true on an idempotent replay;omitted otherwise.",
                  schema: { type: "string" },
                };
              }
              if (status === "307") {
                delete response.content;
                response.headers.Location = {
                  description:
                    "Presigned URL on another origin,valid 300 seconds. Follow without Authorization or krun headers.",
                  schema: { type: "string", format: "uri" },
                };
                response.headers["Cache-Control"] = {
                  description: "Always no-store.",
                  schema: { type: "string" },
                };
              }
            }
          }
        return document;
      }),
    ),
  );
export const writePublicOpenApi = async (root: string): Promise<void> => {
  const document = await renderPublicOpenApi();
  const path = resolve(root, "docs/api/openapi-public.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(canonical(document), null, 2) + "\n");
};
