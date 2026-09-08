import { describe, expect, it } from 'vitest';
import { buildRealtimeContext } from '../src/adapters/pi/realtimeContext.ts';

function message(messageValue: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', message: messageValue };
}

describe('buildRealtimeContext', () => {
  it('projects bounded visible conversation, task progress, and pending question provenance', () => {
    const entries = [
      message({ role: 'user', content: [{ type: 'text', text: 'Please update voice.' }] }),
      message({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'I am checking the tests.' },
          { type: 'toolCall', id: 'task-call', name: 'task', arguments: { secret: 'tool arguments' } },
        ],
      }),
      message({
        role: 'toolResult',
        toolName: 'task',
        toolCallId: 'task-call',
        content: [{ type: 'text', text: 'private tool output' }],
        details: { tasks: [{ id: 1, subject: 'Run focused tests', status: 'in_progress', credentials: 'secret' }] },
      }),
      message({
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'ask-1',
            name: 'ask_user_question',
            arguments: {
              questions: [{ question: 'Use the safe path?', options: [{ label: 'Yes' }, { label: 'No' }] }],
            },
          },
        ],
      }),
      message({
        role: 'toolResult',
        toolName: 'ask_user_question',
        toolCallId: 'ask-1',
        content: [{ type: 'text', text: 'private question tool output' }],
        details: { awaitingResponse: true },
      }),
      { type: 'custom', data: { accessToken: 'credential-value' } },
    ];

    const context = buildRealtimeContext(entries, { busy: true });

    expect(context).toContain('provenance="pi-visible-branch"');
    expect(context).toContain('"busy":true');
    expect(context).toContain('Please update voice.');
    expect(context).toContain('I am checking the tests.');
    expect(context).toContain('Run focused tests');
    expect(context).toContain('Use the safe path? Yes | No');
    expect(context).not.toContain('private reasoning');
    expect(context).not.toContain('private tool output');
    expect(context).not.toContain('tool arguments');
    expect(context).not.toContain('credential-value');
  });

  it('keeps the serialized projection within 8192 characters and prefers recent conversation', () => {
    const entries = Array.from({ length: 300 }, (_, index) =>
      message({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `${index}:${'x'.repeat(4_000)}` }],
      }),
    );

    const context = buildRealtimeContext(entries, { busy: false });

    expect(context.length).toBeLessThanOrEqual(8_192);
    expect(context).toContain('299:');
    expect(context).not.toContain('0:');
    expect(context.endsWith('</realtime-context>')).toBe(true);
  });

  it('does not traverse arbitrary visible custom messages or non-text assistant blocks', () => {
    const context = buildRealtimeContext(
      [
        { type: 'custom_message', display: true, content: 'arbitrary custom content' },
        message({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }] }),
      ],
      { busy: false },
    );

    expect(context).not.toContain('arbitrary custom content');
    expect(context).not.toContain('hidden');
    expect(context).toContain('"conversation":[]');
  });
});
