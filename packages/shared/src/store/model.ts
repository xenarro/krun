import type { DateTime } from "effect";

export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const states = [
  "queued",
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type State = (typeof states)[number];
export const failureReasons = [
  "exit_code",
  "oom_killed",
  "deadline_exceeded",
  "evicted",
  "disrupted",
  "heartbeat_timeout",
  "job_create_failed",
  "job_lost",
  "queue_timeout",
] as const;
export type FailureReason = (typeof failureReasons)[number];
export type DeliveryState = "pending" | "delivered" | "dead";

export interface RunError {
  readonly source: "function" | "kubernetes" | "krun";
  readonly message: string;
  readonly type?: string;
  readonly details?: JsonObject;
}

export interface RuntimeStatus {
  readonly message: string;
  readonly progress?: number;
  readonly data?: JsonObject;
  readonly at: DateTime.Utc;
}

export interface JobStatus {
  readonly podName?: string;
  readonly phase?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly exitCode?: number;
  readonly observedAt: DateTime.Utc;
}

// Dialect adapters normalize driver values to this model; null denotes an
// unset SQL column, never an optional field in a public response.
export interface Run {
  readonly id: string;
  readonly idempotency_key: string | null;
  readonly request_hash: string;
  readonly function_name: string;
  readonly input: JsonObject;
  readonly state: State;
  readonly priority: number;
  readonly attempt: number;
  readonly lease_owner: string | null;
  readonly lease_until: DateTime.Utc | null;
  readonly job_name: string | null;
  readonly job_token_hash: string | null;
  readonly result: JsonValue;
  readonly result_ref: string | null;
  readonly error: RunError | null;
  readonly log_tail: string | null;
  readonly failure_reason: FailureReason | null;
  readonly runtime_status: RuntimeStatus | null;
  readonly job_status: JobStatus | null;
  readonly callback_url: string | null;
  readonly created_by: string;
  readonly created_at: DateTime.Utc;
  readonly scheduled_at: DateTime.Utc | null;
  readonly started_at: DateTime.Utc | null;
  readonly finished_at: DateTime.Utc | null;
}

export type NewRun = Pick<
  Run,
  | "id"
  | "idempotency_key"
  | "request_hash"
  | "function_name"
  | "input"
  | "priority"
  | "callback_url"
  | "created_by"
  | "created_at"
>;
export type SummaryRow = Omit<Run, "input" | "result" | "log_tail">;

export interface RunResource {
  readonly name: string;
  readonly state: string;
  readonly attempt: number;
  readonly priority: number;
  readonly input: JsonObject;
  readonly callback?: { readonly url: string };
  readonly result?: Exclude<JsonValue, null>;
  readonly resultUri?: string;
  readonly error?: Omit<RunError, "source"> & { readonly source: string };
  readonly logTail?: string;
  readonly failureReason?: string;
  readonly runtimeStatus?: Omit<RuntimeStatus, "at"> & { readonly reportTime: string };
  readonly jobStatus?: Omit<JobStatus, "observedAt"> & { readonly observeTime: string };
  readonly jobName?: string;
  readonly createdBy: string;
  readonly createTime: string;
  readonly scheduleTime?: string;
  readonly startTime?: string;
  readonly endTime?: string;
}

export type RunSummary = Omit<RunResource, "input" | "result" | "logTail" | "error"> & {
  readonly error?: Omit<NonNullable<RunResource["error"]>, "details">;
};

// The parser/SQL implementation belongs to P1.6. Terms compose with AND and
// carry the exact supported operators; scoping is separate from user filters.
export interface RunFilter {
  readonly function_name?: string;
  readonly created_by?: string;
  readonly terms?: readonly (
    | { readonly field: "state"; readonly operator: "=" | "!="; readonly value: State }
    | { readonly field: "failureReason"; readonly operator: "="; readonly value: FailureReason }
    | {
        readonly field: "createTime";
        readonly operator: ">=" | "<=" | ">" | "<";
        readonly value: DateTime.Utc;
      }
  )[];
}

export interface Delivery {
  readonly id: string;
  readonly run_id: string;
  readonly url: string;
  readonly payload: RunSummary;
  readonly attempt: number;
  readonly next_at: DateTime.Utc;
  readonly state: DeliveryState;
  readonly last_error: string | null;
  readonly created_at: DateTime.Utc;
}
