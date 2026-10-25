import { Keys } from "@krun/shared/dist/auth/keys.js";
import { Functions } from "@krun/shared/dist/functions/cache.js";
import { httpOptions } from "@krun/shared/dist/runtime/http.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { Data, Effect } from "effect";
import Fastify, { type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError, errorEnvelope, sendError } from "./errors.js";
import { type GatewayDependencies, requestRunner, servicesPlugin } from "./plugins.js";
import { strictRequestRoot } from "./request-schema.js";

export class PublicAppError extends Data.TaggedError("PublicAppError")<{
  readonly operation: "register";
}> {}
export interface PublicAppOptions {
  readonly routes?: FastifyPluginAsync;
}

// Builds but never listens. Concrete API methods are supplied as descendant
// route plugins by their own tasks; importing this factory acquires nothing.
export const makePublicApp = (options: PublicAppOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const functions = yield* Functions;
    const keys = yield* Keys;
    const context = yield* Effect.context<GatewayDependencies>();
    const runner = requestRunner(context);
    const observability = yield* httpOptions(true);
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Fastify({
          ...observability,
          exposeHeadRoutes: false,
          frameworkErrors: (error, _request, reply) => sendError(reply, error),
        }),
      ),
      (app) =>
        Effect.promise(async () => {
          await runner.stop();
          await app.close();
        }).pipe(Effect.ignoreCause),
    );
    const missingBody = Symbol("krun/missing-body");
    app.setValidatorCompiler<z.ZodType>((options) => {
      const validate = validatorCompiler(options);
      return (data) => validate(data === missingBody ? undefined : data);
    });
    app.setSerializerCompiler(serializerCompiler);
    app.removeContentTypeParser("text/plain");
    app.setErrorHandler((error, request, reply) => {
      const envelope = errorEnvelope(error);
      if (envelope.error.code >= 500)
        request.log.error(
          { reason: envelope.error.details[0]?.reason ?? "INTERNAL" },
          "Request failed",
        );
      return sendError(reply, error);
    });
    app.setNotFoundHandler((_request, reply) =>
      sendError(reply, new ApiError({ reason: "ROUTE_NOT_FOUND" })),
    );
    // Also cancel requests when a caller explicitly closes the app. onClose would
    // run too late: Fastify waits for active handlers before reaching that hook.
    app.addHook("preClose", runner.stop);
    app.addHook("onRequest", async (request, reply) => {
      if (request.is404) return sendError(reply, new ApiError({ reason: "ROUTE_NOT_FOUND" }));
    });
    const emptyBody = z.strictObject({});
    app.addHook("preValidation", async (request) => {
      if (request.routeOptions.schema?.body !== undefined && request.body === undefined) {
        // A private marker survives Fastify's undefined-to-null normalization.
        // The compiler restores absence before Zod, preserving optional/default
        // semantics without treating explicit JSON null as an omitted body.
        request.body = missingBody;
      }
      // A method with no declared body accepts omission or an empty object, not
      // arbitrary JSON. Check absence before Fastify's validator adapter turns
      // undefined into null; explicit JSON null must still fail.
      if (
        request.routeOptions.schema?.body === undefined &&
        request.body !== undefined &&
        !emptyBody.safeParse(request.body).success
      ) {
        throw new ApiError({ reason: "REQUEST_INVALID" });
      }
    });
    app.addHook("onRoute", (route) => {
      if (!route.config?.krun) throw new PublicAppError({ operation: "register" });
      const schema = {
        ...route.schema,
        querystring: route.schema?.querystring ?? z.strictObject({}),
      };
      // Never silently strip unknown krun-owned top-level members. Opaque user
      // data is represented by nested records/custom schemas, not rebuilt here.
      for (const part of ["querystring", "params", "body"] as const) {
        if (schema[part] !== undefined) schema[part] = strictRequestRoot(schema[part]);
      }
      route.schema = schema;
      route.attachValidation = false;
    });
    app.register(servicesPlugin, {
      store,
      functions,
      keys,
      runEffect: runner.runEffect,
      routes: options.routes ?? (async () => {}),
    });
    yield* Effect.tryPromise({
      try: () => app.ready(),
      catch: () => new PublicAppError({ operation: "register" }),
    });
    return app;
  });
