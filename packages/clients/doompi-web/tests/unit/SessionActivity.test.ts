import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../src/types/hub';
import { sessionActivity } from '../../src/web/features/session/SessionActivity';
import { initialSessionState } from '../../src/web/lib/sessionModel';
import type { SessionMeta } from '../../src/web/stores/sessionsStore';

function meta(
  overrides: Partial<SessionMeta['summary']> = {},
  attach: SessionMeta['attach'] = 'attached',
): SessionMeta {
  const summary: SessionSummary = {
    id: 'session',
    name: 'session',
    cwd: '/workspace/session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phase: 'idle',
    phaseSince: '2026-01-01T00:00:00.000Z',
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: true,
    awaitingInput: false,
    ...overrides,
  };
  return { summary, attach, reason: '', replayed: 0, dropped: 0 };
}

describe('sessionActivity', () => {
  it('shows the latest public assistant text while work continues', () => {
    const view = sessionActivity(meta({ phase: 'turn' }), {
      ...initialSessionState,
      streaming: true,
      entries: [
        { kind: 'assistant', id: 'thinking', text: '', thinking: 'private', streaming: false },
        { kind: 'assistant', id: 'message', text: 'I updated the panel.', thinking: '', streaming: false },
      ],
    });

    expect(view).toEqual({ status: 'working', tone: 'yellow', message: 'I updated the panel.' });
  });

  it('does not present older history or stale streaming as current activity', () => {
    const view = sessionActivity(meta(), {
      ...initialSessionState,
      hasNewerHistory: true,
      streaming: true,
      entries: [{ kind: 'assistant', id: 'old', text: 'An older reply.', thinking: '', streaming: true }],
    });

    expect(view).toEqual({
      status: 'idle',
      tone: 'green',
      message: 'Latest message unavailable while viewing older history.',
    });
  });

  it('lets connection state outrank agent phase', () => {
    expect(sessionActivity(meta({ phase: 'turn' }, 'refused'), initialSessionState)).toMatchObject({
      status: 'another cockpit holds this session',
      tone: 'red',
    });
  });
});
