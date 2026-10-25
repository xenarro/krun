import { createHash } from "node:crypto";
import type { KeyPrincipal } from "@krun/shared/dist/auth/keys.js";
import type { GatewayConfig } from "@krun/shared/dist/config/index.js";
import type { FunctionEntry } from "@krun/shared/dist/functions/cache.js";
import type { FunctionSpec } from "@krun/shared/dist/functions/schema.js";
import { Duration, Effect } from "effect";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { publicContracts, publicSchemas } from "./public-contracts.js";

type ReadLimits = Pick<
  GatewayConfig,
  "KRUN_MAX_INPUT_BYTES" | "KRUN_MAX_RESULT_BYTES" | "KRUN_MAX_WAIT"
>;
const cursorSchema = z.strictObject({
  v: z.literal(1),
  last: publicSchemas.Function.shape.name,
  context: z.string().regex(/^[0-9a-f]{64}$/),
});
const contextHash = (key: KeyPrincipal) =>
  createHash("sha256")
    .update(JSON.stringify(["ListFunctions:v1", key.name, key.functions, key.scopes]))
    .digest("hex");
const decodeCursor = (token: string, context: string) =>
  Effect.try({
    try: () => {
      if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid cursor");
      const bytes = Buffer.from(token, "base64url");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.toString("base64url") !== token) throw new Error("Invalid cursor");
      const decoded = cursorSchema.parse(JSON.parse(text));
      if (decoded.context !== context) throw new Error("Invalid cursor");
      return decoded.last;
    },
    catch: () => new ApiError({ reason: "REQUEST_INVALID" }),
  });

// Compose under makePublicApp's authenticated service scope. The caller owns
// parsed configuration and eventual listener/process wiring, never this module.
export const functionReadRoutes = (config: ReadLimits): FastifyPluginAsync => {
  const millis = Duration.toMillis(config.KRUN_MAX_WAIT);
  const limits = {
    maxInputBytes: config.KRUN_MAX_INPUT_BYTES,
    maxResultBytes: config.KRUN_MAX_RESULT_BYTES,
    maxWait: millis % 1000 === 0 ? `${millis / 1000}s` : `${millis}ms`,
  };
  const readable = (
    entry: FunctionEntry,
  ): entry is FunctionEntry & { readonly spec: FunctionSpec } =>
    entry.result.ok && entry.spec !== undefined;
  const project = (name: string, spec: FunctionSpec): z.output<typeof publicSchemas.Function> => {
    return {
      name: `functions/${name}`,
      inputSchema: spec.inputSchema,
      maxConcurrency: spec.maxConcurrency,
      maxQueued: spec.maxQueued,
      queueTimeout: spec.queueTimeout,
      activeDeadlineSeconds: spec.activeDeadlineSeconds,
      ...(spec.heartbeatTimeout === undefined ? {} : { heartbeatTimeout: spec.heartbeatTimeout }),
      ...(spec.callback === undefined ? {} : { callback: { url: spec.callback.url } }),
      ...limits,
    };
  };
  return async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.route({
      ...publicContracts.ListFunctions,
      handler: async (request, reply) =>
        app.runEffect(
          request,
          reply,
          Effect.gen(function* () {
            const principal = request.principal;
            if (!principal) return yield* new ApiError({ reason: "INTERNAL" });
            if (!(yield* app.functions.isSynced))
              return yield* new ApiError({ reason: "NOT_READY" });
            const context = contextHash(principal);
            const after = request.query.pageToken
              ? yield* decodeCursor(request.query.pageToken, context)
              : undefined;
            const size = Math.min(request.query.pageSize || 50, 200);
            const entries = yield* app.functions.list;
            const visible = entries
              .filter(readable)
              .filter(
                (entry) =>
                  principal.allowsFunction(entry.name) &&
                  (after === undefined || `functions/${entry.name}` > after),
              );
            const page = visible.slice(0, size);
            const last = page.at(-1);
            return {
              functions: page.map((entry) => project(entry.name, entry.spec)),
              nextPageToken:
                visible.length > page.length && last
                  ? Buffer.from(
                      JSON.stringify({ v: 1, last: `functions/${last.name}`, context }),
                    ).toString("base64url")
                  : "",
            };
          }),
        ),
    });
    typed.route({
      ...publicContracts.GetFunction,
      handler: async (request, reply) =>
        app.runEffect(
          request,
          reply,
          Effect.gen(function* () {
            const principal = request.principal;
            if (!principal) return yield* new ApiError({ reason: "INTERNAL" });
            if (!(yield* app.functions.isSynced))
              return yield* new ApiError({ reason: "NOT_READY" });
            const entry = yield* app.functions.get(request.params.function);
            if (!entry || !entry.result.ok || !entry.spec || !principal.allowsFunction(entry.name))
              return yield* new ApiError({ reason: "FUNCTION_NOT_FOUND" });
            return project(entry.name, entry.spec);
          }),
        ),
    });
  };
};
