import type {
  AssistantTranscriptItem,
  SessionServiceState,
  TranscriptItem,
  UserTranscriptItem,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { describe, expect, it } from 'vitest';
import { createProtocolTimeline, toQueuedEntries, toTimelineEntries } from '../../src/web/lib/protocolTimeline.ts';

const MODEL = { provider: 'anthropic', id: 'opus' };

describe('protocol transcript projection', () => {
  it('renders live progress beside history, retains concurrent tools, and commits without duplicates', () => {
    const project = createProtocolTimeline();
    const user: UserTranscriptItem = {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      timestamp: 1,
    };
    const state: SessionServiceState = {
      snapshot: {
        id: 'session',
        cwd: '/',
        createdAt: 1,
        updatedAt: 1,
        phase: 'turn',
        model: MODEL,
        thinkingLevel: 'medium',
        attached: true,
        locked: false,
        revision: 1,
        transcript: [user],
        queuedSteer: [],
        queuedSteerCount: 0,
      },
      progress: null,
    };
    const assistant: AssistantTranscriptItem = {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      model: MODEL,
      status: 'streaming',
      timestamp: 2,
    };
    expect(project({ ...state, progress: { type: 'item_started', item: assistant } })).toMatchObject([
      { kind: 'user' },
      { kind: 'assistant', text: 'working', streaming: true },
    ]);
    const updated = { ...assistant, content: [{ type: 'text' as const, text: 'working now' }] };
    expect(project({ ...state, progress: { type: 'item_updated', item: updated } })[1]).toMatchObject({
      text: 'working now',
    });
    const tool: TranscriptItem = {
      id: 't',
      role: 'tool',
      toolCallId: 't',
      toolName: 'read',
      input: {},
      content: [],
      status: 'running',
      isError: false,
      timestamp: 3,
    };
    expect(project({ ...state, progress: { type: 'item_started', item: tool } }).map((entry) => entry.id)).toEqual([
      'u',
      'a',
      't',
    ]);
    expect(project(state).map((entry) => entry.id)).toEqual(['u', 'a', 't']);
    const finished = { ...updated, status: 'complete' as const };
    const committed = { ...state.snapshot, transcript: [user, finished] };
    expect(project({ snapshot: committed, progress: { type: 'item_finished', item: finished } })).toMatchObject([
      { id: 'u' },
      { id: 'a', streaming: false },
      { id: 't', running: true },
    ]);
    expect(project({ snapshot: { ...committed, phase: 'idle' }, progress: null }).map((entry) => entry.id)).toEqual([
      'u',
      'a',
    ]);
    expect(createProtocolTimeline()(state).map((entry) => entry.id)).toEqual(['u']);
  });

  it('renders a user message as its text', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'do the thing' }], timestamp: 1 },
    ];

    expect(toTimelineEntries(items)).toEqual([{ kind: 'user', id: 'u1', text: 'do the thing' }]);
  });

  it('retains supported user images and drops image content with unsupported MIME types', () => {
    const items: TranscriptItem[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: 'review this' },
          { type: 'image', data: 'cG5n', mimeType: 'image/png' },
          { type: 'image', data: 'c3Zn', mimeType: 'image/svg+xml' },
        ],
        timestamp: 1,
      },
    ];

    expect(toTimelineEntries(items)).toEqual([
      { kind: 'user', id: 'u1', text: 'review this', images: [{ data: 'cG5n', mimeType: 'image/png' }] },
    ]);
  });

  it('splits assistant text from its thinking and reports streaming', () => {
    const items: TranscriptItem[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it' },
          { type: 'text', text: 'here is why' },
        ],
        model: MODEL,
        status: 'streaming',
        timestamp: 2,
      },
    ];

    expect(toTimelineEntries(items)).toEqual([
      { kind: 'assistant', id: 'a1', text: 'here is why', thinking: 'weighing it', streaming: true },
    ]);
  });

  it('marks a settled assistant message as no longer streaming', () => {
    const items: TranscriptItem[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        model: MODEL,
        status: 'complete',
        stopReason: 'stop',
        timestamp: 2,
      },
    ];

    expect(toTimelineEntries(items)[0]).toMatchObject({ streaming: false, text: 'done' });
  });

  it('hands a tool call its arguments and details so the owning plugin can render it', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1',
        role: 'tool',
        toolCallId: 't1',
        toolName: 'read',
        input: { path: '/a.ts' },
        content: [{ type: 'text', text: 'file body' }],
        details: { anchors: ['5#abc'] },
        status: 'complete',
        isError: false,
        timestamp: 3,
      },
    ];

    expect(toTimelineEntries(items)[0]).toEqual({
      kind: 'tool',
      id: 't1',
      toolCallId: 't1',
      name: 'read',
      args: { path: '/a.ts' },
      // The summary is what the collapsed card shows.
      argSummary: '/a.ts',
      result: { content: [{ type: 'text', text: 'file body' }], details: { anchors: ['5#abc'] } },
      output: 'file body',
      isError: false,
      running: false,
    });
  });

  it('shows a running tool with no result yet', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1',
        role: 'tool',
        toolCallId: 't1',
        toolName: 'bash',
        input: { command: 'ls' },
        content: [],
        status: 'running',
        isError: false,
        timestamp: 3,
      },
    ];

    expect(toTimelineEntries(items)[0]).toMatchObject({ running: true, result: null, argSummary: 'ls' });
  });

  it('carries a tool failure through as an error', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1',
        role: 'tool',
        toolCallId: 't1',
        toolName: 'bash',
        input: {},
        content: [{ type: 'text', text: 'exit 1' }],
        status: 'error',
        isError: true,
        timestamp: 3,
      },
    ];

    expect(toTimelineEntries(items)[0]).toMatchObject({ isError: true, running: false, output: 'exit 1' });
  });

  it('keeps the transcript in the order the server published it', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: MODEL,
        status: 'complete',
        stopReason: 'stop',
        timestamp: 2,
      },
    ];

    expect(toTimelineEntries(items).map((entry) => entry.kind)).toEqual(['user', 'assistant']);
  });

  it('reuses a projection while the protocol item is unchanged', () => {
    const item: UserTranscriptItem = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'keep this settled row' }],
      timestamp: 1,
    };

    const first = toTimelineEntries([item])[0];
    expect(toTimelineEntries([item])[0]).toBe(first);

    const updated: UserTranscriptItem = { ...item, content: [{ type: 'text', text: 'replace changed rows' }] };
    expect(toTimelineEntries([updated])[0]).not.toBe(first);
  });

  it('projects the authoritative protocol queue with its text and images', () => {
    const queue: UserTranscriptItem[] = [
      {
        id: 'queued-1',
        role: 'user',
        content: [
          { type: 'text', text: 'run the release checks' },
          { type: 'image', data: 'cG5n', mimeType: 'image/png' },
        ],
        timestamp: 3,
      },
    ];

    expect(toQueuedEntries(queue)).toEqual([
      {
        kind: 'queued',
        id: 'queued-1',
        text: 'run the release checks',
        delivery: 'steer',
        images: [{ data: 'cG5n', mimeType: 'image/png' }],
      },
    ]);
  });
});
