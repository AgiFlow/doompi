import type { WebPluginDefinition, WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionWebComposition } from '../../src/types/hub';

const mocks = vi.hoisted(() => ({
  activateVerifiedBundle: vi.fn(),
  activateVerifiedPluginComposition: vi.fn(),
  activateWebPluginSession: vi.fn(),
  installSessionWebPlugins: vi.fn(),
  installedWebPlugins: vi.fn(),
  activateWebPluginWorkspace: vi.fn(),
  bindSessionWebWorkspace: vi.fn(),
  installGlobalWebPlugins: vi.fn(),
  installWorkspaceWebPlugins: vi.fn(),
  removeWorkspaceWebPlugins: vi.fn(),
  fetch: vi.fn(),
  removeSessionWebPlugins: vi.fn(),
  startPluginDefinitions: vi.fn(),
  startWebPlugins: vi.fn(),
  webPluginDiagnostics: vi.fn(() => []),
}));

vi.mock('../../src/pwa/workerClient', () => ({
  activateVerifiedBundle: mocks.activateVerifiedBundle,
  activateVerifiedPluginComposition: mocks.activateVerifiedPluginComposition,
}));
vi.mock('../../src/web/lib/pluginRegistry', () => mocks);
vi.mock('../../src/web/lib/sealedSession', () => ({ sealedHttpSession: { fetch: mocks.fetch } }));

import {
  refreshWebPluginCompositions,
  retryWebPluginCompositions,
  focusSessionWebPlugins,
  removeSessionWebPluginRuntime,
  startSessionWebPluginRuntime,
  webPluginCompositionStore,
  webPluginMountState,
} from '../../src/web/lib/pluginRuntime';

interface FakeElement {
  dataset: Record<string, string>;
  href: string;
  media: string;
  rel: string;
  removed: boolean;
  src: string;
  tag: string;
  addEventListener(type: string, listener: () => void): void;
  dispatch(type: string): void;
  remove(): void;
}

let appended: FakeElement[];
let automaticScriptLoad: boolean;
let automaticStyleLoad: boolean;
let scriptPlugins: readonly WebPluginDefinition[] | undefined;
let styleFailure: boolean;

function fakeElement(tag: string): FakeElement {
  const listeners = new Map<string, Array<() => void>>();
  return {
    dataset: {},
    href: '',
    media: '',
    rel: '',
    removed: false,
    src: '',
    tag,
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener();
      listeners.delete(type);
    },
    remove() {
      this.removed = true;
    },
  };
}

function composition(id: string, revision: number, stylePaths: string[] = []): SessionWebComposition {
  return {
    id: id.repeat(64),
    revision,
    manifestUrl: `/api/web-plugins/${id.repeat(64)}/${String(revision)}/manifest`,
    rawAssetBaseUrl: `/api/web-plugins/${id.repeat(64)}/${String(revision)}/assets`,
    verifiedAssetBaseUrl: `/verified-plugins/${id.repeat(64)}/${String(revision)}`,
    entryPath: '/composition.js',
    stylePaths,
    channels: [],
  };
}

