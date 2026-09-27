import { beforeEach, describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../src/types/hub';
import {
  buildRailWorkspaces,
  LEGACY_WORKSPACE_ID,
  pendingSetupView,
  type SessionRailModelInput,
  workspaceName,
} from '../../src/web/lib/sessionRailModel';
import {
  applySessionsSnapshot,
  resetSessions,
  resolveParentId,
  sessionsStore,
} from '../../src/web/stores/sessionsStore';
import { applyWorkspacesSnapshot, resetWorkspaces, workspacesStore } from '../../src/web/stores/workspacesStore';

const NOW = Date.parse('2026-08-24T00:10:00.000Z');

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

/** The model built from the real stores, the way the rail hook builds it. */
function model(overrides: Partial<SessionRailModelInput> = {}) {
  const sessions = sessionsStore.state;
  const workspaces = workspacesStore.state;
  return buildRailWorkspaces({
    order: sessions.order,
    byId: sessions.byId,
    activeId: sessions.activeId,
    workspaceOrder: workspaces.order,
    workspacesById: workspaces.byId,
    nested: new Set(sessions.order.filter((id) => resolveParentId(sessions.byId, id) !== undefined)),
    now: NOW,
    restarts: {},
    avatarUrls: {},
    ...overrides,
  });
}

function session(id: string, overrides: Partial<SessionRailModelInput> = {}) {
  const found = model(overrides)
    .flatMap((workspace) => workspace.sessions)
    .find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(() => {
  resetSessions();
  resetWorkspaces();
});

describe('rail workspaces', () => {
  it('keeps admitted workspaces without sessions and names them by chosen name or folder', () => {
    applyWorkspacesSnapshot({
      type: 'workspaces_snapshot',
      workspaces: [
        { id: 'one', root: '/Users/dev/workspace/one/', available: true },
        { id: 'notes', root: '/Users/dev/.pi/.doom/workspace/notes', name: 'My notes', available: false },
      ],
    });
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [summary('a', '2026-08-24T00:00:10.000Z', { workspaceId: 'one' })],
    });

    expect(
      model().map(({ id, name, available, sessions }) => ({ id, name, available, count: sessions.length })),
    ).toEqual([
      { id: 'one', name: 'one', available: true, count: 1 },
      { id: 'notes', name: 'My notes', available: false, count: 0 },
    ]);
    expect(workspaceName({ root: '/' })).toBe('/');
  });

  it('keeps the global ordinal across groups and puts ungrouped sessions in a trailing legacy group', () => {
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
        summary('loose', '2026-08-24T00:00:30.000Z'),
      ],
    });

    const workspaces = model();
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['one', 'two', LEGACY_WORKSPACE_ID]);
    expect(workspaces.at(-1)).toMatchObject({ legacy: true, available: false, name: 'loose' });
    expect(session('a').ordinal).toBe(1);
    expect(session('b').ordinal).toBe(2);
    expect(session('loose').ordinal).toBe(3);
  });

  it('keeps a child whose parent is in another workspace flat in its own group', () => {
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
        summary('parent', '2026-08-24T00:00:10.000Z', { workspaceId: 'one' }),
        summary('child', '2026-08-24T00:00:30.000Z', {
          workspaceId: 'two',
          parentSessionId: 'parent',
          sessionProvenance: 'worktree',
        }),
      ],
    });

    expect(model()[1]!.sessions.map((entry) => entry.id)).toEqual(['child']);
    expect(session('child')).toMatchObject({ nested: false });
    expect(session('child')).not.toHaveProperty('provenance');
  });
});

describe('rail session cards', () => {
  it('nests a child right after its parent with the next ordinal and its provenance', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('parent', '2026-08-24T00:00:10.000Z'),
        summary('orphan', '2026-08-24T00:00:15.000Z', { parentSessionId: 'gone', sessionProvenance: 'worktree' }),
        summary('child', '2026-08-24T00:00:20.000Z', { parentSessionId: 'parent', sessionProvenance: 'worktree' }),
      ],
    });

    const ids = model()[0]!.sessions.map((entry) => entry.id);
    expect(ids.indexOf('child')).toBe(ids.indexOf('parent') + 1);
    expect(session('child')).toMatchObject({
      nested: true,
      provenance: 'worktree',
      ordinal: session('parent').ordinal + 1,
    });
    expect(session('parent').nested).toBe(false);
    expect(session('orphan')).toMatchObject({ nested: false });
    expect(session('orphan')).not.toHaveProperty('provenance');
  });

  it('carries the branch and profile, with initials and the loaded avatar', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('a', '2026-08-24T00:00:10.000Z', {
          git: { branch: 'main', dirty: true },
          profile: { name: 'ponytail', displayName: 'Pony Tail', iconVersion: 'abc' },
        }),
        summary('b', '2026-08-24T00:00:20.000Z', { profile: { name: 'reviewer' } }),
        summary('c', '2026-08-24T00:00:30.000Z'),
      ],
    });

    expect(session('a', { avatarUrls: { a: 'blob:avatar' } })).toMatchObject({
      git: { branch: 'main', dirty: true },
      profile: { name: 'ponytail', label: 'Pony Tail', initials: 'PT', avatarUrl: 'blob:avatar' },
    });
    expect(session('b').profile).toEqual({ name: 'reviewer', label: 'reviewer', initials: 'RE' });
    expect(session('c')).not.toHaveProperty('git');
    expect(session('c')).not.toHaveProperty('profile');
  });

  it('says a dormant card is stopped, a restarting one is restarting, and keeps a restart error', () => {
    applySessionsSnapshot({
      type: 'sessions_snapshot',
      sessions: [
        summary('live', '2026-08-24T00:00:10.000Z', { awaitingInput: true }),
        summary('asleep', '2026-08-24T00:00:20.000Z', { dormant: true }),
      ],
    });

    expect(session('asleep').status).toContain('stopped');
    expect(session('live')).toMatchObject({ status: 'waiting for your input', awaitingInput: true });
    const restarting = session('live', { restarts: { live: { restarting: true } } });
    expect(restarting).toMatchObject({ status: 'restarting…', awaitingInput: false, restarting: true });
    expect(session('live', { restarts: { live: { restarting: false, error: 'no hub' } } }).error).toBe('no hub');
  });
});

describe('pending setups', () => {
  it('describes provisioning, failure, and interruption with recovery copy only when needed', () => {
    expect(pendingSetupView({ id: 's', name: 'docs', createdAt: 'now', setupKind: 'managed-worktree' })).toEqual({
      id: 's',
      name: 'docs',
      status: 'automatic worktree provisioning',
      failed: false,
    });
    expect(
      pendingSetupView({ id: 's', name: 'docs', createdAt: 'now', setupKind: 'managed-worktree', status: 'failed' }),
    ).toMatchObject({
      status: 'automatic worktree setup failed',
      failed: true,
      recovery: expect.stringContaining('Git'),
    });
    expect(
      pendingSetupView({
        id: 's',
        name: 'docs',
        createdAt: 'now',
        setupKind: 'existing-directory',
        status: 'interrupted',
      }),
    ).toMatchObject({
      status: 'conversation directory setup interrupted',
      failed: false,
      recovery: expect.stringContaining('Retry'),
    });
  });
});
