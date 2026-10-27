import { Context, Effect } from "effect";
import type { Run, State } from "./model.js";

// Only lifecycle metadata crosses the post-commit observability boundary.
export type RunChange = Pick<
  Run,
  | "function_name"
  | "state"
  | "failure_reason"
  | "created_at"
  | "scheduled_at"
  | "started_at"
  | "finished_at"
>;
export const RunChangeObserver = Context.Reference<(run: RunChange) => Effect.Effect<void>>(
  "krun/RunChangeObserver",
  { defaultValue: () => () => Effect.void },
);
export const observeRunChange = (run: Run, from: State) =>
  Effect.gen(function* () {
    if (run.state === from) return;
    const observe = yield* RunChangeObserver;
    yield* observe({
      function_name: run.function_name,
      state: run.state,
      failure_reason: run.failure_reason,
      created_at: run.created_at,
      scheduled_at: run.scheduled_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
    });
  });
