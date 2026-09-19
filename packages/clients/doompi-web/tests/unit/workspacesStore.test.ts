import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyWorkspaceRemoved,
  applyWorkspacesSnapshot,
  applyWorkspaceUpsert,
  resetWorkspaces,
  selectWorkspace,
  workspacesStore,
} from '../../src/web/stores/workspacesStore';

beforeEach(resetWorkspaces);

describe('workspacesStore', () => {
  it('keeps empty and unavailable workspaces from snapshots', () => {
    applyWorkspacesSnapshot({
      workspaces: [
        { id: 'one', root: '/one', available: true },
        { id: 'missing', root: '/missing', available: false },
      ],
    });

    expect(workspacesStore.state.order).toEqual(['one', 'missing']);
    expect(workspacesStore.state.byId.missing).toEqual({ id: 'missing', root: '/missing', available: false });
    expect(workspacesStore.state.hydrated).toBe(true);
  });

  it('upserts, selects, and removes workspace membership independently', () => {
    applyWorkspaceUpsert({ workspace: { id: 'one', root: '/one', available: true } });
    selectWorkspace('one');
    applyWorkspaceUpsert({ workspace: { id: 'one', root: '/moved', available: false } });

    expect(workspacesStore.state.order).toEqual(['one']);
    expect(workspacesStore.state.selectedId).toBe('one');
    expect(workspacesStore.state.byId.one?.root).toBe('/moved');

    applyWorkspaceRemoved({ workspaceId: 'one' });
    expect(workspacesStore.state.order).toEqual([]);
    expect(workspacesStore.state.selectedId).toBeNull();
  });
});
