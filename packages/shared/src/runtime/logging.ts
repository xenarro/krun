import { Context, Effect, Logger, type LogLevel, Option, References, Tracer } from "effect";
import type { FastifyBaseLogger, FastifyRequest, FastifyServerOptions } from "fastify";

interface Destination {
  write(message: string): unknown;
}
// A scoped test/process destination, not an ambient mutable logger singleton.
export const LogDestination = Context.Reference<Destination | undefined>("krun/LogDestination", {
  defaultValue: () => undefined,
});
const levels: Record<string, LogLevel.LogLevel> = {
  fatal: "Fatal",
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
  silent: "None",
};
const methods = {
  Fatal: "fatal",
  Error: "error",
  Warn: "warn",
  Info: "info",
  Debug: "debug",
  Trace: "trace",
} as const;
const sensitive = ["input", "result", "runtimeStatus", "dsn", "body", "env", "manifest", "job"];
export const loggingOptions = (
  level: string,
  stream?: Destination,
): NonNullable<Exclude<FastifyServerOptions["logger"], boolean>> => ({
  level,
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-api-key"]',
      "error.details",
      "*.error.details",
      ...sensitive,
      ...sensitive.map((key) => `*.${key}`),
    ],
    remove: true,
  },
  serializers: {
    // Never serialize the raw URL/query, headers, bodies or arbitrary exceptions.
    req: (request: FastifyRequest) => ({ method: request.method }),
    res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    err: () => ({ type: "Error", message: "Unexpected failure", stack: "" }),
  },
  ...(stream === undefined ? {} : { stream }),
});
export const withPinoLogger = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  target: FastifyBaseLogger,
): Effect.Effect<A, E, R> => {
  const logger = Logger.make<unknown, void>(({ logLevel, message, fiber }) => {
    if (!(logLevel in methods)) return;
    const method = methods[logLevel as keyof typeof methods];
    const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
    const fields: Record<string, unknown> = { ...fiber.getRef(References.CurrentLogAnnotations) };
    for (const part of parts)
      if (
        typeof part === "object" &&
        part !== null &&
        !Array.isArray(part) &&
        !(part instanceof Error)
      )
        Object.assign(fields, part);
    // Correlation comes from the request child and active span, never payload fields.
    delete fields.reqId;
    delete fields.traceId;
    delete fields.spanId;
    const span = Context.getOption(fiber.context, Tracer.ParentSpan);
    if (Option.isSome(span)) {
      fields.traceId = span.value.traceId;
      fields.spanId = span.value.spanId;
    }
    target[method](
      fields,
      parts.filter((part): part is string => typeof part === "string").join(" "),
    );
  });
  return program.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(References.MinimumLogLevel, levels[target.level] ?? "Info"),
  );
};