beforeEach(() => {
  appended = [];
  automaticScriptLoad = true;
  automaticStyleLoad = true;
  scriptPlugins = [];
  styleFailure = false;
  vi.clearAllMocks();
  mocks.activateVerifiedBundle.mockResolvedValue({ ok: true, revision: 1 });
  mocks.activateVerifiedPluginComposition.mockResolvedValue({ ok: true, revision: 1 });
  mocks.installedWebPlugins.mockReturnValue([]);
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      global: composition('f', 1),
      workspaces: [
        { id: 'workspace-one', webComposition: composition('e', 1) },
        { id: 'workspace-two', webComposition: composition('d', 1) },
      ],
    }),
  );
  mocks.startPluginDefinitions.mockReturnValue(vi.fn());
  mocks.startWebPlugins.mockReturnValue(vi.fn());
  vi.stubGlobal('document', {
    createElement: (tag: string) => fakeElement(tag),
    head: {
      append: (element: FakeElement) => {
        appended.push(element);
        queueMicrotask(() => {
          if (element.tag === 'script') {
            if (!automaticScriptLoad) return;
            if (scriptPlugins !== undefined) {
              (globalThis as unknown as Record<string, unknown>).DoomPiWebPluginComposition = scriptPlugins;
            }
            element.dispatch('load');
          } else if (automaticStyleLoad) {
            element.dispatch(styleFailure ? 'error' : 'load');
          }
        });
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
async function start() {
  const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
  stops.push(stop);
  await refreshWebPluginCompositions();
  vi.clearAllMocks();
}

describe('composition bootstrap recovery', () => {
  it('reports a failed bootstrap and retries the remote composition', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('tunnel closed'));
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);

    await vi.waitFor(() => expect(webPluginCompositionStore.state.phase).toBe('error'));
    expect(webPluginCompositionStore.state.error).toBe('tunnel closed');
    expect(webPluginMountState({ scope: 'global' })).toEqual({ phase: 'error', error: 'tunnel closed' });
    expect(webPluginMountState({ scope: 'workspace', workspaceId: 'workspace-one' })).toEqual({
      phase: 'error',
      error: 'tunnel closed',
    });

    await retryWebPluginCompositions();

    expect(webPluginCompositionStore.state.phase).toBe('ready');
    expect(webPluginMountState({ scope: 'global' })).toEqual({ phase: 'ready' });
    expect(mocks.installGlobalWebPlugins).toHaveBeenCalled();
  });

  it('recovers a failed bootstrap when the hub reconnects', async () => {
    let reconnect!: () => void;
    mocks.fetch.mockRejectedValueOnce(new Error('bridge unavailable'));
    const stop = startSessionWebPluginRuntime({
      onHubConnected: (listener: () => void) => {
        reconnect = listener;
        return () => undefined;
      },
    } as unknown as WebPluginRuntime);
    stops.push(stop);

    await vi.waitFor(() => expect(webPluginCompositionStore.state.phase).toBe('error'));
    reconnect();
    await vi.waitFor(() => expect(webPluginCompositionStore.state.phase).toBe('ready'));

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('restores the requested session composition after a mount failure', async () => {
    await start();
    scriptPlugins = [{ id: 'fixture', session: {} }];
    mocks.activateVerifiedPluginComposition.mockRejectedValueOnce(new Error('asset unavailable'));

    await expect(focusSessionWebPlugins('one', composition('a', 1), 'workspace-one')).rejects.toThrow(
      'asset unavailable',
    );
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'one' }).phase).toBe(
      'error',
    );

    await retryWebPluginCompositions();

    expect(webPluginCompositionStore.state.phase).toBe('ready');
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('one', expect.anything());
  });
});

describe('stopped session compositions', () => {
  it('uses the verified workspace without loading live session plugins', async () => {
    await start();
    await focusSessionWebPlugins('stopped', null, 'workspace-one');
    expect(mocks.activateVerifiedPluginComposition).not.toHaveBeenCalled();
    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    expect(mocks.bindSessionWebWorkspace).toHaveBeenCalledWith('stopped', 'workspace-one');
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('stopped', []);
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'stopped' })).toEqual({
      phase: 'ready',
    });
    await retryWebPluginCompositions();
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'stopped' })).toEqual({
      phase: 'ready',
    });
  });

  it('unmounts a stopped session and verifies its composition again on wake', async () => {
    await start();
    const stop = vi.fn();
    mocks.startPluginDefinitions.mockReturnValue(stop);
    await focusSessionWebPlugins('one', composition('a', 1, ['/style.css']), 'workspace-one');
    await focusSessionWebPlugins('one', null, 'workspace-one');
    expect(stop).toHaveBeenCalledOnce();
    expect(appended.filter((element) => element.tag === 'link').every((element) => element.removed)).toBe(true);
    const writes = vi.fn();
    const subscription = webPluginCompositionStore.subscribe(writes);
    await focusSessionWebPlugins('one', null, 'workspace-one');
    expect(writes).not.toHaveBeenCalled();
    subscription.unsubscribe();
    await focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    expect(mocks.activateVerifiedPluginComposition).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a live plugin after the session stops during verification', async () => {
    await start();
    let finish!: () => void;
    mocks.activateVerifiedPluginComposition.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve({ ok: true, revision: 1 });
      }),
    );
    const pending = focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    await vi.waitFor(() => expect(mocks.activateVerifiedPluginComposition).toHaveBeenCalledOnce());
    await focusSessionWebPlugins('one', null, 'workspace-one');
    finish();
    await pending;
    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledExactlyOnceWith('one', []);
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'one' })).toEqual({
      phase: 'ready',
    });
  });

  it('keeps missing live compositions as session errors without poisoning bootstrap state', async () => {
    await start();
    await expect(focusSessionWebPlugins('broken', undefined, 'workspace-one')).rejects.toThrow(
      'No synchronized web composition',
    );
    expect(webPluginCompositionStore.state.phase).toBe('ready');
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'broken' }).phase).toBe(
      'error',
    );
    await focusSessionWebPlugins('healthy', composition('b', 1), 'workspace-two');
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-two', sessionId: 'healthy' })).toEqual({
      phase: 'ready',
    });
  });
});

