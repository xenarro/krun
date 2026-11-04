import { toRun } from "@krun/shared/dist/store/index.js";
import { Effect } from "effect";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ApiError } from "./errors.js";
import { visibleRun } from "./plugins.js";
import { publicContracts, publicSchemas } from "./public-contracts.js";

// Persist the request to cancel; only the scheduler completes cancellation.
export const cancelRunRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().route({
    ...publicContracts.CancelRun,
    handler: async (request, reply) =>
      app.runEffect(
        request,
        reply,
        Effect.gen(function* () {
          const key = request.principal;
          if (!key) return yield* new ApiError({ reason: "INTERNAL" });
          while (true) {
            const row = yield* visibleRun(app.store, request);
            if (row.state === "cancelling" || row.state === "cancelled")
              return publicSchemas.Run.parse(toRun(row));
            if (row.state === "succeeded" || row.state === "failed")
              return yield* new ApiError({
                reason: "RUN_TERMINAL",
                metadata: { state: row.state.toUpperCase() },
              });
            yield* app.store.transition(
              row.id,
              row.state,
              "cancelling",
              null,
              {},
              { actor: key.name },
            );
            // A CAS winner and loser both resolve the current authorized row.
            // Store owns transaction completion; response work stays interruptible.
            yield* Effect.yieldNow;
          }
        }),
      ),
  });
};
