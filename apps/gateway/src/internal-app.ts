import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Transform } from "node:stream";
import { httpOptions, requestTraceFields } from "@krun/shared/dist/runtime/http.js";
import { InternalStoreSignal } from "@krun/shared/dist/runtime/internal-store-call.js";
import { DatabaseError, NotFoundError } from "@krun/shared/dist/store/errors.js";
import { Store } from "@krun/shared/dist/store/index.js";
import { Clock, DateTime, Effect, Semaphore } from "effect";
import Fastify, { type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { ApiError, errorEnvelope, sendError } from "./errors.js";
import { internalContracts } from "./internal-contracts.js";
import { requestRunner } from "./plugins.js";

// Separate instance and service context: no public key hooks/routes, no cache,
// no admin handlers. Captures its owning Effect clock/logger/Store once.
export const makeInternalApp = (config: { readonly maxResultBytes: number }) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const runner = requestRunner(yield* Effect.context<Store>());
    const app = yield* Effect.acquireRelease(
      Effect.map(httpOptions(false, true), (options) =>
        Fastify({
          ...options,
          exposeHeadRoutes: false,
          return503OnClosing: false,
          frameworkErrors: (error, request, reply) => {
            request.log.info(
              {
                event: "internal_request",
                ...requestTraceFields(request),
                user_agent: request.headers["user-agent"],
                route: "unmatched",
                code: errorEnvelope(error).error.code,
              },
              "Internal HTTP request",
            );
            if (!request.raw.complete) reply.header("Connection", "close");
            return sendError(reply, error);
          },
        }),
      ),
      (app) =>
        Effect.promise(async () => {
          await app.close();
          await runner.stop();
        }).pipe(Effect.ignoreCause),
    );
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.removeContentTypeParser("text/plain");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      app.getDefaultJsonParser("ignore", "ignore"),
    );
    const caps = (request: FastifyRequest) =>
      request.routeOptions.url === internalContracts.SetResult.url
        ? config.maxResultBytes
        : request.routeOptions.url === internalContracts.ReportStatus.url
          ? 16384
          : 32768;
    const tooLarge = (request: FastifyRequest) =>
      new ApiError({
        reason:
          request.routeOptions.url === internalContracts.SetResult.url
            ? "RESULT_TOO_LARGE"
            : "REQUEST_TOO_LARGE",
      });
    app.setErrorHandler((error, request, reply) => {
      const code: unknown =
        error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
      const mapped = code === "FST_ERR_CTP_BODY_TOO_LARGE" ? tooLarge(request) : error;
      const envelope = errorEnvelope(mapped);
      if (envelope.error.code === 413 || !request.raw.complete) reply.header("Connection", "close");
      if (envelope.error.code >= 500)
        request.log.error(
          { ...requestTraceFields(request), reason: envelope.error.details[0]?.reason },
          "Internal request failed",
        );
      return sendError(reply, mapped);
    });
    const notFound = (request: FastifyRequest) => {
      const path = request.raw.url?.replace(/^https?:\/\/[^/?#]+/i, "").split("?")[0] ?? "";
      const version = /^\/internal\/v([1-9]\d*)(\/|$)/.exec(path)?.[1];
      return new ApiError({
        reason:
          version !== undefined && version !== "1" ? "UNSUPPORTED_API_VERSION" : "ROUTE_NOT_FOUND",
      });
    };
    let closing = false;
    app.setNotFoundHandler((request, reply) => sendError(reply, notFound(request)));
    app.addHook("onSend", async (request, reply, payload) => {
      if (closing || (reply.statusCode >= 400 && !request.raw.complete))
        reply.header("Connection", "close");
      return payload;
    });
    // Body readers live outside the Effect request runner. Seal admission and
    // destroy only incomplete messages at listener close (after runtime drain),
    // leaving complete/validated Store work to settle against live dependencies.
    const reading = new Set<IncomingMessage>();
    app.addHook("preClose", async () => {
      closing = true;
      for (const raw of reading) if (!raw.complete) raw.destroy();
    });
    const accepting = (state: string, hash: string | null) =>
      hash !== null && (state === "queued" || state === "scheduled" || state === "running");
    const bounded = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        return yield* Effect.raceFirst(
          program.pipe(Effect.provideService(InternalStoreSignal, controller.signal)),
          Effect.sleep("5 seconds").pipe(
            Effect.andThen(Effect.sync(() => controller.abort())),
            Effect.andThen(Effect.fail(new ApiError({ reason: "NOT_READY" }))),
          ),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof NotFoundError
              ? new ApiError({ reason: "TOKEN_INVALID" })
              : error instanceof DatabaseError
                ? new ApiError({ reason: "NOT_READY" })
                : error,
          ),
        );
      });
    app.addHook("onRequest", async (request, reply) => {
      const raw = request.raw;
      const forget = () => {
        reading.delete(raw);
        raw.off("end", forget);
        raw.off("close", forget);
      };
      reading.add(raw);
      raw.once("end", forget);
      raw.once("close", forget);
      if (closing) return sendError(reply, new ApiError({ reason: "NOT_READY" }));
      if (request.is404) return sendError(reply, notFound(request));
      await runner.runEffect(
        request,
        reply,
        Effect.gen(function* () {
          const run: unknown =
            request.params !== null && typeof request.params === "object"
              ? Reflect.get(request.params, "run")
              : undefined;
          let fields = 0;
          for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
            if (request.raw.rawHeaders[i]?.toLowerCase() === "authorization") fields++;
          const token = /^Bearer +([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
          if (
            fields > 1 ||
            !token ||
            typeof run !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run)
          )
            return yield* new ApiError({ reason: "TOKEN_INVALID" });
          const row = yield* bounded(store.getRun(run));
          if (
            !accepting(row.state, row.job_token_hash) ||
            !/^[0-9a-f]{64}$/.test(row.job_token_hash ?? "") ||
            !timingSafeEqual(
              createHash("sha256").update(token).digest(),
              Buffer.from(row.job_token_hash ?? "", "hex"),
            )
          )
            return yield* new ApiError({ reason: "TOKEN_INVALID" });
        }),
      );
    });
    app.addHook("onResponse", async (request, reply) => {
      request.log[reply.statusCode === 401 ? "warn" : "info"](
        {
          event: "internal_request",
          ...requestTraceFields(request),
          user_agent: request.headers["user-agent"],
          route: request.routeOptions.url ?? "unmatched",
          code: reply.statusCode,
        },
        "Internal HTTP request",
      );
    });
    app.addHook("preParsing", async (request, _reply, payload) => {
      const media = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (request.method !== "GET" && media !== "application/json")
        throw new ApiError({ reason: "CONTENT_TYPE_UNSUPPORTED" });
      if (media !== undefined && media !== "application/json")
        throw new ApiError({ reason: "CONTENT_TYPE_UNSUPPORTED" });
      if (Number(request.headers["content-length"]) > caps(request)) throw tooLarge(request);
      if (caps(request) === 0) {
        // Fastify requires a positive bodyLimit. For the supported zero cap,
        // reject the first counted byte before JSON parsing, not after a write.
        const guard = new Transform({
          transform(chunk, _encoding, done) {
            done(chunk.length > 0 ? tooLarge(request) : null, chunk);
          },
        });
        payload.once("error", (error) => guard.destroy(error));
        return payload.pipe(guard);
      }
      return payload;
    });
    // Serialize status attempts per run, not globally. Remove idle lock entries;
    // retain only last successful acceptance windows, opportunistically expired.
    const locks = new Map<string, { mutex: Semaphore.Semaphore; users: number }>();
    const accepted = new Map<string, number>();
    const statusWrite = (id: string, write: Effect.Effect<boolean, unknown>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(id) ?? { mutex: Semaphore.makeUnsafe(1), users: 0 };
          entry.users++;
          locks.set(id, entry);
          return entry;
        }),
        (entry) =>
          entry.mutex.withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              for (const [run, at] of accepted) if (now - at >= 1000) accepted.delete(run);
              const last = accepted.get(id);
              if (last !== undefined && now - last < 1000)
                return yield* new ApiError({ reason: "STATUS_RATE_LIMITED" });
              const changed = yield* write;
              if (!changed) return yield* new ApiError({ reason: "TOKEN_INVALID" });
              accepted.set(id, yield* Clock.currentTimeMillis);
            }),
          ),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0) locks.delete(id);
          }),
      );
    app.route({
      ...internalContracts.GetInput,
      handler: async (request, reply) => {
        const row = await runner.runEffect(
          request,
          reply,
          bounded(store.getRun((request.params as { run: string }).run)),
        );
        if (!accepting(row.state, row.job_token_hash))
          return sendError(reply, new ApiError({ reason: "TOKEN_INVALID" }));
        const body = JSON.stringify(row.input);
        return reply
          .type("application/json")
          .header("Content-Length", Buffer.byteLength(body))
          .serializer((value) => String(value))
          .send(body);
      },
    });
    app.route({
      ...internalContracts.ReportStatus,
      bodyLimit: 16384,
      handler: async (request, reply) => {
        const id = (request.params as { run: string }).run;
        const body = internalContracts.ReportStatus.schema.body.parse(request.body);
        await runner.runEffect(
          request,
          reply,
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            yield* bounded(
              statusWrite(
                id,
                store.setRuntimeStatus(id, {
                  message: body.message,
                  at,
                  ...(body.progress === undefined ? {} : { progress: body.progress }),
                  ...(body.data === undefined ? {} : { data: body.data }),
                }),
              ),
            );
          }),
        );
        return reply.code(204).send();
      },
    });
    app.route({
      ...internalContracts.SetResult,
      bodyLimit: Math.max(1, config.maxResultBytes),
      handler: async (request, reply) => {
        const changed = await runner.runEffect(
          request,
          reply,
          bounded(store.setResult((request.params as { run: string }).run, request.body)),
        );
        if (!changed) return sendError(reply, new ApiError({ reason: "TOKEN_INVALID" }));
        return reply.code(204).send();
      },
    });
    app.route({
      ...internalContracts.SetError,
      bodyLimit: 32768,
      handler: async (request, reply) => {
        const body = internalContracts.SetError.schema.body.parse(request.body);
        const changed = await runner.runEffect(
          request,
          reply,
          bounded(
            store.setError((request.params as { run: string }).run, {
              message: body.message,
              source: "function",
              ...(body.type === undefined ? {} : { type: body.type }),
              ...(body.details === undefined ? {} : { details: body.details }),
            }),
          ),
        );
        if (!changed) return sendError(reply, new ApiError({ reason: "TOKEN_INVALID" }));
        return reply.code(204).send();
      },
    });
    yield* Effect.tryPromise({
      try: () => app.ready(),
      catch: () => new ApiError({ reason: "INTERNAL" }),
    });
    return app;
  });
