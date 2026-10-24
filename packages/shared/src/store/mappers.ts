import { DateTime } from "effect";
import type { Run, RunResource, RunSummary, SummaryRow } from "./model.js";

// Whitelist BASIC directly: list queries need not fetch FULL-only columns and
// getters/opaque details must not be evaluated merely to discard them later.
export const toRunSummary = (row: SummaryRow): RunSummary => ({
  name: `functions/${row.function_name}/runs/${row.id}`,
  state: row.state.toUpperCase(),
  priority: row.priority,
  attempt: row.attempt,
  createdBy: row.created_by,
  createTime: DateTime.formatIso(row.created_at),
  ...(row.callback_url === null ? {} : { callback: { url: row.callback_url } }),
  ...(row.result_ref === null ? {} : { resultUri: row.result_ref }),
  ...(row.job_name === null ? {} : { jobName: row.job_name }),
  ...(row.scheduled_at === null ? {} : { scheduleTime: DateTime.formatIso(row.scheduled_at) }),
  ...(row.started_at === null ? {} : { startTime: DateTime.formatIso(row.started_at) }),
  ...(row.finished_at === null ? {} : { endTime: DateTime.formatIso(row.finished_at) }),
  ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason.toUpperCase() }),
  ...(row.error === null
    ? {}
    : {
        error: {
          source: row.error.source.toUpperCase(),
          message: row.error.message,
          ...(row.error.type === undefined ? {} : { type: row.error.type }),
        },
      }),
  ...(row.runtime_status === null
    ? {}
    : {
        runtimeStatus: {
          message: row.runtime_status.message,
          reportTime: DateTime.formatIso(row.runtime_status.at),
          ...(row.runtime_status.progress === undefined
            ? {}
            : { progress: row.runtime_status.progress }),
          ...(row.runtime_status.data === undefined ? {} : { data: row.runtime_status.data }),
        },
      }),
  ...(row.job_status === null
    ? {}
    : {
        jobStatus: {
          observeTime: DateTime.formatIso(row.job_status.observedAt),
          ...(row.job_status.podName === undefined ? {} : { podName: row.job_status.podName }),
          ...(row.job_status.phase === undefined ? {} : { phase: row.job_status.phase }),
          ...(row.job_status.reason === undefined ? {} : { reason: row.job_status.reason }),
          ...(row.job_status.message === undefined ? {} : { message: row.job_status.message }),
          ...(row.job_status.exitCode === undefined ? {} : { exitCode: row.job_status.exitCode }),
        },
      }),
});

export const toRun = (row: Run): RunResource => {
  const summary = toRunSummary(row);
  return {
    ...summary,
    input: row.input,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.log_tail === null ? {} : { logTail: row.log_tail }),
    ...(summary.error === undefined || row.error?.details === undefined
      ? {}
      : {
          error: { ...summary.error, details: row.error.details },
        }),
  };
};
