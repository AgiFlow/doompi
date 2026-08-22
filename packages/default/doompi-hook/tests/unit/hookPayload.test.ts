import { describe, expect, it } from 'vitest';
import { sessionHookPayload, toolHookPayload } from '../../src/services/hookPayload.ts';

describe('hook payloads', () => {
  it('names the tool the way a Claude Code hook expects to read it', () => {
    const payload = toolHookPayload(
      { type: 'tool_call', toolName: 'bash', input: { command: 'pwd' } },
      'PreToolUse',
      '/repo',
      'session-1',
    );

    expect(payload).toEqual({
      session_id: 'session-1',
      transcript_path: '',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    });
  });

  it('adds the tool response only for a result, reporting success as the inverse of isError', () => {
    const payload = toolHookPayload(
      { type: 'tool_result', toolName: 'write', input: {}, content: [{ type: 'text' }], isError: true },
      'PostToolUse',
      '/repo',
      'session-2',
    );

    expect(payload.tool_response).toEqual({ success: false, content: [{ type: 'text' }] });
  });

  it('gives session lifecycle hooks only where and who', () => {
    expect(sessionHookPayload('session-3', '/repo')).toEqual({ session_id: 'session-3', cwd: '/repo' });
  });
});
