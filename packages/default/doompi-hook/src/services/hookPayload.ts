import type { HookPayload, HookToolEvent } from '../types/hooks.ts';
import { toClaudeToolName } from './toolNames.ts';

const TOOL_RESULT_EVENT = 'tool_result';

/** The payload shape a Claude Code session hook is written against. */
export function toolHookPayload(
  event: HookToolEvent,
  hookEventName: string,
  repoRoot: string,
  sessionId: string,
): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: '',
    cwd: repoRoot,
    hook_event_name: hookEventName,
    tool_name: toClaudeToolName(event.toolName),
    tool_input: event.input,
    ...(event.type === TOOL_RESULT_EVENT ? { tool_response: { success: !event.isError, content: event.content } } : {}),
  };
}

/** Session lifecycle hooks observe no tool, so they only need where and who. */
export function sessionHookPayload(sessionId: string, repoRoot: string): HookPayload {
  return { session_id: sessionId, cwd: repoRoot };
}
