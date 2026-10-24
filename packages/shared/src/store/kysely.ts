import type {
  DeliveryState,
  FailureReason,
  JobStatus,
  JsonObject,
  JsonValue,
  RunError,
  RunSummary,
  RuntimeStatus,
  State,
} from "./model.js";

type JsonColumn<Value, Serialized extends boolean> = Serialized extends true ? string : Value;
type StoredRuntimeStatus = Omit<RuntimeStatus, "at"> & { at: string };
type StoredJobStatus = Omit<JobStatus, "observedAt"> & { observedAt: string };

// Kysely consumes plain table interfaces. No generated ids/time columns:
// callers supply ids, timestamps and numeric defaults explicitly. Driver
// encoding/decoding is a later dialect-adapter responsibility, not wire mapping.
interface RunsTable<Timestamp, Serialized extends boolean> {
  id: string;
  idempotency_key: string | null;
  request_hash: string;
  function_name: string;
  input: JsonColumn<JsonObject, Serialized>;
  state: State;
  priority: number;
  attempt: number;
  lease_owner: string | null;
  lease_until: Timestamp | null;
  job_name: string | null;
  job_token_hash: string | null;
  result: JsonColumn<Exclude<JsonValue, null>, Serialized> | null;
  result_ref: string | null;
  error: JsonColumn<RunError, Serialized> | null;
  log_tail: string | null;
  failure_reason: FailureReason | null;
  runtime_status: JsonColumn<StoredRuntimeStatus, Serialized> | null;
  job_status: JsonColumn<StoredJobStatus, Serialized> | null;
  callback_url: string | null;
  created_by: string;
  created_at: Timestamp;
  scheduled_at: Timestamp | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

interface RunEventsTable<Timestamp, Serialized extends boolean> {
  run_id: string;
  at: Timestamp;
  from_state: State | null;
  to_state: State;
  reason: string | null;
  payload: JsonColumn<JsonObject, Serialized> | null;
}

interface DeliveriesTable<Timestamp, Serialized extends boolean> {
  id: string;
  run_id: string;
  url: string;
  payload: JsonColumn<RunSummary, Serialized>;
  attempt: number;
  next_at: Timestamp;
  state: DeliveryState;
  last_error: string | null;
  created_at: Timestamp;
}

interface Tables<Timestamp, Serialized extends boolean> {
  runs: RunsTable<Timestamp, Serialized>;
  run_events: RunEventsTable<Timestamp, Serialized>;
  deliveries: DeliveriesTable<Timestamp, Serialized>;
}

export type PostgresTables = Tables<Date, false>;
export type SqliteTables = Tables<string, true>;
