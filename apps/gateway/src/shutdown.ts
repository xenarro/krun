import type { ServerResponse } from "node:http";
import { Context, Data, Deferred, Effect, Layer } from "effect";

class GatewayShutdownError extends Data.TaggedError("GatewayShutdownError") {}

export class GatewayShutdown extends Context.Service<
  GatewayShutdown,
  {
    readonly closing: Effect.Effect<void>;
    readonly track: (response: ServerResponse) => boolean;
    readonly finish: Effect.Effect<void, GatewayShutdownError>;
  }
>()("krun/gateway/Shutdown") {}

export const GatewayShutdownLive = Layer.effect(
  GatewayShutdown,
  Effect.gen(function* () {
    const closing = yield* Deferred.make<void>();
    const responses = new Set<ServerResponse>();
    let accepting = true;
    const track = (response: ServerResponse) => {
      if (!accepting || response.writableFinished || response.destroyed) return false;
      if (responses.has(response)) return true;
      responses.add(response);
      const done = () => {
        responses.delete(response);
        response.off("finish", done);
        response.off("close", done);
      };
      response.once("finish", done);
      response.once("close", done);
      return true;
    };
    const finish = Effect.gen(function* () {
      // Seal and snapshot synchronously: no admission can attach between the
      // snapshot and transport stop. Already-owned requests keep dependencies.
      accepting = false;
      const pending = [...responses].map(
        (response) =>
          new Promise<void>((resolve) => {
            if (response.writableFinished || response.destroyed) {
              resolve();
              return;
            }
            const done = () => {
              response.off("finish", done);
              response.off("close", done);
              resolve();
            };
            response.once("finish", done);
            response.once("close", done);
          }),
      );
      yield* Deferred.succeed(closing, undefined);
      yield* Effect.promise(() => Promise.all(pending)).pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError(() => new GatewayShutdownError()),
      );
    });
    return { closing: Deferred.await(closing), track, finish };
  }),
);
