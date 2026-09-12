import type { MinorModeOwnerDefinition, MinorModeOwnerHandle } from '@agimon-ai/doompi-minor-mode';
import { createDoomToolSurface } from '@agimon-ai/doompi-core/tool-surface';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorToolRestriction, createAuthorCatalogMonitor } from '../../src/services/authorCatalog/monitor';
import { authorMinorMode } from '../../src/models/authorMode';
import type { AuthorCatalog } from '../../src/services/authorCatalog/type';

function fixture() {
  let definition: MinorModeOwnerDefinition<ExtensionContext> | undefined;
  const allTools = ['read', 'open_authoring_file', 'describe_author_tools', 'use_author_tools'];
  let activeTools = [...allTools];
  let viewportFocused = false;
  let sessionStart: (() => void) | undefined;
  const handle: MinorModeOwnerHandle = {
    getState: () => definition!.initialState,
    publish: vi.fn(),
    dispose: vi.fn(),
  };
  const surface = createDoomToolSurface({
    generation: 'test',
    allTools: () => allTools,
    activeTools: () => activeTools,
    setActiveTools: (next) => {
      activeTools = next;
    },
  });
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

  const monitor = createAuthorCatalogMonitor(catalog, {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  let active = false;
  let disposed = false;
  const mode = authorMinorMode.createOwner({
    isActive: () => active,
    detail: () => (monitor.snapshot() ? 'document viewport focused' : 'waiting for a focused document'),
    setActive(enabled) {
      if (disposed || active === enabled) return;
      active = enabled;
      if (enabled) monitor.start();
      else monitor.stop();
      updateRestriction();
    },
  });
  definition = mode.definition;
  mode.attach(handle);
  const restriction = surface.register({
    source: '@agimon-ai/doompi-author',
    restrict: authorToolRestriction(active, !!monitor.snapshot()),
  });
  const updateRestriction = () => restriction.update(authorToolRestriction(active, !!monitor.snapshot()));
  const unsubscribeMonitor = monitor.subscribe(() => {
    mode.publish();
    updateRestriction();
  });
  sessionStart = () => mode.publish();
  const change = (enabled: boolean) => {
    if (disposed || active === enabled) return;
    active = enabled;
    if (enabled) monitor.start();
    else monitor.stop();
    updateRestriction();
    mode.publish();
  };
  return {
    controller: {
      activate: () => change(true),
      deactivate: () => change(false),
      snapshot: () => ({
        activation: active ? ('active' as const) : ('inactive' as const),
        catalogToken: monitor.snapshot()?.catalogToken ?? '',
        capabilityCount: monitor.snapshot()?.tools.length ?? 0,
      }),
    },
    definition: () => definition!,
    activeTools: () => activeTools,
    handle,
    catalog,
    surface,
    startSession: () => sessionStart?.(),
    focus: (focused: boolean) => {
      viewportFocused = focused;
    },
    cleanup: () => {
      change(false);
      disposed = true;
      monitor.dispose();
      unsubscribeMonitor();
      mode.detach();
    },
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
    expect(definition.descriptor).toBe(authorMinorMode.descriptor);
    expect(definition.initialState).toMatchObject({ activation: 'inactive', condition: 'ready' });
    // The arbiter hides an inactive mode's tools as soon as it registers, so
    // the surface is already narrowed before the first session starts.
    expect(value.activeTools()).toEqual(['read']);
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
    value.cleanup();
    value.controller.activate();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(signal?.aborted).toBe(true);
    expect(value.handle.dispose).not.toHaveBeenCalled();
    expect(value.catalog.describe).toHaveBeenCalledOnce();
    expect(value.activeTools()).toEqual(['read']);
  });
});
