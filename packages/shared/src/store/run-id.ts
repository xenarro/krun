import { DateTime, Effect } from "effect";
import { v7 } from "uuid";
import { DatabaseError } from "./errors.js";

// The application owns the timestamp. No wall-clock read or import-time state.
export const newRunId = (at: DateTime.Utc) =>
  Effect.try({
    try: () => v7({ msecs: DateTime.toEpochMillis(at) }),
    catch: () => new DatabaseError({ operation: "newRunId" }),
  });
