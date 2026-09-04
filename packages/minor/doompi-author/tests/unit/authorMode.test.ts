import type {
  MinorModeCatalogService,
  MinorModeOwnerDefinition,
  MinorModeOwnerHandle,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { installAuthorMode } from '../../src/services/authorMode.ts';
import type { AuthorCatalog } from '../../src/services/authorCatalog.ts';

function fixture() {
  let definition: MinorModeOwnerDefinition<ExtensionContext> | undefined;
  let cleanup: (() => void) | undefined;
  let activeTools = ['read', 'describe_author_tools', 'use_author_tools'];
  const handle: MinorModeOwnerHandle = {
    getState: () => definition!.initialState,
    publish: vi.fn(),
    dispose: vi.fn(),
  };
  const catalog = {
    registerOwner(next: MinorModeOwnerDefinition<ExtensionContext>) {
      definition = next;
      return handle;
    },
  } as MinorModeCatalogService;
  const cordis = {
    inject(_services: readonly string[], callback: (context: Context) => (() => void) | void) {
      callback({ get: () => catalog } as unknown as Context);
    },
    effect(factory: () => () => void) {
      cleanup = factory();
    },
  } as unknown as Context;
  const pi = {
    getActiveTools: () => activeTools,
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  const facade = { dispose: vi.fn() };
  const registerFacades = vi.fn(() => facade);

  installAuthorMode(cordis, pi, {} as AuthorCatalog, registerFacades);
  return { definition: () => definition!, activeTools: () => activeTools, handle, facade, cleanup: () => cleanup?.() };
}

describe('Author minor mode', () => {
  it('registers as an inactive minor mode and toggles only its façade tools', async () => {
    const value = fixture();
    const definition = value.definition();

    expect(definition.descriptor).toMatchObject({ id: 'author', label: 'Author' });
    expect(definition.initialState).toMatchObject({ activation: 'inactive', condition: 'ready' });
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
    expect(value.activeTools()).toEqual(['read', 'describe_author_tools', 'use_author_tools']);
    expect(value.handle.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'active' }));

    await definition.handleAction(
      'deactivate',
      {},
      {
        context: {} as ExtensionContext,
        operationId: 'deactivate-author',
        sessionKind: 'tui',
        signal: new AbortController().signal,
      },
    );
    expect(value.activeTools()).toEqual(['read']);
    expect(value.handle.publish).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));

    value.cleanup();
    expect(value.facade.dispose).toHaveBeenCalledOnce();
  });
});
