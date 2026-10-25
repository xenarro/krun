import { it as effectIt } from "@effect/vitest";
import type { DateTime, Stream } from "effect";
import { Effect } from "effect";
import { expect, expectTypeOf, it } from "vitest";
import {
  ConflictError,
  DatabaseError,
  type Delivery,
  type DeliveryState,
  type JobStatus,
  type NewRun,
  NotFoundError,
  type PostgresTables,
  type Run,
  type RunError,
  type RunFilter,
  type RunSummary,
  type RuntimeStatus,
  type SqliteTables,
  type State,
  Store,
  type StoreShape,
} from "./index.js";

interface ExpectedStore {
  readonly createRun: (
    run: NewRun,
  ) => Effect.Effect<{ run: Run; created: boolean }, DatabaseError | ConflictError>;
  readonly getRun: (id: string) => Effect.Effect<Run, DatabaseError | NotFoundError>;
  readonly findRunByRequestId: (
    functionName: string,
    createdBy: string,
    requestId: string,
  ) => Effect.Effect<Run | undefined, DatabaseError>;
  readonly listRuns: (
    filter: RunFilter,
    cursor: string | null,
    limit: number,
  ) => Effect.Effect<{ runs: RunSummary[]; next: string | null }, DatabaseError>;
  readonly listByState: (states: State[], limit: number) => Effect.Effect<Run[], DatabaseError>;
  readonly countByState: () => Effect.Effect<Map<string, Map<State, number>>, DatabaseError>;
  readonly countQueued: (fn: string) => Effect.Effect<number, DatabaseError>;
  readonly countQueuedBy: (fn: string, createdBy: string) => Effect.Effect<number, DatabaseError>;
  readonly claimQueued: (
    fn: string,
    owner: string,
    leaseUntil: DateTime.Utc,
    limit: number,
  ) => Effect.Effect<Run[], DatabaseError>;
  readonly releaseLease: (id: string) => Effect.Effect<void, DatabaseError>;
  readonly setJobToken: (
    id: string,
    jobName: string,
    tokenHash: string,
  ) => Effect.Effect<void, DatabaseError>;
  readonly markScheduled: (id: string) => Effect.Effect<boolean, DatabaseError>;
  readonly transition: (
    id: string,
    from: State,
    to: State,
    reason: string | null,
    patch: Partial<Run>,
    event?: { actor: string },
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly setRuntimeStatus: (
    id: string,
    status: RuntimeStatus,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly setResult: (id: string, result: unknown) => Effect.Effect<boolean, DatabaseError>;
  readonly setError: (id: string, error: RunError) => Effect.Effect<boolean, DatabaseError>;
  readonly setJobStatus: (id: string, status: JobStatus) => Effect.Effect<boolean, DatabaseError>;
  readonly expireQueued: (
    fn: string,
    olderThan: DateTime.Utc,
  ) => Effect.Effect<Run[], DatabaseError>;
  readonly listStale: (fn: string, before: DateTime.Utc) => Effect.Effect<Run[], DatabaseError>;
  readonly subscribe: () => Stream.Stream<
    { id: string; kind: "state" | "status" | "job_status" },
    DatabaseError
  >;
  readonly claimDeliveries: (
    now: DateTime.Utc,
    limit: number,
  ) => Effect.Effect<Delivery[], DatabaseError>;
  readonly updateDelivery: (
    id: string,
    state: DeliveryState,
    attempt: number,
    nextAt: DateTime.Utc | null,
    lastError: string | null,
  ) => Effect.Effect<void, DatabaseError>;
  readonly sweep: (
    finishedBefore: DateTime.Utc,
    batch: number,
  ) => Effect.Effect<number, DatabaseError>;
  readonly migrate: () => Effect.Effect<void, DatabaseError>;
}

it("matches every SPEC Store method under the mandated Effect translation", () => {
  expectTypeOf<StoreShape>().toEqualTypeOf<ExpectedStore>();
  expectTypeOf(Store).toHaveProperty("key");
  expect(Store.key).toBe("krun/Store");
});

it("defines plain Kysely tables for both driver representations with application-owned time/ids", () => {
  expectTypeOf<keyof SqliteTables>().toEqualTypeOf<"runs" | "run_events" | "deliveries">();
  expectTypeOf<keyof PostgresTables>().toEqualTypeOf<keyof SqliteTables>();
  expectTypeOf<SqliteTables["runs"]["state"]>().toEqualTypeOf<State>();
  expectTypeOf<SqliteTables["runs"]["created_at"]>().toEqualTypeOf<string>();
  expectTypeOf<PostgresTables["runs"]["created_at"]>().toEqualTypeOf<Date>();
  expectTypeOf<SqliteTables["runs"]["input"]>().toEqualTypeOf<string>();
  expectTypeOf<PostgresTables["runs"]["input"]>().toEqualTypeOf<Run["input"]>();
  expectTypeOf<SqliteTables["runs"]["result"]>().toEqualTypeOf<string | null>();
  expectTypeOf<PostgresTables["runs"]["runtime_status"]>().toEqualTypeOf<
    (Omit<RuntimeStatus, "at"> & { at: string }) | null
  >();
  expectTypeOf<PostgresTables["runs"]["job_status"]>().toEqualTypeOf<
    (Omit<JobStatus, "observedAt"> & { observedAt: string }) | null
  >();
  expectTypeOf<SqliteTables["run_events"]["from_state"]>().toEqualTypeOf<State | null>();
  expectTypeOf<PostgresTables["deliveries"]["payload"]>().toEqualTypeOf<RunSummary>();
  expectTypeOf<SqliteTables["deliveries"]["payload"]>().toEqualTypeOf<string>();
  expectTypeOf<SqliteTables["deliveries"]["next_at"]>().toEqualTypeOf<string>();
});

it("keeps the complete SQL column set and BASIC projection types explicit", () => {
  expectTypeOf<keyof SqliteTables["runs"]>().toEqualTypeOf<keyof Run>();
  expectTypeOf<keyof Omit<PostgresTables["runs"], "idempotency_key_nul">>().toEqualTypeOf<
    keyof Run
  >();
  expectTypeOf<
    PostgresTables["runs"]["idempotency_key_nul"]["__select__"]
  >().toEqualTypeOf<Buffer | null>();
  expectTypeOf<keyof SqliteTables["run_events"]>().toEqualTypeOf<
    "rowid" | "run_id" | "at" | "from_state" | "to_state" | "reason" | "payload"
  >();
  expectTypeOf<keyof PostgresTables["run_events"]>().toEqualTypeOf<
    Exclude<keyof SqliteTables["run_events"], "rowid">
  >();
  expectTypeOf<SqliteTables["run_events"]["rowid"]["__select__"]>().toEqualTypeOf<number>();
  expectTypeOf<SqliteTables["run_events"]["rowid"]["__insert__"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<keyof SqliteTables["deliveries"]>().toEqualTypeOf<keyof Delivery>();
  expectTypeOf<Extract<keyof RunSummary, "input" | "result" | "logTail">>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof NonNullable<RunSummary["error"]>, "details">>().toEqualTypeOf<never>();
  expectTypeOf<RunSummary["state"]>().toEqualTypeOf<string>();
  expectTypeOf<Run["created_at"]>().toEqualTypeOf<DateTime.Utc>();
  expectTypeOf<NewRun["created_at"]>().toEqualTypeOf<DateTime.Utc>();
  expectTypeOf<NewRun["id"]>().toEqualTypeOf<string>();
});

effectIt.effect(
  "keeps domain/infrastructure errors tagged and safe in the typed failure channel",
  () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(Effect.fail(new NotFoundError({ id: "test-run" })));
      const conflict = yield* Effect.flip(Effect.fail(new ConflictError()));
      const database = yield* Effect.flip(Effect.fail(new DatabaseError({ operation: "getRun" })));
      expect(missing._tag).toBe("NotFoundError");
      expect(missing.id).toBe("test-run");
      expect(missing.message).toBe("Run not found");
      expect(conflict._tag).toBe("ConflictError");
      expect(conflict.message).toBe("Idempotency conflict");
      expect(database._tag).toBe("DatabaseError");
      expect(database.message).toBe("Database operation failed");
    }),
);
