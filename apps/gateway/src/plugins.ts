import type { KeyPrincipal, Keys } from "@krun/shared/dist/auth/keys.js";
import type { KeyScope } from "@krun/shared/dist/auth/schema.js";
import type { Functions } from "@krun/shared/dist/functions/cache.js";
import { withPinoLogger } from "@krun/shared/dist/runtime/logging.js";
import { NotFoundError, type Store } from "@krun/shared/dist/store/index.js";
import { Cause, type Context, Effect, Exit } from "effect";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { ApiError } from "./errors.js";

export type GatewayDependencies = Store | Functions | Keys;
interface PublicRoutePolicy {
  readonly scope: KeyScope;
  readonly functionParam?: string;
}
export type RunEffect = <A, E>(
  request: FastifyRequest,
  reply: FastifyReply,
  program: Effect.Effect<A, E, GatewayDependencies>,
) => Promise<A>;
declare module "fastify" {
  interface FastifyInstance {
    readonly store: Store["Service"];
    readonly functions: Functions["Service"];
    readonly keys: Keys["Service"];
    readonly runEffect: RunEffect;
  }
  interface FastifyRequest {
    principal: KeyPrincipal | null;
  }
  interface FastifyContextConfig {
    krun?: PublicRoutePolicy;
  }
}

// Embedding edge: preserve the owning Effect context and wait for cancelled
// roots/finalizers before the app's Store/cache/key dependencies can close.
export const requestRunner = <R>(context: Context.Context<R>) => {
  const run = Effect.runPromiseExitWith(context);
  const active = new Map<AbortController, Promise<unknown>>();
  let stopping = false;
  const runEffect = async <A, E>(
    request: FastifyRequest,
    reply: FastifyReply,
    program: Effect.Effect<A, E, R>,
  ): Promise<A> => {
    if (stopping) throw new ApiError({ reason: "INTERNAL" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Fastify's signal follows IncomingMessage.close, including NORMAL fully
    // consumed POST bodies. Only a real incomplete/destroyed transport aborts
    // the program; response.close below covers disconnects after body completion.
    const signalAbort = () => {
      if (!request.raw.complete || request.raw.aborted || reply.raw.destroyed) abort();
    };
    const close = () => {
      if (!reply.raw.writableFinished) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    request.signal.addEventListener("abort", signalAbort, { once: true });
    if (request.raw.aborted || reply.raw.destroyed) abort();
    else if (request.signal.aborted) signalAbort();
    const pending = Promise.resolve().then(() =>
      run(
        withPinoLogger(
          request.krunSpan === undefined
            ? program
            : program.pipe(Effect.withParentSpan(request.krunSpan)),
          request.log,
        ),
        { signal: controller.signal },
      ),
    );
    active.set(controller, pending);
    try {
      const result = await pending;
      if (Exit.isSuccess(result)) return result.value;
      const failure = result.cause.reasons[0];
      if (result.cause.reasons.length === 1 && failure !== undefined && Cause.isFailReason(failure))
        throw failure.error;
      throw new ApiError({ reason: "INTERNAL" });
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
      request.signal.removeEventListener("abort", signalAbort);
      active.delete(controller);
    }
  };
  const stop = async () => {
    stopping = true;
    const pending = [...active.values()];
    for (const controller of active.keys()) controller.abort();
    await Promise.allSettled(pending);
  };
  return { runEffect, stop };
};

// Shared by the public and internal listeners. Node discards duplicate
// Authorization values from normalized headers, so inspect the raw field names
// before accepting the otherwise valid first value. HTTP auth schemes are case
// insensitive; a credential is one opaque token.
export const bearerToken = (request: FastifyRequest): string | undefined => {
  let fields = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") fields++;
  if (fields > 1) return undefined;
  return /^Bearer +([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
};

// Page tokens are untrusted input: accept only canonical base64url of strict,
// versioned JSON bound to the context of the list request that issued it.
export const decodePageToken = <T extends { readonly context: string }>(
  token: string,
  schema: z.ZodType<T>,
  context: string,
) =>
  Effect.try({
    try: () => {
      if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid cursor");
      const bytes = Buffer.from(token, "base64url");
      if (bytes.toString("base64url") !== token) throw new Error("Invalid cursor");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = schema.parse(JSON.parse(text));
      if (parsed.context !== context) throw new Error("Invalid cursor");
      return parsed;
    },
    catch: () => new ApiError({ reason: "REQUEST_INVALID" }),
  });

// Native Fastify encapsulation: dependencies are visible only to this plugin
// and descendant route plugins, never an admin/internal listener or sibling.
export const servicesPlugin: FastifyPluginAsync<{
  store: Store["Service"];
  functions: Functions["Service"];
  keys: Keys["Service"];
  runEffect: RunEffect;
  routes: FastifyPluginAsync;
}> = async (app, options) => {
  app.decorate("store", options.store);
  app.decorate("functions", options.functions);
  app.decorate("keys", options.keys);
  app.decorate("runEffect", options.runEffect);
  app.register(authPlugin, { routes: options.routes });
};
const authPlugin: FastifyPluginAsync<{ routes: FastifyPluginAsync }> = async (app, options) => {
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    if (request.is404) return;
    const principal = await app.runEffect(
      request,
      reply,
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (token === undefined)
          return yield* new ApiError({
            reason: request.headers.authorization === undefined ? "KEY_MISSING" : "KEY_INVALID",
          });
        const key = yield* app.keys
          .lookup(token)
          .pipe(Effect.mapError(() => new ApiError({ reason: "KEY_INVALID" })));
        request.principal = key;
        const policy = request.routeOptions.config.krun;
        if (!policy) return yield* new ApiError({ reason: "INTERNAL" });
        if (!key.hasScope(policy.scope))
          return yield* new ApiError({
            reason: "SCOPE_MISSING",
            metadata: { scope: policy.scope },
          });
        if (policy.functionParam !== undefined) {
          const name = (request.params as Record<string, unknown>)[policy.functionParam];
          if (typeof name !== "string" || !key.allowsFunction(name))
            return yield* new ApiError({ reason: "FUNCTION_NOT_FOUND" });
        }
        return key;
      }),
    );
    request.principal = principal;
  });
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.is404) return payload;
    const contentType = request.headers["content-type"];
    if (
      contentType !== undefined &&
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    )
      throw new ApiError({ reason: "CONTENT_TYPE_UNSUPPORTED" });
    return payload;
  });
  app.register(options.routes);
};

// The one run-visibility rule for every run-scoped method. Hidden runs are
// indistinguishable from absent ones, so every miss is RUN_NOT_FOUND.
export const visibleRun = (
  store: Store["Service"],
  request: FastifyRequest<{ Params: { function: string; run: string } }>,
) =>
  Effect.gen(function* () {
    const key = request.principal;
    if (!key) return yield* new ApiError({ reason: "INTERNAL" });
    const row = yield* store
      .getRun(request.params.run)
      .pipe(
        Effect.mapError((error) =>
          error instanceof NotFoundError ? new ApiError({ reason: "RUN_NOT_FOUND" }) : error,
        ),
      );
    if (
      (request.params.function !== "-" && request.params.function !== row.function_name) ||
      !key.allowsFunction(row.function_name) ||
      (!key.hasScope("admin") && row.created_by !== key.name)
    )
      return yield* new ApiError({ reason: "RUN_NOT_FOUND" });
    request.audit = { run_id: row.id, function: row.function_name };
    return row;
  });
