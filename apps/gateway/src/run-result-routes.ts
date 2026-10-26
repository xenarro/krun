import { NotFoundError } from "@krun/shared/dist/store/index.js";
import { Effect } from "effect";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "./errors.js";
import { publicContracts, publicSchemas } from "./public-contracts.js";

// P6.1 supplies the concrete scoped ObjectStore. Absence is configuration,
// not a fake implementation; inline results need no object-store dependency.
export interface RunResultObjectStore {
  readonly presignGet: (ref: string, ttlSeconds: 300) => Effect.Effect<string, unknown>;
}
export const runResultRoutes =
  (objectStore?: RunResultObjectStore): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().route({
      ...publicContracts.GetRunResult,
      handler: async (request, reply) =>
        app.runEffect(
          request,
          reply,
          Effect.gen(function* () {
            const key = request.principal;
            if (!key) return yield* new ApiError({ reason: "INTERNAL" });
            const row = yield* app.store
              .getRun(request.params.run)
              .pipe(
                Effect.mapError((error) =>
                  error instanceof NotFoundError
                    ? new ApiError({ reason: "RUN_NOT_FOUND" })
                    : error,
                ),
              );
            if (
              (request.params.function !== "-" && request.params.function !== row.function_name) ||
              !key.allowsFunction(row.function_name) ||
              (!key.hasScope("admin") && row.created_by !== key.name)
            )
              return yield* new ApiError({ reason: "RUN_NOT_FOUND" });
            Reflect.set(request, "audit", { run_id: row.id, function: row.function_name });
            if (row.state !== "succeeded" && row.state !== "failed" && row.state !== "cancelled")
              return yield* new ApiError({ reason: "RUN_NOT_TERMINAL" });
            if (row.result !== null) {
              if (row.result_ref !== null) return yield* new ApiError({ reason: "INTERNAL" });
              const result = publicSchemas.Result.parse(row.result);
              const serialize = reply.getSerializationFunction("200");
              if (!serialize) return yield* new ApiError({ reason: "INTERNAL" });
              // Fastify bypasses normal response serialization for root strings.
              // Reuse the compiled Zod serializer, including for those roots.
              reply.type("application/json").serializer(serialize);
              return result;
            }
            if (row.result_ref === null) return yield* new ApiError({ reason: "RESULT_MISSING" });
            if (!objectStore || row.state !== "succeeded")
              return yield* new ApiError({ reason: "INTERNAL" });
            const storedRef = row.result_ref;
            const ref = yield* Effect.try({
              try: () => {
                const parsed = new URL(storedRef);
                if (
                  !parsed.hostname ||
                  storedRef !== `s3://${parsed.hostname}/runs/${row.id}/result.json`
                )
                  throw new Error("Invalid stored reference");
                return storedRef;
              },
              catch: () => new ApiError({ reason: "INTERNAL" }),
            });
            const location = yield* objectStore
              .presignGet(ref, 300)
              .pipe(Effect.mapError(() => new ApiError({ reason: "INTERNAL" })));
            yield* Effect.try({
              try: () => {
                const target = new URL(location);
                const origin = new URL(`${request.protocol}://${request.host}`).origin;
                const resolved = new URL(location, origin);
                if (
                  !/^https?:\/\//i.test(location) ||
                  !["http:", "https:"].includes(target.protocol) ||
                  resolved.origin !== target.origin ||
                  target.username ||
                  target.password ||
                  Array.from(location).some(
                    (value) => value.charCodeAt(0) <= 32 || value.charCodeAt(0) === 127,
                  ) ||
                  target.origin === origin
                )
                  throw new Error("Invalid signing target");
              },
              catch: () => new ApiError({ reason: "INTERNAL" }),
            });
            // The declared z.never() forbids a 307 document. Send absence through
            // the base transport type; native send(undefined) skips serialization.
            const response: FastifyReply = reply;
            return response
              .code(307)
              .header("Location", location)
              .header("Cache-Control", "no-store")
              .send();
          }),
        ),
    });
  };
