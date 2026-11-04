import { Effect } from "effect";
import { DatabaseError } from "./errors.js";
import type { StoreShape } from "./index.js";

// Driver promises cannot be cancelled safely. Settle commit/rollback and
// connection release before interruption can close the owning Database scope.
export const traced = <A, E>(
  operation: keyof StoreShape,
  id: string | undefined,
  body: Effect.Effect<A, E>,
) =>
  body.pipe(
    Effect.uninterruptible,
    Effect.withSpan(`store.${operation}`, {
      kind: "client",
      attributes: {
        "db.operation.name": operation,
        "db.response.returned_rows": 0,
        ...(id === undefined ? {} : { "krun.run_id": id }),
      },
    }),
  );

export const adapter = <A>(
  operation: keyof StoreShape,
  execute: () => Promise<{ value: A; rowCount: number }>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: execute,
      catch: () => new DatabaseError({ operation }),
    });
    yield* Effect.annotateCurrentSpan("db.response.returned_rows", result.rowCount);
    return result.value;
  });
