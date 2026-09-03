import type { WebPluginDefinition, WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWebComposition } from '../../src/types/hub.ts';

const mocks = vi.hoisted(() => ({
  activateVerifiedPluginComposition: vi.fn(),
  activateWebPluginSession: vi.fn(),
  installSessionWebPlugins: vi.fn(),
  installedWebPlugins: vi.fn(),
  removeSessionWebPlugins: vi.fn(),
  startPluginDefinitions: vi.fn(),
  startWebPlugins: vi.fn(),
  webPluginDiagnostics: vi.fn(() => []),
}));

vi.mock('../../src/pwa/workerClient.ts', () => ({
  activateVerifiedPluginComposition: mocks.activateVerifiedPluginComposition,
}));
vi.mock('../../src/web/lib/pluginRegistry.ts', () => ({
  activateWebPluginSession: mocks.activateWebPluginSession,
  installSessionWebPlugins: mocks.installSessionWebPlugins,
  installedWebPlugins: mocks.installedWebPlugins,
  removeSessionWebPlugins: mocks.removeSessionWebPlugins,
  startPluginDefinitions: mocks.startPluginDefinitions,
  startWebPlugins: mocks.startWebPlugins,
  webPluginDiagnostics: mocks.webPluginDiagnostics,
}));

import {
  focusSessionWebPlugins,
  removeSessionWebPluginRuntime,
  startSessionWebPluginRuntime,
} from '../../src/web/lib/pluginRuntime.ts';

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

