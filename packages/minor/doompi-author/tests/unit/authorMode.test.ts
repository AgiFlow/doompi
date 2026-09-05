import type {
  MinorModeCatalogService,
  MinorModeOwnerDefinition,
  MinorModeOwnerHandle,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAuthorMode } from '../../src/services/authorMode.ts';
import type { AuthorCatalog } from '../../src/services/authorCatalog.ts';

function fixture() {
  let definition: MinorModeOwnerDefinition<ExtensionContext> | undefined;
  let cleanup: (() => void) | undefined;
  let activeTools = ['read', 'open_authoring_file', 'describe_author_tools', 'use_author_tools'];
  let viewportFocused = false;
  let sessionStart: (() => void) | undefined;
  const handle: MinorModeOwnerHandle = {
    getState: () => definition!.initialState,
    publish: vi.fn(),
    dispose: vi.fn(),
  };
  const modeCatalog = {
    registerOwner(next: MinorModeOwnerDefinition<ExtensionContext>) {
      definition = next;
      return handle;
    },
  } as MinorModeCatalogService;
  const cordis = {
    inject(_services: readonly string[], callback: (context: Context) => (() => void) | void) {
      callback({ get: () => modeCatalog } as unknown as Context);
    },
    effect(factory: () => () => void) {
      cleanup = factory();
    },
  } as unknown as Context;
  const getActiveTools = vi.fn(() => activeTools);
  const pi = {
    getActiveTools,
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'session_start') sessionStart = listener;
    }),
  } as unknown as ExtensionAPI;
  const facade = { dispose: vi.fn() };
  const registerFacades = vi.fn(() => facade);
  const catalog: AuthorCatalog = {
    open: vi.fn(),
    describe: vi.fn(async () => {
      if (!viewportFocused) throw new Error('No Author viewport is registered.');
      return {
        catalogToken: 'catalog',
        tools: [{ name: 'replace', label: 'Replace', description: '', inputSchema: {} }],
      };
    }),
    execute: vi.fn(),
  };

  const controller = installAuthorMode(cordis, pi, catalog, registerFacades, {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  return {
    controller,
    definition: () => definition!,
    activeTools: () => activeTools,
    handle,
    facade,
    catalog,
    getActiveTools,
    startSession: () => sessionStart?.(),
    focus: (focused: boolean) => {
      viewportFocused = focused;
    },
    cleanup: () => cleanup?.(),
  };
}

async function tickMonitor(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

afterEach(() => vi.useRealTimers());

describe('Author minor mode', () => {
  it('exposes no Author tools while off and only the open tool before a viewport is focused', async () => {
    vi.useFakeTimers();
    const value = fixture();
    const definition = value.definition();

    expect(definition.descriptor).toMatchObject({ id: 'author', label: 'Author' });
    expect(definition.initialState).toMatchObject({ activation: 'inactive', condition: 'ready' });
    expect(value.getActiveTools).not.toHaveBeenCalled();
    value.startSession();
    expect(value.activeTools()).toEqual(['read']);

    await definition.handleAction(
      'activate',
      {},
      {
        context: {} as ExtensionContext,
        operationId: 'activate-author',
        sessionKind: 'tui',
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(value.activeTools()).toEqual(['read', 'open_authoring_file']);
    expect(value.handle.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'active' }));

    value.cleanup();
    expect(value.activeTools()).toEqual(['read']);
    expect(value.facade.dispose).toHaveBeenCalledOnce();
  });

  it('adds facades for an accepted focused catalog, then removes them on blur and deactivation', async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.startSession();
    value.controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    value.focus(true);
    await tickMonitor();

    expect(value.activeTools()).toEqual(['read', 'open_authoring_file', 'describe_author_tools', 'use_author_tools']);
    expect(value.controller.snapshot()).toMatchObject({ catalogToken: 'catalog', capabilityCount: 1 });

    value.focus(false);
    await tickMonitor();
    expect(value.activeTools()).toEqual(['read', 'open_authoring_file']);

    value.controller.deactivate();
    expect(value.activeTools()).toEqual(['read']);
    expect(value.handle.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));
    value.cleanup();
  });

  it('aborts the active catalog poll and does not schedule more work after disposal', async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.startSession();
    vi.mocked(value.catalog.describe).mockImplementationOnce(() => new Promise(() => undefined));
    value.controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    const signal = vi.mocked(value.catalog.describe).mock.calls[0]![0];

    value.cleanup();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(signal?.aborted).toBe(true);
    expect(value.catalog.describe).toHaveBeenCalledOnce();
    expect(value.activeTools()).toEqual(['read']);
  });
});
