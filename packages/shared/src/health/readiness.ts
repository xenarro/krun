import { Context, Effect, Exit, Fiber, Layer, Option, Ref, Semaphore } from "effect";

interface ReadinessState {
  readonly ready: boolean;
  readonly functionsSynced: boolean;
  readonly draining: boolean;
  readonly leader: boolean;
}

interface ReadinessResult {
  readonly status: "ok" | "unavailable";
  readonly leader: boolean;
}

export class Readiness extends Context.Service<
  Readiness,
  {
    readonly state: Ref.Ref<ReadinessState>;
    readonly check: Effect.Effect<ReadinessResult>;
  }
>()("krun/Readiness") {}

const eligible = (state: ReadinessState) => state.ready && state.functionsSynced && !state.draining;

// Store and Functions supply the real check and successful initial-LIST signal
// when those services exist. Constructing this layer never marks the process ready.
export const ReadinessLive = (databaseCheck: Effect.Effect<void, unknown>) =>
  Layer.effect(
    Readiness,
    Effect.gen(function* () {
      const state = yield* Ref.make<ReadinessState>({
        ready: false,
        functionsSynced: false,
        draining: false,
        leader: false,
      });
      const owner = yield* Effect.scope;
      const mutex = yield* Semaphore.make(1);
      type Flight = {
        readonly fiber: Fiber.Fiber<Exit.Exit<void, unknown>>;
        readonly generation: object;
        users: number;
      };
      let active: Flight | undefined;
      const acquire = Effect.gen(function* () {
        if (active !== undefined) {
          active.users++;
          return active;
        }
        const generation = {};
        const fiber = yield* Effect.forkIn(
          Effect.exit(databaseCheck).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                // Clear only after DB cleanup, never when the HTTP waiter times out.
                if (active?.generation === generation) active = undefined;
              }),
            ),
          ),
          owner,
          { startImmediately: false, uninterruptible: false },
        );
        const flight: Flight = { fiber, generation, users: 1 };
        active = fiber.pollUnsafe() === undefined ? flight : undefined;
        return flight;
      }).pipe(Semaphore.withPermit(mutex));
      const check = Effect.gen(function* () {
        const before = yield* Ref.get(state);
        if (!eligible(before)) {
          return { status: "unavailable", leader: before.leader } as const;
        }
        const database = yield* Effect.acquireUseRelease(
          acquire,
          // Time out only the waiter. Cancelling it never waits for DB cleanup.
          (flight) => Fiber.await(flight.fiber).pipe(Effect.timeoutOption("2 seconds")),
          (flight) =>
            Effect.sync(() => {
              flight.users--;
              if (flight.users === 0) flight.fiber.interruptUnsafe();
            }),
        );
        const after = yield* Ref.get(state);
        const available =
          Option.isSome(database) &&
          Exit.isSuccess(database.value) &&
          Exit.isSuccess(database.value.value) &&
          eligible(after);
        return { status: available ? "ok" : "unavailable", leader: after.leader } as const;
      });
      return { state, check };
    }),
  );
