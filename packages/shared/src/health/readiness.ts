import { Context, Effect, Exit, Layer, Option, Ref } from "effect";

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
      const check = Effect.gen(function* () {
        const before = yield* Ref.get(state);
        if (!eligible(before)) {
          return { status: "unavailable", leader: before.leader } as const;
        }
        const database = yield* Effect.exit(databaseCheck.pipe(Effect.timeoutOption("2 seconds")));
        const after = yield* Ref.get(state);
        const available =
          Exit.isSuccess(database) && Option.isSome(database.value) && eligible(after);
        return { status: available ? "ok" : "unavailable", leader: after.leader } as const;
      });
      return { state, check };
    }),
  );
