export const SLASH_RESULT_CUSTOM_TYPE = 'subagent-slash-result';

/**
 * One run's line in a slash-result message. `status` is the tracker's own
 * status string (plus `started`), not a closed set this module can narrow.
 */
export interface SlashRunDetail {
  agent: string;
  runId: string;
  status: string;
  error?: string;
  warning?: string;
}
