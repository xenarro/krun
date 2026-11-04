import { createHash } from "node:crypto";
import type { KeyPrincipal } from "@krun/shared/dist/auth/keys.js";
import { toRun, toRunSummary } from "@krun/shared/dist/store/mappers.js";
import type { RunFilter, RunSummary } from "@krun/shared/dist/store/model.js";
import { runFilterSchema } from "@krun/shared/dist/store/run-filter.js";
import { validateRunCursor } from "@krun/shared/dist/store/run-queries.js";
import { Effect } from "effect";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { decodePageToken, visibleRun } from "./plugins.js";
import { publicContracts } from "./public-contracts.js";

const tokenSchema = z.strictObject({
  v: z.literal(1),
  cursor: z.string().min(1).max(512),
  context: z.string().regex(/^[0-9a-f]{64}$/),
});
const contextHash = (parent: string, filter: string, key: KeyPrincipal) =>
  createHash("sha256")
    .update(JSON.stringify(["ListRuns:v1", parent, filter, key.name, key.scopes, key.functions]))
    .digest("hex");

// History visibility is determined from stored resources and the current key,
// not a current/Ready Function cache entry. Compose under makePublicApp.
export const runReadRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    ...publicContracts.GetRun,
    handler: async (request, reply) =>
      app.runEffect(
        request,
        reply,
        Effect.gen(function* () {
          const row = yield* visibleRun(app.store, request);
          return request.query.view === "BASIC" ? toRunSummary(row) : toRun(row);
        }),
      ),
  });
  typed.route({
    ...publicContracts.ListRuns,
    handler: async (request, reply) =>
      app.runEffect(
        request,
        reply,
        Effect.gen(function* () {
          const key = request.principal;
          if (!key) return yield* new ApiError({ reason: "INTERNAL" });
          const parent = request.params.function;
          if (parent !== "-" && !key.allowsFunction(parent))
            return yield* new ApiError({ reason: "FUNCTION_NOT_FOUND" });
          const rawFilter = request.query.filter ?? "";
          const context = contextHash(parent, rawFilter, key);
          let cursor = request.query.pageToken
            ? (yield* decodePageToken(request.query.pageToken, tokenSchema, context)).cursor
            : null;
          const parsed = runFilterSchema.safeParse(rawFilter);
          if (!parsed.success) return yield* new ApiError({ reason: "FILTER_INVALID" });
          const filter: RunFilter = {
            ...parsed.data,
            ...(parent === "-" ? {} : { function_name: parent }),
            ...(key.hasScope("admin") ? {} : { created_by: key.name }),
          };
          if (cursor !== null) {
            const value = cursor;
            yield* Effect.try({
              try: () => validateRunCursor(value, filter),
              catch: () => new ApiError({ reason: "REQUEST_INVALID" }),
            });
          }
          const size = Math.min(request.query.pageSize || 50, 200);
          const runs: RunSummary[] = [];
          const visible = (row: RunSummary) => key.allowsFunction(row.name.split("/")[1] ?? "");
          // Request at most the remaining visible slots, so no batch can overrun
          // the page and no private Store cursor needs to be reconstructed.
          do {
            const page = yield* app.store.listRuns(filter, cursor, size - runs.length);
            runs.push(...page.runs.filter(visible));
            cursor = page.next;
          } while (runs.length < size && cursor !== null);
          const afterPage = cursor;
          // Do not expose a continuation merely because hidden records remain.
          // Probe BASIC only; the continuation stays at the returned page boundary.
          while (cursor !== null) {
            const page = yield* app.store.listRuns(filter, cursor, 200);
            if (page.runs.some(visible))
              return {
                runs,
                nextPageToken: Buffer.from(
                  JSON.stringify({ v: 1, cursor: afterPage, context }),
                ).toString("base64url"),
              };
            cursor = page.next;
          }
          return { runs, nextPageToken: "" };
        }),
      ),
  });
};
