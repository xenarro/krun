import { Clock, Context, DateTime, Effect, Metric } from "effect";
import type { State, StoreShape } from "../store/index.js";
import { type RunChange, RunChangeObserver } from "../store/observations.js";

const transitions = Metric.counter("krun_runs_transitions_total", { incremental: true });
const failed = Metric.counter("krun_runs_failed_total", { incremental: true });
// Per-call observation only: never persisted or shared across concurrent runs.
export const TerminalExitAt = Context.Reference<DateTime.Utc | undefined>("krun/TerminalExitAt", {
  defaultValue: () => undefined,
});
const current = Metric.gauge("krun_runs_current");
const boundaries = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400];
const queueWait = Metric.histogram("krun_queue_wait_seconds", { boundaries });
const coldStart = Metric.histogram("krun_cold_start_seconds", { boundaries });
const duration = Metric.histogram("krun_run_duration_seconds", { boundaries });
const terminalDetect = Metric.histogram("krun_terminal_detect_seconds", { boundaries });
const seconds = (start: DateTime.Utc, end: DateTime.Utc) =>
  Math.max(0, (DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 1000);
const observe = (run: RunChange) =>
  Effect.gen(function* () {
    const labels = { function: run.function_name };
    if (run.state === "failed" && run.failure_reason !== null)
      yield* Metric.update(
        Metric.withAttributes(failed, { ...labels, reason: run.failure_reason }),
        1,
      );
    const exitedAt = yield* TerminalExitAt;
    if (
      exitedAt !== undefined &&
      run.finished_at !== null &&
      ["succeeded", "failed", "cancelled"].includes(run.state)
    )
      yield* Metric.update(
        Metric.withAttributes(terminalDetect, labels),
        Math.max(0, ((yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(exitedAt)) / 1000),
      );
    yield* Metric.update(Metric.withAttributes(transitions, { ...labels, to: run.state }), 1);
    if (run.state === "scheduled" && run.scheduled_at !== null)
      yield* Metric.update(
        Metric.withAttributes(queueWait, labels),
        seconds(run.created_at, run.scheduled_at),
      );
    if (run.state === "running" && run.scheduled_at !== null && run.started_at !== null)
      yield* Metric.update(
        Metric.withAttributes(coldStart, labels),
        seconds(run.scheduled_at, run.started_at),
      );
    if (
      run.finished_at !== null &&
      run.started_at !== null &&
      ["succeeded", "failed", "cancelled"].includes(run.state)
    )
      yield* Metric.update(
        Metric.withAttributes(duration, { ...labels, state: run.state }),
        seconds(run.started_at, run.finished_at),
      );
  });

// Capture only in leader components. Gateway/standby calls on the underlying
// Store retain the no-op observer even in an embedded, shared-Store process.
export const leaderRunStore = (store: StoreShape): StoreShape => ({
  ...store,
  markScheduled: (...args) =>
    store.markScheduled(...args).pipe(Effect.provideService(RunChangeObserver, observe)),
  transition: (...args) =>
    store.transition(...args).pipe(Effect.provideService(RunChangeObserver, observe)),
  expireQueued: (...args) =>
    store.expireQueued(...args).pipe(Effect.provideService(RunChangeObserver, observe)),
});

// One publisher per leader term. Never reach into MetricRegistry's private keys.
export const makeRunGauges = Effect.gen(function* () {
  let previous = new Map<string, Map<State, number>>();
  let closed = false;
  const publish = (counts: Map<string, Map<State, number>>) =>
    Effect.gen(function* () {
      if (closed) return;
      for (const [fn, values] of previous)
        for (const state of values.keys())
          if (!counts.get(fn)?.has(state))
            yield* Metric.update(Metric.withAttributes(current, { function: fn, state }), 0);
      for (const [fn, values] of counts)
        for (const [state, count] of values)
          yield* Metric.update(Metric.withAttributes(current, { function: fn, state }), count);
      previous = new Map([...counts].map(([fn, values]) => [fn, new Map(values)]));
    }).pipe(Effect.uninterruptible);
  yield* Effect.addFinalizer(() =>
    publish(new Map()).pipe(
      Effect.andThen(
        Effect.sync(() => {
          closed = true;
        }),
      ),
    ),
  );
  return publish;
});
