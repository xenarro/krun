import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { GatewayShutdown, GatewayShutdownLive } from "./shutdown.js";

it.effect(
  "shutdown atomically seals registrations before awaiting already-owned native responses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* GatewayShutdown;
        const first = new ServerResponse(new IncomingMessage(new Socket()));
        const late = new ServerResponse(new IncomingMessage(new Socket()));
        owner.track(first);
        const finishing = yield* Effect.forkChild(owner.finish);
        yield* owner.closing;
        expect(owner.track(late)).toBe(false);
        first.emit("finish");
        yield* Fiber.join(finishing);
        expect(first.listenerCount("finish")).toBe(0);
        expect(first.listenerCount("close")).toBe(0);
      }),
    ).pipe(Effect.provide(GatewayShutdownLive)),
);
