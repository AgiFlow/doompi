export const TASK_EVENT = {
  notificationFailed: 'doom_task.notification_failed',
  storeReadFailed: 'doom_task.store_read_failed',
  storeLockTimeout: 'doom_task.store_lock_timeout',
  storeLockBreakFailed: 'doom_task.store_lock_break_failed',
  storeWatchFailed: 'doom_task.store_watch_failed',
  storeListenerFailed: 'doom_task.store_listener_failed',
  storeCommitListenerFailed: 'doom_task.store_commit_listener_failed',
  storeSweepFailed: 'doom_task.store_sweep_failed',
  sessionStartFailed: 'doom_task.session_start_failed',
  toolFailed: 'doom_task.tool_failed',
  delegationRequestFailed: 'doom_task.delegation_request_failed',
  delegationStartFailed: 'doom_task.delegation_start_failed',
  delegationResponseFailed: 'doom_task.delegation_response_failed',
  delegationSettleFailed: 'doom_task.delegation_settle_failed',
  delegationTimedOut: 'doom_task.delegation_timed_out',
  delegationOrphaned: 'doom_task.delegation_orphaned',
  // Info-level lifecycle events. These are the measurement pair: the shape of
  // the brief that went out, and the cost of the run it produced.
  delegationAssigned: 'doom_task.delegation_assigned',
  delegationCompleted: 'doom_task.delegation_completed',
} as const;

export type TaskEventName = (typeof TASK_EVENT)[keyof typeof TASK_EVENT];
export type TaskErrorAttributes = Record<string, string | number | boolean>;
export type TaskErrorSink = (event: TaskEventName, error: unknown, attributes?: TaskErrorAttributes) => void;
export type TaskEventSink = (event: TaskEventName, attributes?: TaskErrorAttributes) => void;

/** Host-neutral telemetry port consumed by Task services and store adapters. */
export interface TaskFailureReporter {
  error: TaskErrorSink;
  warn: TaskErrorSink;
  /** Info-level event sink. Required so an unwired reporter fails to compile. */
  event: TaskEventSink;
}
