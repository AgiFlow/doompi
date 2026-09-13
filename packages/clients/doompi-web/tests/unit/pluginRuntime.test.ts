import type { WebPluginDefinition, WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionWebComposition } from '../../src/types/hub';

const mocks = vi.hoisted(() => ({
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
  activateVerifiedPluginComposition: mocks.activateVerifiedPluginComposition,
}));
vi.mock('../../src/web/lib/pluginRegistry', () => mocks);
vi.mock('../../src/web/lib/sealedSession', () => ({ sealedHttpSession: { fetch: mocks.fetch } }));

import {
  refreshWebPluginCompositions,
  focusSessionWebPlugins,
  removeSessionWebPluginRuntime,
  startSessionWebPluginRuntime,
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

describe('three-level web plugin mounts', () => {
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
});
