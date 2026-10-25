import type { DateTime, Effect, Stream } from "effect";
import { Context } from "effect";
import type { ConflictError, DatabaseError, NotFoundError } from "./errors.js";
import type {
  Delivery,
  DeliveryState,
  JobStatus,
  NewRun,
  Run,
  RunError,
  RunFilter,
  RunSummary,
  RuntimeStatus,
  State,
} from "./model.js";

// SPEC section 6 under STACK's Effect translation: Promise -> Effect,
// Date -> DateTime.Utc, abortable AsyncIterable -> scoped Stream. No Store
// layer or database operations are implemented by this contract declaration.
export interface StoreShape {
  readonly createRun: (
    run: NewRun,
  ) => Effect.Effect<{ run: Run; created: boolean }, ConflictError | DatabaseError>;
  readonly getRun: (id: string) => Effect.Effect<Run, NotFoundError | DatabaseError>;
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

export class Store extends Context.Service<Store, StoreShape>()("krun/Store") {}

export { ConflictError, DatabaseError, NotFoundError } from "./errors.js";
export type { PostgresTables, SqliteTables } from "./kysely.js";
export { toRun, toRunSummary } from "./mappers.js";
export type {
  Delivery,
  DeliveryState,
  JobStatus,
  NewRun,
  Run,
  RunError,
  RunFilter,
  RunSummary,
  RuntimeStatus,
  State,
} from "./model.js";
export { failureReasons, states } from "./model.js";
