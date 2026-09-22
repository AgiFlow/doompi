import type { TranscriptPage } from '@agimon-ai/doompi-core/sessionProtocol';
import { describe, expect, it } from 'vitest';

import { nativeTranscriptTail } from '../../src/services/nativeFleetTranscript';

function page(entries: unknown[], drafts: unknown[] = [], olderCursor?: string): TranscriptPage {
  return { entries, drafts, olderCursor } as unknown as TranscriptPage;
}

describe('nativeTranscriptTail', () => {
  it('projects native user, assistant, and correlated tool activity into fleet events', () => {
    const tail = nativeTranscriptTail(
      'run-1',
      page(
        [
          null,
          { message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'request' }, { type: 'image' }] } },
          { role: 'user', timestamp: 2, content: '   ' },
          {
            role: 'assistant',
            timestamp: 3,
            model: { provider: 'openai', id: 'gpt-5' },
            content: [
              { type: 'thinking', thinking: 'considering' },
              { type: 'thinking', thinking: ' ' },
              { type: 'text', text: 'working' },
              { type: 'text', text: '' },
              { type: 'toolCall', toolCallId: 'completed', toolName: 'read', input: { path: '/tmp/a' } },
              { type: 'toolCall', toolCallId: 'failed', toolName: 'bash', input: 'not-an-object' },
              { type: 'toolCall', toolCallId: 'running', toolName: 'grep', input: null },
            ],
          },
          {
            role: 'toolResult',
            timestamp: 4,
            toolCallId: 'completed',
            toolName: 'read',
            status: 'completed',
            isError: false,
            content: 'file contents',
          },
          {
            role: 'toolResult',
            timestamp: 5,
            toolCallId: 'failed',
            toolName: 'bash',
            status: 'completed',
            isError: true,
            content: [{ type: 'text', text: 'command failed' }],
          },
        ],
        [
          {
            role: 'toolResult',
            timestamp: 6,
            toolCallId: 'running',
            toolName: 'grep',
            status: 'running',
            isError: false,
            content: [],
          },
        ],
        'older-page',
      ),
    );

    expect(tail).toMatchObject({
      path: 'native:run-1',
      byteOffset: 0,
      size: 6,
      firstDirtyIndex: 0,
      droppedEvents: 1,
    });
    expect(tail.events).toEqual([
      { kind: 'user', at: 1, text: 'request' },
      { kind: 'thinking', at: 3, text: 'considering' },
      { kind: 'assistant', at: 3, text: 'working', model: 'openai/gpt-5' },
      {
        kind: 'tool',
        at: 3,
        text: '',
        name: 'read',
        status: 'ok',
        args: { path: '/tmp/a' },
        result: 'file contents',
        endedAt: 4,
      },
      {
        kind: 'tool',
        at: 3,
        text: '',
        name: 'bash',
        status: 'error',
        args: undefined,
        result: 'command failed',
        endedAt: 5,
      },
      {
        kind: 'tool',
        at: 3,
        text: '',
        name: 'grep',
        status: 'running',
        args: undefined,
        result: '',
      },
    ]);
    expect(tail.toolCalls).toEqual(new Map());
  });

  it('keeps orphan tool results visible and ignores malformed transcript entries', () => {
    const tail = nativeTranscriptTail(
      'run-2',
      page([
        undefined,
        [],
        { message: null },
        { role: 42, content: 'invalid role' },
        { role: 'user', timestamp: 10, content: 'plain request' },
        {
          role: 'toolResult',
          timestamp: 11,
          toolCallId: 'missing-error',
          toolName: 'bash',
          isError: true,
          status: 'completed',
          input: { command: 'false' },
          content: 'failed',
        },
        {
          role: 'toolResult',
          timestamp: 12,
          toolCallId: 'missing-running',
          toolName: 'read',
          isError: false,
          status: 'running',
          input: [],
          content: 12,
        },
        {
          role: 'toolResult',
          timestamp: 13,
          toolCallId: 'missing-complete',
          toolName: 'write',
          isError: false,
          status: 'completed',
          input: null,
          content: [{ type: 'text', text: 'done' }, { type: 'image' }],
        },
      ]),
    );

    expect(tail.droppedEvents).toBe(0);
    expect(tail.events).toEqual([
      { kind: 'user', at: 10, text: 'plain request' },
      {
        kind: 'tool',
        at: 11,
        text: '',
        name: 'bash',
        status: 'error',
        args: { command: 'false' },
        result: 'failed',
      },
      {
        kind: 'tool',
        at: 12,
        text: '',
        name: 'read',
        status: 'running',
        args: undefined,
        result: '',
      },
      {
        kind: 'tool',
        at: 13,
        text: '',
        name: 'write',
        status: 'ok',
        args: undefined,
        result: 'done',
      },
    ]);
  });
});
