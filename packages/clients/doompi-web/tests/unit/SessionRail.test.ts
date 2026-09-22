import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The rail links and navigates; neither belongs to what nesting renders, so
// the router is stood in for rather than mounted.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children?: unknown }) =>
    createElement('a', { ...(rest as Record<string, unknown>), href: '#' }, children as never),
  useNavigate: () => () => undefined,
}));
vi.mock('../../src/web/components/PluginSurface', () => ({
  PluginSurface: () => null,
}));

import type { SessionSummary } from '../../src/types/hub';
import { SessionRail } from '../../src/web/features/sessions/SessionRail';
import { MultipleWorkspaces } from '../../src/web/features/sessions/SessionRail.stories';
import { applySessionsSnapshot, resetSessions } from '../../src/web/stores/sessionsStore';
import { applyWorkspacesSnapshot, resetWorkspaces } from '../../src/web/stores/workspacesStore';

function summary(id: string, createdAt: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    cwd: `/Users/dev/workspace/${id}`,
    createdAt,
    updatedAt: createdAt,
    phase: 'idle',
    phaseSince: createdAt,
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: false,
    awaitingInput: false,
    ...overrides,
  };
}

/** The markup of one card, so an assertion cannot pass on a sibling's output. */
function card(markup: string, id: string): string {
  const start = markup.indexOf(`data-testid="session-card-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const open = markup.lastIndexOf('<div', start);
  const next = markup.indexOf('data-testid="session-card-', start + 1);
  // The last card ends where the rail's spacer begins, so no footer markup
  // can satisfy an assertion about a card.
  const tail = markup.indexOf('<div class="flex-1">', start);
  const end = next === -1 ? (tail === -1 ? markup.length : tail) : markup.lastIndexOf('<div', next);
  const slice = markup.slice(open, end);
  expect(slice).toContain(`data-testid="session-card-${id}"`);
  return slice;
}

function render(): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SessionRail)));
}

beforeEach(() => {
  resetSessions();
  resetWorkspaces();
});

it('renders the multiple-workspace story without application providers', () => {
  const markup = renderToStaticMarkup(MultipleWorkspaces.render());

  expect(markup).toContain('workspace session rail');
});

describe('SessionRail workspaces', () => {
  it('renders admitted workspaces independently of their sessions', () => {
    applyWorkspacesSnapshot({
      type: 'workspaces_snapshot',
      workspaces: [
        { id: 'one', root: '/Users/dev/workspace/one', available: true },
        { id: 'empty', root: '/Users/dev/workspace/empty', available: true },
      ],
    });
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [summary('a', '2026-08-24T00:00:10.000Z', { workspaceId: 'one' })],
    });

    const markup = render();
    expect(markup).toContain('data-testid="workspace-group-one"');
    expect(markup).toContain('data-testid="workspace-group-empty"');
    expect(markup).toContain('no sessions · create or resume one');
    expect(markup.indexOf('workspace-group-one')).toBeLessThan(markup.indexOf('session-card-a'));
  });

  it('keeps the global session ordinal when sessions are grouped', () => {
    applyWorkspacesSnapshot({
      type: 'workspaces_snapshot',
      workspaces: [
        { id: 'one', root: '/one', available: true },
        { id: 'two', root: '/two', available: true },
      ],
    });
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('a', '2026-08-24T00:00:10.000Z', { workspaceId: 'one' }),
        summary('b', '2026-08-24T00:00:20.000Z', { workspaceId: 'two' }),
      ],
    });

    const markup = render();
    expect(card(markup, 'a')).toContain('press 1 to focus');
    expect(card(markup, 'b')).toContain('press 2 to focus');
  });
});

describe('SessionRail nesting', () => {
  beforeEach(() => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('parent', '2026-08-24T00:00:10.000Z'),
        summary('child', '2026-08-24T00:00:20.000Z', {
          parentSessionId: 'parent',
          sessionProvenance: 'worktree',
          cwd: '/Users/dev/.doompi/worktrees/child',
        }),
      ],
    });
  });

  it('indents the child card and marks it nested, leaving its parent alone', () => {
    const markup = render();
    expect(card(markup, 'child')).toContain('data-nested="true"');
    expect(card(markup, 'child')).toMatch(/class="[^"]*pl-3/u);
    expect(card(markup, 'parent')).toContain('data-nested="false"');
    expect(card(markup, 'parent')).not.toMatch(/class="[^"]*pl-3/u);
  });

  it('gives the child a fork glyph labelled with its provenance, and the parent none', () => {
    const markup = render();
    expect(card(markup, 'child')).toContain('aria-label="automatic per-conversation worktree"');
    expect(card(markup, 'parent')).not.toContain('aria-label="worktree"');
  });

  it('drops the generated worktree path from the child while the parent still shows its cwd', () => {
    const markup = render();
    expect(card(markup, 'parent')).toContain('~/workspace/parent');
    expect(card(markup, 'child')).not.toContain('~/.doompi/worktrees/child');
    expect(card(markup, 'child')).not.toContain('worktrees/child');
  });

  it('renders the child directly after its parent, holding the next ordinal', () => {
    const markup = render();
    expect(markup.indexOf('session-card-child')).toBeGreaterThan(markup.indexOf('session-card-parent'));
    expect(card(markup, 'parent')).toContain('press 1 to focus');
    expect(card(markup, 'child')).toContain('press 2 to focus');
  });
});

describe('SessionRail without lineage', () => {
  it('nests nothing and keeps every cwd', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [summary('a', '2026-08-24T00:00:10.000Z'), summary('b', '2026-08-24T00:00:20.000Z')],
    });
    const markup = render();
    expect(markup).not.toContain('data-nested="true"');
    expect(card(markup, 'a')).toContain('~/workspace/a');
    expect(card(markup, 'b')).toContain('~/workspace/b');
  });

  it('keeps a session whose parent is unknown flat, with its cwd and no glyph', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('a', '2026-08-24T00:00:10.000Z'),
        summary('orphan', '2026-08-24T00:00:20.000Z', { parentSessionId: 'gone', sessionProvenance: 'worktree' }),
      ],
    });
    const markup = render();
    expect(card(markup, 'orphan')).toContain('data-nested="false"');
    expect(card(markup, 'orphan')).toContain('~/workspace/orphan');
    expect(card(markup, 'orphan')).not.toContain('aria-label="worktree"');
  });
});

describe('SessionRail with a dormant session', () => {
  it('says the card is stopped rather than claiming it is a fresh session', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('live', '2026-08-24T00:00:10.000Z'),
        summary('asleep', '2026-08-24T00:00:20.000Z', { dormant: true }),
      ],
    });
    const markup = render();
    // Both are unprompted and idle, so only the dormant flag can tell them
    // apart: without it the card would invite a prompt nothing would receive.
    expect(card(markup, 'asleep')).toContain('stopped');
    expect(card(markup, 'live')).toContain('fresh session');
  });
});