describe('three-level web plugin mounts', () => {
  it('pins the local signed shell before mounting its plugins', async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    const serviceWorker = {
      register,
      controller: null as object | null,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        queueMicrotask(() => {
          serviceWorker.controller = {};
          listener();
        });
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('navigator', { serviceWorker });
    mocks.fetch.mockImplementation(async () =>
      Response.json({
        shell: { publicKey: 'local-signing-key', revision: 7 },
        global: composition('f', 1),
        workspaces: [],
      }),
    );
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);

    await refreshWebPluginCompositions();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(mocks.activateVerifiedBundle).toHaveBeenCalledWith({
      publicKey: 'local-signing-key',
      minimumRevision: 7,
    });
    expect(mocks.activateVerifiedBundle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateVerifiedPluginComposition.mock.invocationCallOrder[0]!,
    );
    expect(serviceWorker.removeEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));
    expect(mocks.installGlobalWebPlugins).toHaveBeenCalled();
  });

  it('does not accept a shell signing key from a remote origin', async () => {
    vi.stubGlobal('location', { hostname: 'doompi.agimon.win' });
    mocks.fetch.mockImplementation(async () =>
      Response.json({
        shell: { publicKey: 'untrusted-response', revision: 7 },
        global: composition('f', 1),
        workspaces: [],
      }),
    );
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);

    await refreshWebPluginCompositions();

    expect(mocks.activateVerifiedBundle).not.toHaveBeenCalled();
    expect(mocks.installGlobalWebPlugins).toHaveBeenCalled();
  });

  it('refuses local plugins when the signed shell cannot be verified', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' });
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn().mockResolvedValue({}), controller: {} } });
    mocks.activateVerifiedBundle.mockResolvedValue({ ok: false, code: 'signature', message: 'Invalid signature' });
    mocks.fetch.mockImplementation(async () =>
      Response.json({
        shell: { publicKey: 'refused-signing-key', revision: 8 },
        global: composition('f', 1),
        workspaces: [],
      }),
    );
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);

    await expect(refreshWebPluginCompositions()).rejects.toThrow('Invalid signature');
    expect(mocks.activateVerifiedPluginComposition).not.toHaveBeenCalled();
    expect(webPluginMountState({ scope: 'global' })).toEqual({
      phase: 'error',
      error: expect.stringContaining('Invalid signature'),
    });
  });

  it('mounts global and both workspaces without any live session', async () => {
    scriptPlugins = [{ id: 'fixture', global: {}, workspace: {} }];
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);
    await refreshWebPluginCompositions();
    expect(mocks.installGlobalWebPlugins).toHaveBeenCalledWith(scriptPlugins);
    expect(mocks.installWorkspaceWebPlugins).toHaveBeenCalledWith('workspace-one', scriptPlugins);
    expect(mocks.installWorkspaceWebPlugins).toHaveBeenCalledWith('workspace-two', scriptPlugins);
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
  });

  it('finishes healthy workspaces and their session focus when another workspace fails', async () => {
    mocks.activateVerifiedPluginComposition.mockImplementation(async (entry: SessionWebComposition) => {
      if (entry.id === composition('e', 1).id) throw new Error('workspace-one unavailable');
      return { ok: true, revision: entry.revision };
    });
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);
    const focused = focusSessionWebPlugins('two', composition('b', 1), 'workspace-two');

    await expect(refreshWebPluginCompositions()).rejects.toThrow('workspace-one unavailable');
    await expect(focused).resolves.toBeUndefined();

    expect(webPluginMountState({ scope: 'global' })).toEqual({ phase: 'ready' });
    expect(webPluginMountState({ scope: 'workspace', workspaceId: 'workspace-one' })).toEqual({
      phase: 'error',
      error: 'workspace-one unavailable',
    });
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-two', sessionId: 'two' })).toEqual({
      phase: 'ready',
    });
    await expect(retryWebPluginCompositions()).resolves.toBeUndefined();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('two', expect.anything());
  });

  it('removes readiness for a workspace removed from the composition catalog', async () => {
    await start();
    mocks.fetch.mockResolvedValue(Response.json({ global: composition('f', 1), workspaces: [] }));
    await refreshWebPluginCompositions();
    expect(mocks.removeWorkspaceWebPlugins).toHaveBeenCalledWith('workspace-one');
    expect(webPluginMountState({ scope: 'workspace', workspaceId: 'workspace-one' })).toEqual({
      phase: 'error',
      error: expect.stringContaining('workspace-one'),
    });
  });

  it('does not install metadata returned after its runtime has stopped', async () => {
    let respond!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    const pending = refreshWebPluginCompositions();
    stop();
    await start();
    respond(Response.json({ global: composition('a', 9), workspaces: [] }));
    await pending;
    expect(mocks.activateVerifiedPluginComposition).not.toHaveBeenCalled();
    expect(webPluginMountState({ scope: 'global' })).toEqual({ phase: 'ready' });
  });
  it('publishes a mount only after its verified composition is installed', async () => {
    scriptPlugins = [{ id: 'fixture', global: {}, workspace: {}, session: {} }];
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);

    await refreshWebPluginCompositions();

    expect(webPluginMountState({ scope: 'global' })).toEqual({ phase: 'ready' });
    expect(webPluginMountState({ scope: 'workspace', workspaceId: 'workspace-one' })).toEqual({ phase: 'ready' });
    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'one' })).toEqual({
      phase: 'loading',
    });

    await focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');

    expect(webPluginMountState({ scope: 'session', workspaceId: 'workspace-one', sessionId: 'one' })).toEqual({
      phase: 'ready',
    });
  });

  it('keeps a session pending until both its script and stylesheet finish loading', async () => {
    await start();
    automaticScriptLoad = false;
    automaticStyleLoad = false;
    const mount = { scope: 'session' as const, workspaceId: 'workspace-one', sessionId: 'one' };
    const pending = focusSessionWebPlugins('one', composition('a', 1, ['/style.css']), 'workspace-one');
    await vi.waitFor(() => expect(appended.some((element) => element.src.includes('a'.repeat(64)))).toBe(true));
    expect(webPluginMountState(mount)).toEqual({ phase: 'loading' });
    const script = appended.find((element) => element.src.includes('a'.repeat(64)))!;
    (globalThis as unknown as Record<string, unknown>).DoomPiWebPluginComposition = [];
    script.dispatch('load');
    await vi.waitFor(() => expect(appended.some((element) => element.tag === 'link')).toBe(true));
    const style = appended.find((element) => element.tag === 'link')!;
    expect(style.media).toBe('not all');
    expect(webPluginMountState(mount)).toEqual({ phase: 'loading' });
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
    style.dispatch('load');
    await pending;
    expect(style.media).toBe('all');
    expect(webPluginMountState(mount)).toEqual({ phase: 'ready' });
  });
  it('does not borrow the shell composition for a missing session descriptor', async () => {
    await start();
    await expect(focusSessionWebPlugins('one', undefined, 'workspace-one')).rejects.toThrow('No synchronized');
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
  });
  it('keeps independent session runtimes mounted across focus changes', async () => {
    await start();
    const stopPlugin = vi.fn();
    mocks.startPluginDefinitions.mockReturnValue(stopPlugin);
    scriptPlugins = [{ id: 'fixture', global: { paletteCommands: [] }, session: { tabs: [] } }];
    await focusSessionWebPlugins('one', composition('a', 1, ['/style.css']), 'workspace-one');
    await focusSessionWebPlugins('two', composition('b', 1), 'workspace-two');
    await focusSessionWebPlugins('one', composition('a', 1, ['/style.css']), 'workspace-one');
    expect(stopPlugin).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(2);
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('one', [{ id: 'fixture', tabs: [] }]);
    expect(mocks.bindSessionWebWorkspace).toHaveBeenCalledWith('two', 'workspace-two');
    expect(mocks.startPluginDefinitions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mount: { scope: 'session', sessionId: 'one', workspaceId: 'workspace-one' } }),
    );
    removeSessionWebPluginRuntime('one');
    expect(stopPlugin).toHaveBeenCalledTimes(1);
    expect(appended.filter((element) => element.tag === 'link').every((element) => element.removed)).toBe(true);
  });

  it('does not rewrite mount state when the focused session is unchanged', async () => {
    await start();
    await focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    const writes = vi.fn();
    const subscription = webPluginCompositionStore.subscribe(writes);
    try {
      const first = focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
      const second = focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
      expect(second).toBe(first);
      await second;
    } finally {
      subscription.unsubscribe();
    }
    expect(writes).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.activateWebPluginSession).toHaveBeenLastCalledWith('one');
  });

  it('remounts an unchanged focus after a revision change, removal or runtime restart', async () => {
    await start();
    await focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    await focusSessionWebPlugins('one', composition('a', 2), 'workspace-one');
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(2);

    removeSessionWebPluginRuntime('one');
    await focusSessionWebPlugins('one', composition('a', 2), 'workspace-one');
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(3);

    for (const stop of stops.splice(0)) stop();
    await start();
    await focusSessionWebPlugins('one', composition('a', 2), 'workspace-one');
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(1);
  });

  it('keeps a mounted generation when replacement verification fails', async () => {
    await start();
    const stopPlugin = vi.fn();
    mocks.startPluginDefinitions.mockReturnValue(stopPlugin);
    await focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    mocks.activateVerifiedPluginComposition.mockResolvedValue({
      ok: false,
      code: 'signature',
      message: 'Invalid signature',
    });
    await expect(focusSessionWebPlugins('one', composition('b', 2), 'workspace-one')).rejects.toThrow('signature');
    expect(stopPlugin).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledTimes(1);
  });

  it('removes prepared styles and refuses a broken composition', async () => {
    await start();
    styleFailure = true;
    await expect(focusSessionWebPlugins('one', composition('a', 1, ['/style.css']), 'workspace-one')).rejects.toThrow(
      'style',
    );
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
    expect(appended.filter((element) => element.tag === 'link').every((element) => element.removed)).toBe(true);
    styleFailure = false;
    scriptPlugins = undefined;
    await expect(focusSessionWebPlugins('one', composition('b', 2), 'workspace-one')).rejects.toThrow(
      'no plugin array',
    );
  });

  it('does not resurrect a session removed during verification', async () => {
    await start();
    let resolve!: (result: { ok: true }) => void;
    mocks.activateVerifiedPluginComposition.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    await vi.waitFor(() => expect(mocks.activateVerifiedPluginComposition).toHaveBeenCalled());
    removeSessionWebPluginRuntime('one');
    resolve({ ok: true });
    await pending;
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
  });
  it('does not resurrect a session removed while workspace metadata is pending', async () => {
    let respond!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );
    const stop = startSessionWebPluginRuntime({ onHubConnected: () => () => {} } as unknown as WebPluginRuntime);
    stops.push(stop);
    const pending = focusSessionWebPlugins('one', composition('a', 1), 'workspace-one');
    removeSessionWebPluginRuntime('one');
    respond(
      Response.json({
        global: composition('f', 1),
        workspaces: [{ id: 'workspace-one', webComposition: composition('e', 1) }],
      }),
    );
    await pending;
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
  });
});
