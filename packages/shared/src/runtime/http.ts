import type { IncomingMessage } from "node:http";
import { Clock, Effect, Metric, Option } from "effect";
import {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import { v7 } from "uuid";
import { KrunConfig } from "../config/index.js";
import { LogDestination, loggingOptions } from "./logging.js";

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
  constructor(observe: (route: string, code: number, elapsed: number) => void, audit: boolean) {
    super({ disableRequestLogging: true });
    this.observe = observe;
    this.audit = audit;
  }
  override incomingRequest(request: FastifyRequest, reply: FastifyReply): void {
    reply.header("X-Request-Id", request.id);
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
  }
}
export const httpOptions = (audit: boolean): Effect.Effect<FastifyServerOptions> =>
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
    return {
      logger: loggingOptions(level, destination),
      requestIdHeader: false as const,
      genReqId: (request: IncomingMessage) => requestId(request, run(Clock.currentTimeMillis)),
      trustProxy: true,
      logController: new HttpLogController(observe, audit),
    };
  });
