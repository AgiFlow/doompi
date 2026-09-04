import { describe, expect, it } from 'vitest';

describe('the catalog store', () => {
  it('folds channel payloads and keeps the drawer state across a refresh', async () => {
    const {
      catalog,
      closeCatalog,
      closeLaunch,
      openCatalog,
      openLaunch,
      selectAgent,
      setCatalogFilter,
      subagentCatalogChannel,
      toggleInspect,
    } = await import('../../src/web/catalogStore.ts');
    const session = (sessionId: string) => catalog.select(catalog.store.state, sessionId);
    catalog.reset();

    expect(subagentCatalogChannel.parse('junk')).toBeNull();
    expect(subagentCatalogChannel.parse({ cwd: '/w' })).toBeNull();
    const payload = subagentCatalogChannel.parse({
      cwd: '/w',
      agents: [{ name: 'a' }, 'junk', { name: 'b' }],
      models: ['m', 7],
      warning: 'partial',
    });
    expect(payload).toEqual({ cwd: '/w', agents: [{ name: 'a' }, { name: 'b' }], models: ['m'], warning: 'partial' });
    subagentCatalogChannel.apply('s1', payload!);
    expect(session('s1')).toMatchObject({ cwd: '/w', models: ['m'], warning: 'partial', open: false });

    openCatalog('s1', 'Fix task AGI-1');
    selectAgent('s1', 'b');
    toggleInspect('s1', 'b');
    setCatalogFilter('s1', 'x');
    expect(session('s1')).toMatchObject({
      open: true,
      task: 'Fix task AGI-1',
      selected: 'b',
      inspected: 'b',
      filter: 'x',
    });
    toggleInspect('s1', 'b');
    expect(session('s1').inspected).toBeUndefined();
    toggleInspect('s1', 'b');

    openLaunch('s1', 'a', true);
    expect(session('s1')).toMatchObject({ selected: 'a', launch: { agent: 'a', fork: true } });
    closeLaunch('s1');
    expect(session('s1').launch).toBeUndefined();
    selectAgent('s1', 'a');
    openLaunch('s1', 'a', true);

    // A refresh that lost the selected agent forgets it; the rest of the drawer state stays.
    subagentCatalogChannel.apply('s1', subagentCatalogChannel.parse({ cwd: '/w', agents: [{ name: 'b' }] })!);
    expect(session('s1')).toMatchObject({
      open: true,
      selected: undefined,
      inspected: 'b',
      filter: 'x',
      task: 'Fix task AGI-1',
      launch: undefined,
      warning: undefined,
    });

    openLaunch('s1', 'b', false);
    closeCatalog('s1');
    expect(session('s1')).toMatchObject({ open: false, task: '', launch: undefined });
    subagentCatalogChannel.drop('s1');
    expect(catalog.store.state.s1).toBeUndefined();
    catalog.reset();
  });

  it('opens the reviewed Agent launcher from an independent work-item action', async () => {
    const { catalog, openAgentCatalogForContext } = await import('../../src/web/catalogStore.ts');
    const opened: string[] = [];
    catalog.reset();

    const context = {
      item: {
        kind: 'work-item',
        source: 'agiflow',
        id: 'task-1',
        label: 'AGI-1',
        content: 'Implement task AGI-1.',
      },
      sessionId: 's1',
      openTab: () => undefined,
      openTransientTab: (tab: { id: string }) => opened.push(tab.id),
      sendSessionFrame: () => undefined,
    };
    openAgentCatalogForContext(context, () => ({ id: 'subagents-fleet', label: 'subagents', panel: () => null }));

    expect(catalog.select(catalog.store.state, 's1')).toMatchObject({ open: true, task: 'Implement task AGI-1.' });
    expect(opened).toEqual(['subagents-fleet']);
    openAgentCatalogForContext({ ...context, sessionId: null }, () => {
      throw new Error('a detached action must not build a tab');
    });
    catalog.reset();
  });
});
