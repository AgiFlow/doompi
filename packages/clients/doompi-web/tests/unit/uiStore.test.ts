import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(dock: string | null = null, tab: string | null = null, unavailable = false) {
  vi.resetModules();
  const storage = {
    getItem: vi.fn((key: string) => {
      if (unavailable) throw new Error('storage denied');
      return key === 'doompi.web.dock' ? dock : tab;
    }),
    setItem: vi.fn(() => {
      if (unavailable) throw new Error('storage denied');
    }),
  };
  vi.stubGlobal('window', { localStorage: storage });
  return { ...(await import('../../src/web/stores/uiStore.ts')), storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persistent dock preferences', () => {
  it.each([
    [null, null, true, 'activity'],
    ['closed', ' context ', false, 'context'],
    ['open', '  ', true, 'activity'],
    ['unknown', 'plugin-tab', true, 'plugin-tab'],
  ] as const)('restores dock %s and tab %s', async (dock, tab, dockOpen, dockTab) => {
    const { uiStore } = await load(dock, tab);
    expect(uiStore.state).toEqual({ dockOpen, dockTab });
  });

  it('persists changes while preserving state identity for unchanged preferences', async () => {
    const { uiStore, setDockOpen, setDockTab, storage } = await load();
    const initial = uiStore.state;
    setDockOpen(true);
    setDockTab('activity');
    expect(uiStore.state).toBe(initial);
    setDockOpen(false);
    expect(uiStore.state).toEqual({ dockOpen: false, dockTab: 'activity' });
    setDockTab('context');
    expect(uiStore.state).toEqual({ dockOpen: false, dockTab: 'context' });
    expect(storage.setItem.mock.calls).toEqual([
      ['doompi.web.dock', 'open'],
      ['doompi.web.dock-tab', 'activity'],
      ['doompi.web.dock', 'closed'],
      ['doompi.web.dock-tab', 'context'],
    ]);
  });

  it('keeps preferences usable in memory when browser storage is unavailable', async () => {
    const { uiStore, setDockOpen, setDockTab } = await load(null, null, true);
    expect(uiStore.state).toEqual({ dockOpen: true, dockTab: 'activity' });
    setDockOpen(false);
    setDockTab('plugin-tab');
    expect(uiStore.state).toEqual({ dockOpen: false, dockTab: 'plugin-tab' });
  });
});
