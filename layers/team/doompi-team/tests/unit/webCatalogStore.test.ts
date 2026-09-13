import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { catalog, loadCatalog, openCatalog } from '../../src/web/stores/catalogStore';

afterEach(() => {
  vi.restoreAllMocks();
  catalog.reset();
});

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
    } = await import('../../src/web/stores/catalogStore');
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
    const { catalog, openAgentCatalogForContext } = await import('../../src/web/stores/catalogStore');
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

describe('catalog HTTP loading', () => {
  const payload = (name = 'reviewer') => ({
    cwd: '/workspace',
    models: ['model/first'],
    agents: [
      {
        name,
        source: 'plugin',
        description: 'reviews',
        filePath: '/agents/reviewer.md',
        tools: [],
        skills: [],
        extensions: [],
        fallbackModels: [],
        defaultContext: 'fresh',
      },
    ],
  });

  it('loads directly from the encoded session API and refreshes on reopening', async () => {
    const fetch = vi
      .spyOn(sealedTransport, 'fetch')
      .mockResolvedValueOnce(Response.json(payload()))
      .mockResolvedValueOnce(Response.json(payload('updated')));
    openCatalog('session/a', 'my task');
    const cancel = loadCatalog('session/a');
    expect(catalog.store.state['session/a']?.loading).toBe(true);
    await vi.waitFor(() => expect(catalog.store.state['session/a']?.loading).toBe(false));
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fa/plugin/team/catalog', {
      signal: expect.any(AbortSignal),
      cache: 'no-store',
    });
    expect(catalog.store.state['session/a']).toMatchObject({
      agents: [{ name: 'reviewer' }],
      task: 'my task',
      warning: undefined,
    });
    cancel();
    const cancelNext = loadCatalog('session/a');
    await vi.waitFor(() => expect(catalog.store.state['session/a']?.agents[0]?.name).toBe('updated'));
    cancelNext();
  });

  it('distinguishes an empty catalog from server and malformed-response errors', async () => {
    const fetch = vi
      .spyOn(sealedTransport, 'fetch')
      .mockResolvedValueOnce(Response.json({ cwd: '/workspace', agents: [], models: [] }));
    const cancel = loadCatalog('empty');
    await vi.waitFor(() => expect(catalog.store.state.empty?.loading).toBe(false));
    expect(catalog.store.state.empty).toMatchObject({ agents: [], warning: undefined });
    cancel();
    fetch.mockResolvedValueOnce(Response.json({ error: 'Discovery unavailable' }, { status: 500 }));
    const cancelFailure = loadCatalog('empty');
    await vi.waitFor(() => expect(catalog.store.state.empty?.warning).toBe('Discovery unavailable'));
    cancelFailure();
    fetch.mockResolvedValueOnce(Response.json({ cwd: '/workspace', agents: [{}], models: [] }));
    const cancelInvalid = loadCatalog('empty');
    await vi.waitFor(() =>
      expect(catalog.store.state.empty?.warning).toBe('The server returned an invalid agent catalog.'),
    );
    cancelInvalid();
  });

  it('cancels closed drawers and ignores responses after switching or dropping sessions', async () => {
    let complete!: (value: Response) => void;
    const fetch = vi
      .spyOn(sealedTransport, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(payload('second')));
    const cancel = loadCatalog('first');
    cancel();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    catalog.reset();
    const cancelNext = loadCatalog('second');
    complete(Response.json(payload('late')));
    await vi.waitFor(() => expect(catalog.store.state.second?.loading).toBe(false));
    expect(catalog.store.state.first).toBeUndefined();
    expect(catalog.store.state.second?.agents[0]?.name).toBe('second');
    cancelNext();
  });

  it('does not let an older request overwrite a newer catalog', async () => {
    let complete!: (value: Response) => void;
    vi.spyOn(sealedTransport, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(payload('new')));
    const cancelOld = loadCatalog('same');
    const cancelNew = loadCatalog('same');
    await vi.waitFor(() => expect(catalog.store.state.same?.loading).toBe(false));
    complete(Response.json(payload('old')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(catalog.store.state.same?.agents[0]?.name).toBe('new');
    cancelOld();
    cancelNew();
  });
});
