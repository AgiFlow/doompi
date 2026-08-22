import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { readMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import cordisHostExtension from '../../src/extensions/entries/cordisHost.ts';
import modeCatalogExtension from '../../src/extensions/entries/modeCatalog.ts';
import { bindTestTransitionCoordinator } from '../helpers/transitionCoordinator.ts';

class TestBus implements EventBusLike {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
}

async function setup() {
  const events = new TestBus();
  const lifecycle = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const registerTool = vi.fn();
  const pi = {
    events,
    registerTool,
    on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  await cordisHostExtension(pi);
  await modeCatalogExtension(pi);
  const connection = await connectDoomCordisHost(pi, 'mode-catalog-test');
  const binding = bindTestTransitionCoordinator(connection.root, 'session-1', {
    current: { domains: [], majorMode: 'copilot', layers: [] },
  });
  const context = {
    hasUI: true,
    mode: 'tui',
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
  const dispatch = async (name: string, event: unknown = {}) => {
    for (const handler of lifecycle.get(name) ?? []) await handler(event, context);
    await connection.root.fiber.await();
  };
  return { binding, connection, dispatch, registerTool };
}

describe('mode catalog extension', () => {
  it('publishes the session service without registering a Pi tool', async () => {
    const { binding, connection, dispatch, registerTool } = await setup();
    await dispatch('session_start', { reason: 'startup' });
    expect(readMinorModeCatalog(connection.root)).toBeDefined();
    expect(registerTool).not.toHaveBeenCalled();
    await dispatch('session_shutdown');
    expect(readMinorModeCatalog(connection.root)).toBeUndefined();
    binding.dispose();
    await connection.dispose();
  });

  it('owns the root extension-authoring Help contribution across provider replacement', async () => {
    const { binding, connection, dispatch } = await setup();
    await dispatch('session_start', { reason: 'startup' });

    const firstHelp = createDoomHelpService('root-extension-help-first');
    const firstProvider = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, firstHelp));
    await firstProvider;
    expect(firstHelp.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi',
        moduleUrl: expect.stringContaining('modeCatalog'),
        skills: [
          {
            name: 'doompi-author-extension',
            description:
              'Create or update a DoomPi extension package inside the DoomPi monorepo or as an external npm package. Use for package layout, Pi discovery entries, shared Cordis lifecycle, package-owned Help, and extension verification.',
          },
        ],
      },
    ]);

    await firstProvider.dispose();
    expect(firstHelp.listContributions()).toEqual([]);

    const replacementHelp = createDoomHelpService('root-extension-help-replacement');
    const replacementProvider = connection.root.plugin((context) =>
      context.provide(DOOM_HELP_SERVICE, replacementHelp),
    );
    await replacementProvider;
    expect(replacementHelp.listContributions().map(({ source }) => source)).toEqual(['@agimon-ai/doompi']);

    await dispatch('session_shutdown');
    expect(replacementHelp.listContributions()).toEqual([]);
    await replacementProvider.dispose();
    binding.dispose();
    await connection.dispose();
  });
});
