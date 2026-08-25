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
    } = await import('../../web/catalogStore.ts');
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

    openCatalog('s1');
    selectAgent('s1', 'b');
    toggleInspect('s1', 'b');
    setCatalogFilter('s1', 'x');
    expect(session('s1')).toMatchObject({ open: true, selected: 'b', inspected: 'b', filter: 'x' });
    toggleInspect('s1', 'b');
    expect(session('s1').inspected).toBeUndefined();
    toggleInspect('s1', 'b');

    openLaunch('s1', 'a', true);
    expect(session('s1')).toMatchObject({ selected: 'a', launch: { agent: 'a', fork: true } });
    closeLaunch('s1');
    expect(session('s1').launch).toBeUndefined();
    selectAgent('s1', 'a');

    // A refresh that lost the selected agent forgets it; the rest of the drawer state stays.
    subagentCatalogChannel.apply('s1', subagentCatalogChannel.parse({ cwd: '/w', agents: [{ name: 'b' }] })!);
    expect(session('s1')).toMatchObject({
      open: true,
      selected: undefined,
      inspected: 'b',
      filter: 'x',
      warning: undefined,
    });

    openLaunch('s1', 'b', false);
    closeCatalog('s1');
    expect(session('s1')).toMatchObject({ open: false, launch: undefined });
    subagentCatalogChannel.drop('s1');
    expect(catalog.store.state.s1).toBeUndefined();
    catalog.reset();
  });
});
