import type { IncomingMessage } from "node:http";
import { Clock, Effect, Exit, Metric, Option, Tracer } from "effect";
import {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import { v7 } from "uuid";
import { z } from "zod";
import { KrunConfig } from "../config/index.js";
import { LogDestination, loggingOptions } from "./logging.js";

const runIdentity = z.uuidv7();

const parseTraceparent = (value: string | string[] | undefined) => {
  if (typeof value !== "string") return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  const traceId = match?.[1],
    spanId = match?.[2],
    flags = match?.[3];
  if (!traceId || !spanId || !flags || /^0+$/.test(traceId) || /^0+$/.test(spanId))
    return undefined;
  return Tracer.externalSpan({ traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 });
};
export const requestTraceFields = (request: FastifyRequest) =>
  request.krunSpan === undefined
    ? {}
    : { traceId: request.krunSpan.traceId, spanId: request.krunSpan.spanId };
const requests = Metric.counter("krun_http_requests_total", { incremental: true });
const seconds = Metric.histogram("krun_http_request_seconds", {
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const field = (value: unknown, key: string): string | undefined =>
  object(value) && Object.hasOwn(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;
const publicPath = (url: string | undefined): boolean => {
  // Native HTTP accepts absolute-form targets. Strip only their authority:
  // WHATWG pathname normalization would alter dot segments/encoded paths that
  // the router preserves. Never log the raw target or its query.
  const path = url?.replace(/^https?:\/\/[^/?#]+/i, "");
  return path === "/v1" || path?.startsWith("/v1/") === true || path?.startsWith("/v1?") === true;
};
export const requestId = (raw: IncomingMessage, millis: number): string => {
  let fields = 0;
  for (let index = 0; index < raw.rawHeaders.length; index += 2)
    if (raw.rawHeaders[index]?.toLowerCase() === "x-request-id") fields++;
  const value = raw.headers["x-request-id"];
  // Only single,nonempty,HTTP-field-safe values can be echoed. Node otherwise
  // joins duplicate headers and lets inject represent illegal wire characters.
  if (
    fields <= 1 &&
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\t\x20-\x7e\x80-\xff]+$/.test(value)
  )
    return value;
  return v7({ msecs: millis });
};

// This native callback is invoked by Fastify's onResponse completion path,
// including bootstrap router failures that never execute registered hooks.
class HttpLogController extends LogController {
  readonly completed = new WeakSet<FastifyRequest>();
  readonly observe: (route: string, code: number, elapsed: number) => void;
  readonly audit: boolean;
  readonly beginSpan: (request: FastifyRequest, reply: FastifyReply) => void;
  readonly finishSpan: (request: FastifyRequest, reply: FastifyReply, closed?: boolean) => void;
  constructor(
    observe: (route: string, code: number, elapsed: number) => void,
    audit: boolean,
    beginSpan: HttpLogController["beginSpan"],
    finishSpan: HttpLogController["finishSpan"],
  ) {
    super({ disableRequestLogging: true });
    this.observe = observe;
    this.audit = audit;
    this.beginSpan = beginSpan;
    this.finishSpan = finishSpan;
  }
  override incomingRequest(request: FastifyRequest, reply: FastifyReply): void {
    reply.header("X-Request-Id", request.id);
    this.beginSpan(request, reply);
    // Bootstrap routing replies omit Fastify's ordinary response hooks. The
    // native finish event covers those too; the WeakSet deduplicates normal
    // completion callbacks without keeping requests alive.
    reply.raw.once("finish", () => this.requestCompleted(null, request, reply));
  }
  override requestCompleted(
    _error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.completed.has(request)) return;
    this.completed.add(request);
    this.finishSpan(request, reply);
    const route =
      reply.statusCode === 404 ? "unmatched" : (request.routeOptions.url ?? "unmatched");
    this.observe(route, reply.statusCode, Math.max(0, reply.elapsedTime / 1000));
    if (!this.audit || !(publicPath(request.routeOptions.url) || publicPath(request.raw.url)))
      return;
    const principal: unknown = Reflect.get(request, "principal");
    const params: unknown = request.params;
    const metadata: unknown = Reflect.get(request, "audit");
    const run = field(metadata, "run_id") ?? field(params, "run");
    const fn = field(metadata, "function") ?? field(params, "function");
    const idempotency = field(metadata, "idempotency_key") ?? field(request.query, "requestId");
    const fields = {
      event: "http_request",
      ...requestTraceFields(request),
      key: field(principal, "name") ?? null,
      client_ip: request.ip,
      user_agent: request.headers["user-agent"],
      route,
      code: reply.statusCode,
      ...(run === undefined ? {} : { run_id: run }),
      ...(fn === undefined ? {} : { function: fn }),
      ...(idempotency === undefined || idempotency.length > 128
        ? {}
        : { idempotency_key: idempotency }),
    };
    request.log[reply.statusCode === 401 || reply.statusCode === 403 ? "warn" : "info"](
      fields,
      "HTTP request",
    );
  }
}
declare module "fastify" {
  interface FastifyRequest {
    audit?: { run_id?: string; function?: string; idempotency_key?: string };
    krunSpan?: Tracer.Span;
  }
}
export const httpOptions = (
  audit: boolean,
  traceInternal = false,
): Effect.Effect<FastifyServerOptions> =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(KrunConfig);
    const destination = yield* LogDestination;
    const context = yield* Effect.context();
    const run = Effect.runSyncWith(context);
    const level = Option.isSome(config) ? config.value.config.KRUN_LOG_LEVEL : "info";
    const observe = (route: string, code: number, elapsed: number) =>
      run(
        Effect.gen(function* () {
          yield* Metric.update(Metric.withAttributes(requests, { route, code: String(code) }), 1);
          yield* Metric.update(Metric.withAttributes(seconds, { route }), elapsed);
        }),
      );
    const finishSpan = (request: FastifyRequest, reply: FastifyReply, closed = false) => {
      const span = request.krunSpan;
      if (span === undefined || span.status._tag === "Ended") return;
      span.attribute("http.response.status_code", reply.statusCode);
      const id = runIdentity.safeParse(request.audit?.run_id ?? field(request.params, "run"));
      if (id.success) span.attribute("krun.run_id", id.data);
      span.end(
        run(Clock.currentTimeNanos),
        closed || reply.statusCode >= 500 ? Exit.fail("HTTP request failed") : Exit.void,
      );
    };
    const beginSpan = (request: FastifyRequest, reply: FastifyReply) => {
      // Listener policy plus routed templates, never raw paths or query values.
      const route = request.routeOptions.url ?? "unmatched";
      const raw = request.raw.url?.replace(/^https?:\/\/[^/?#]+/i, "");
      const internalPath = (value: string | undefined) =>
        value === "/internal/v1" || value?.startsWith("/internal/v1/") === true;
      if (
        !(audit && (publicPath(route) || publicPath(request.raw.url))) &&
        !(traceInternal && (internalPath(route) || internalPath(raw)))
      )
        return;
      const parent = parseTraceparent(request.headers.traceparent);
      request.krunSpan = run(
        Effect.makeSpan(`${request.method} ${route}`, {
          kind: "server",
          ...(parent === undefined ? { root: true } : { parent }),
          attributes: { "http.request.method": request.method, "http.route": route },
        }),
      );
      reply.raw.once("close", () => finishSpan(request, reply, !reply.raw.writableFinished));
    };
    return {
      logger: loggingOptions(level, destination),
      requestIdHeader: false as const,
      genReqId: (request: IncomingMessage) => requestId(request, run(Clock.currentTimeMillis)),
      trustProxy: true,
      logController: new HttpLogController(observe, audit, beginSpan, finishSpan),
    };
  });
