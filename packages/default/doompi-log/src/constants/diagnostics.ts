export const DIAGNOSE_AGENT_NAME = 'diagnose_agent';
export const DIAGNOSE_AGENT_DESCRIPTION =
  'Inspect captured failures and token usage for the current DoomPi session. Read-only, bounded to the last day or week; omits prompts, tool arguments, credentials, and unrelated sessions.';
export const AGENT_DIAGNOSTIC_TOOL_LIMIT = 10;
export const AGENT_DIAGNOSTIC_MAX_TOOLS = 20;
export const AGENT_DIAGNOSTIC_TIMEOUT_MS = 15_000;
export const AGENT_ISSUE_CATEGORIES = [
  'tool_failure',
  'infrastructure_failure',
  'caller_error',
  'expected_failure',
  'page_state',
  'api_error',
  'api_refusal',
  'api_retries_exhausted',
  'tool_rejected',
  'log_error',
] as const;
export const AGENT_DIAGNOSTIC_SKILL = {
  name: 'doompi-debug-agent',
  description:
    'Debug a DoomPi agent using session-scoped failure and usage evidence. Distinguish missing telemetry from a healthy run, diagnose expensive or failed tools, and investigate deeper traces without exposing secrets or changing the sink.',
} as const;
