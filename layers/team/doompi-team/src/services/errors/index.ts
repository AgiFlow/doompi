export type DoomTeamErrorCode =
  | 'invalid_request'
  | 'unsupported_operation'
  | 'unsupported_context'
  | 'agent_not_found'
  | 'runtime_unavailable'
  | 'model_unavailable'
  | 'run_not_found'
  | 'ambiguous_run_id'
  | 'run_terminal'
  | 'not_resumable'
  | 'communication_unavailable'
  | 'recipient_not_found'
  | 'recipient_ambiguous'
  | 'delivery_unconfirmed'
  | 'reply_timeout'
  | 'status_corrupt'
  | 'operation_conflict'
  | 'tool_conflict';

export class DoomTeamExpectedError extends Error {
  constructor(
    readonly code: DoomTeamErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly recovery: string,
  ) {
    super(`[${code}] ${message}\nRecovery: ${recovery}`);
    this.name = 'DoomTeamExpectedError';
  }
}

export function invalidRequest(message: string, recovery: string): DoomTeamExpectedError {
  return new DoomTeamExpectedError('invalid_request', message, false, recovery);
}
