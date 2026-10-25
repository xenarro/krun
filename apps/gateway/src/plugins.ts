import type { KeyPrincipal, Keys } from "@krun/shared/dist/auth/keys.js";
import type { KeyScope } from "@krun/shared/dist/auth/schema.js";
import type { Functions } from "@krun/shared/dist/functions/cache.js";
import { withPinoLogger } from "@krun/shared/dist/runtime/logging.js";
import type { Store } from "@krun/shared/dist/store/index.js";
import { Cause, type Context, Effect, Exit } from "effect";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
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
export const requestRunner = (context: Context.Context<GatewayDependencies>) => {
  const run = Effect.runPromiseExitWith(context);
  const active = new Map<AbortController, Promise<unknown>>();
  let stopping = false;
  const runEffect: RunEffect = async (request, reply, program) => {
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
      run(withPinoLogger(program, request.log), { signal: controller.signal }),
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
        const header = request.headers.authorization;
        // Node discards duplicate Authorization values from normalized headers.
        // Inspect the raw field names before accepting the otherwise valid first key.
        let authorizationFields = 0;
        for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
          if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization")
            authorizationFields++;
        }
        if (authorizationFields > 1) return yield* new ApiError({ reason: "KEY_INVALID" });
        if (header === undefined) return yield* new ApiError({ reason: "KEY_MISSING" });
        // HTTP auth schemes are case insensitive; a credential is one opaque token.
        const matched = /^Bearer +([^\s,]+)$/i.exec(header);
        if (!matched?.[1]) return yield* new ApiError({ reason: "KEY_INVALID" });
        const key = yield* app.keys
          .lookup(matched[1])
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