describe('the focused session plugin runtime', () => {
  it('uses the captured builtin composition when a session has no synchronized plugins', async () => {
    const builtin = [{} as WebPluginDefinition];
    mocks.installedWebPlugins.mockReturnValue(builtin);
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    await focusSessionWebPlugins('session-one', undefined);

    expect(mocks.activateVerifiedPluginComposition).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('session-one', builtin);
    expect(mocks.startPluginDefinitions).toHaveBeenCalledWith(builtin, expect.anything());
    stop();
  });

  it('loads verified styles before enabling and starting a synchronized composition', async () => {
    const dynamic = [{} as WebPluginDefinition];
    scriptPlugins = dynamic;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    await focusSessionWebPlugins('session-two', composition('a', 2, ['/assets/composition.css']));

    const style = appended.find((element) => element.tag === 'link');
    expect(style).toEqual(expect.objectContaining({ media: 'all', removed: false }));
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('session-two', dynamic);
    expect(mocks.startPluginDefinitions).toHaveBeenCalledWith(dynamic, expect.anything());
    stop();
  });

  it('keeps the running composition when its same-session replacement is refused', async () => {
    const firstPlugins = [{} as WebPluginDefinition];
    scriptPlugins = firstPlugins;
    const stopActive = vi.fn();
    mocks.startPluginDefinitions.mockReturnValue(stopActive);
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);
    await focusSessionWebPlugins('session-three', composition('b', 1));
    mocks.installSessionWebPlugins.mockClear();
    mocks.startPluginDefinitions.mockClear();
    mocks.activateVerifiedPluginComposition.mockResolvedValueOnce({
      ok: false,
      code: 'manifest-fetch',
      message: 'offline',
    });

    await focusSessionWebPlugins('session-three', composition('c', 2));

    expect(stopActive).not.toHaveBeenCalled();
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    stop();
  });

  it('fails closed and removes prepared styles when a first composition style fails', async () => {
    scriptPlugins = [{} as WebPluginDefinition];
    styleFailure = true;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    await focusSessionWebPlugins('session-four', composition('d', 1, ['/assets/broken.css']));

    expect(appended.find((element) => element.tag === 'link')?.removed).toBe(true);
    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('session-four', []);
    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    stop();
  });

  it('fails closed when a verified script exports no plugin composition', async () => {
    scriptPlugins = undefined;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    await focusSessionWebPlugins('session-five', composition('e', 1));

    expect(mocks.installSessionWebPlugins).toHaveBeenCalledWith('session-five', []);
    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    stop();
  });

  it('atomically replaces an active composition and ignores its repeated key', async () => {
    const firstPlugins = [{} as WebPluginDefinition];
    const secondPlugins = [{ id: 'replacement' } as WebPluginDefinition];
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    mocks.startPluginDefinitions.mockReturnValueOnce(firstStop).mockReturnValueOnce(secondStop);
    scriptPlugins = firstPlugins;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);
    await focusSessionWebPlugins('session-six', composition('f', 1));
    scriptPlugins = secondPlugins;

    const replacement = composition('g', 2, ['/assets/replacement.css']);
    await focusSessionWebPlugins('session-six', replacement);
    await focusSessionWebPlugins('session-six', replacement);

    expect(firstStop).toHaveBeenCalledOnce();
    expect(mocks.removeSessionWebPlugins).toHaveBeenCalledWith('session-six');
    expect(mocks.installSessionWebPlugins).toHaveBeenLastCalledWith('session-six', secondPlugins);
    expect(mocks.activateVerifiedPluginComposition).toHaveBeenCalledTimes(2);

    removeSessionWebPluginRuntime('session-six');
    expect(secondStop).toHaveBeenCalledOnce();
    stop();
  });

  it('reuses a verified cached composition when focus returns to its session', async () => {
    const cachedPlugins = [{ id: 'cached' } as WebPluginDefinition];
    scriptPlugins = cachedPlugins;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);
    const cachedComposition = composition('i', 3);
    await focusSessionWebPlugins('session-eight', cachedComposition);
    await focusSessionWebPlugins('other-session', undefined);
    const scriptCount = appended.filter((element) => element.tag === 'script').length;
    mocks.installSessionWebPlugins.mockClear();

    await focusSessionWebPlugins('session-eight', cachedComposition);

    expect(appended.filter((element) => element.tag === 'script')).toHaveLength(scriptCount);
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalledWith('session-eight', expect.anything());
    expect(mocks.startPluginDefinitions).toHaveBeenLastCalledWith(cachedPlugins, expect.anything());
    stop();
  });

  it('cancels stale composition work after script and style loading', async () => {
    scriptPlugins = [{ id: 'stale-script' } as WebPluginDefinition];
    automaticScriptLoad = false;
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);
    const pendingScript = focusSessionWebPlugins('session-nine', composition('j', 1));
    await vi.waitFor(() => expect(appended.some((element) => element.tag === 'script')).toBe(true));
    await focusSessionWebPlugins('fallback-one', undefined);
    const script = appended.find((element) => element.tag === 'script');
    (globalThis as unknown as Record<string, unknown>).DoomPiWebPluginComposition = scriptPlugins;
    script?.dispatch('load');
    await pendingScript;
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalledWith('session-nine', expect.anything());

    appended = [];
    automaticScriptLoad = true;
    automaticStyleLoad = false;
    scriptPlugins = [{ id: 'stale-style' } as WebPluginDefinition];
    const pendingStyle = focusSessionWebPlugins('session-ten', composition('k', 1, ['/assets/stale.css']));
    await vi.waitFor(() => expect(appended.some((element) => element.tag === 'link')).toBe(true));
    await focusSessionWebPlugins('fallback-two', undefined);
    const style = appended.find((element) => element.tag === 'link');
    style?.dispatch('load');
    await pendingStyle;

    expect(style?.removed).toBe(true);
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalledWith('session-ten', expect.anything());
    stop();
  });

  it('reports non-Error verification failures as Error instances', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.activateVerifiedPluginComposition.mockRejectedValueOnce('offline');
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    await focusSessionWebPlugins('session-eleven', composition('l', 1));

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
    stop();
  });

  it('ignores a verification rejection after its session is removed', async () => {
    let rejectVerification: ((reason: Error) => void) | undefined;
    mocks.activateVerifiedPluginComposition.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectVerification = reject;
        }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);
    const pending = focusSessionWebPlugins('session-twelve', composition('m', 1));
    await vi.waitFor(() => expect(rejectVerification).toBeTypeOf('function'));
    removeSessionWebPluginRuntime('session-twelve');
    rejectVerification?.(new Error('obsolete'));
    await pending;

    expect(error).not.toHaveBeenCalled();
    stop();
  });

  it('cancels a pending composition when its session is removed', async () => {
    let resolveVerification: ((result: { ok: true; revision: number }) => void) | undefined;
    mocks.activateVerifiedPluginComposition.mockImplementationOnce(
      async () =>
        await new Promise<{ ok: true; revision: number }>((resolve) => {
          resolveVerification = resolve;
        }),
    );
    scriptPlugins = [{} as WebPluginDefinition];
    const stop = startSessionWebPluginRuntime({} as WebPluginRuntime);

    const pending = focusSessionWebPlugins('session-seven', composition('h', 1));
    await vi.waitFor(() => expect(resolveVerification).toBeTypeOf('function'));
    removeSessionWebPluginRuntime('session-seven');
    resolveVerification?.({ ok: true, revision: 1 });
    await pending;

    expect(appended.filter((element) => element.tag === 'script')).toHaveLength(0);
    expect(mocks.installSessionWebPlugins).not.toHaveBeenCalled();
    expect(mocks.removeSessionWebPlugins).toHaveBeenCalledWith('session-seven');

    mocks.removeSessionWebPlugins.mockClear();
    removeSessionWebPluginRuntime('unknown-session');
    expect(mocks.removeSessionWebPlugins).toHaveBeenCalledWith('unknown-session');
    stop();
  });

  it('does not activate plugins without a focused session or host runtime', async () => {
    await focusSessionWebPlugins(null, undefined);
    await focusSessionWebPlugins('session-without-runtime', undefined);

    expect(mocks.startPluginDefinitions).not.toHaveBeenCalled();
    expect(mocks.activateWebPluginSession).toHaveBeenCalledWith(null);
    expect(mocks.activateWebPluginSession).toHaveBeenCalledWith('session-without-runtime');
    removeSessionWebPluginRuntime('session-without-runtime');
  });
});
