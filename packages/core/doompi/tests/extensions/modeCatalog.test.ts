import { DOOM_MCP_STATUS_SERVICE } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import * as contextCatalog from '../../src/services/contextCatalog.ts';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_MINOR_MODE_ENTRY_TYPE, readMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import {
  DOOM_NOTIFICATION_SERVICE,
  type DoomNotificationService,
} from '@agimon-ai/doompi-extension-contracts/notification';
import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';
import { prepareMinorModeReloadHandoff } from '@agimon-ai/doompi-extension-contracts/transition';
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
  const registerCommand = vi.fn();
  const appendEntry = vi.fn();
  const pi = {
    events,
    registerTool,
    registerCommand,
    appendEntry,
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
  return { binding, connection, context, dispatch, registerTool, appendEntry };
}

describe('mode catalog extension', () => {
  it('refreshes context on late MCP changes without a turn and unsubscribes on removal', async () => {
    const publish = vi.fn(async () => undefined);
    const spy = vi.spyOn(contextCatalog, 'createContextPublisher').mockReturnValue({ publish, dispose: vi.fn() });
    const { binding, connection, dispatch } = await setup();
    try {
      await dispatch('session_start', { reason: 'startup' });
      const listeners = new Set<() => void>();
      const provider = connection.root.plugin((root) => {
        root.provide(DOOM_MCP_STATUS_SERVICE, {
          generation: 'mcp-test',
          getSnapshot: () => ({ servers: [] }),
          onChange: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        });
      });
      await provider;
      await connection.root.fiber.await();
      expect(listeners.size).toBe(1);
      expect(publish).toHaveBeenCalled();
      publish.mockClear();
      for (const listener of listeners) listener();
      expect(publish).toHaveBeenCalledOnce();
      await provider.dispose();
      expect(listeners.size).toBe(0);
      publish.mockClear();
      for (const listener of listeners) listener();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await dispatch('session_shutdown');
      binding.dispose();
      await connection.dispose();
      spy.mockRestore();
    }
  });

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

  it('journals the catalog projection as a custom entry whenever it changes', async () => {
    const { binding, connection, dispatch, appendEntry } = await setup();
    await dispatch('session_start', { reason: 'startup' });
    const catalog = readMinorModeCatalog(connection.root);
    if (!catalog) throw new Error('The catalog service was not published.');

    const owner = catalog.registerOwner({
      descriptor: {
        source: '@agimon-ai/probe',
        id: 'probe',
        label: 'Probe',
        description: 'A probe mode.',
        order: 5,
        actions: [
          { id: 'toggle', label: 'Toggle', description: 'Flip.', contexts: ['tui', 'headless'], parameters: [] },
        ],
      },
      initialState: { activation: 'inactive', condition: 'ready', actions: [{ id: 'toggle', enabled: true }] },
      handleAction: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(appendEntry).toHaveBeenCalledWith(
      DOOM_MINOR_MODE_ENTRY_TYPE,
      expect.objectContaining({
        version: 1,
        modes: [
          expect.objectContaining({
            id: 'probe',
            activation: 'inactive',
            actions: [expect.objectContaining({ id: 'toggle' })],
          }),
        ],
      }),
    );

    // Startup entries never reach an rpc client, so the boot publish repeats
    // the projection once the client can see it, even though it is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(appendEntry.mock.calls.filter(([type]) => type === DOOM_MINOR_MODE_ENTRY_TYPE).length).toBe(2);

    // A state flip journals again; an unchanged snapshot does not.
    const before = appendEntry.mock.calls.length;
    owner.publish({
      activation: 'active',
      condition: 'ready',
      detail: 'running',
      actions: [{ id: 'toggle', enabled: true }],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(appendEntry.mock.calls.length).toBe(before + 1);
    expect(appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      modes: [expect.objectContaining({ id: 'probe', activation: 'active', detail: 'running' })],
    });

    owner.dispose();
    await dispatch('session_shutdown');
    binding.dispose();
    await connection.dispose();
  });

  it.each([
    { label: 'notification service', service: true },
    { label: 'UI fallback', service: false },
  ])('routes restoration warnings through the $label', async ({ service }) => {
    const { binding, connection, context, dispatch } = await setup();
    const request = vi.fn();
    const provider = service
      ? connection.root.plugin((providerContext) =>
          providerContext.provide(DOOM_NOTIFICATION_SERVICE, {
            generation: 'mode-catalog-notification-test',
            request,
          } satisfies DoomNotificationService),
        )
      : undefined;
    await provider;
    await dispatch('session_start', { reason: 'startup' });
    const initialCatalog = readMinorModeCatalog(connection.root);
    if (!initialCatalog) throw new Error('The initial catalog service was not published.');
    initialCatalog.registerOwner({
      descriptor: {
        source: '@agimon-ai/probe',
        id: 'probe',
        label: 'Probe',
        description: 'A probe mode.',
        order: 5,
        actions: [{ id: 'activate', label: 'Activate', description: 'Activate.', contexts: ['tui'], parameters: [] }],
      },
      initialState: { activation: 'active', condition: 'ready', actions: [{ id: 'activate', enabled: true }] },
      handleAction: () => undefined,
    });
    prepareMinorModeReloadHandoff(
      connection.root,
      'session-1',
      binding.coordinator.hostGeneration,
      'reload-operation',
      initialCatalog.getSnapshot(),
    );

    await dispatch('session_start', { reason: 'reload' });
    const restoredCatalog = readMinorModeCatalog(connection.root);
    if (!restoredCatalog) throw new Error('The replacement catalog service was not published.');
    restoredCatalog.registerOwner({
      descriptor: {
        source: '@agimon-ai/probe',
        id: 'probe',
        label: 'Probe',
        description: 'A probe mode.',
        order: 5,
        actions: [{ id: 'activate', label: 'Activate', description: 'Activate.', contexts: ['tui'], parameters: [] }],
      },
      initialState: { activation: 'inactive', condition: 'ready', actions: [{ id: 'activate', enabled: true }] },
      handleAction: () => {
        throw new Error('restore failed');
      },
    });

    const expectedBody = expect.stringContaining('Could not restore a minor mode after reload:');
    if (service) {
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ body: expectedBody, level: 'warning' }));
      expect(context.ui.notify).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(context.ui.notify).toHaveBeenCalledWith(expectedBody, 'warning'));
      expect(request).not.toHaveBeenCalled();
    }

    await dispatch('session_shutdown');
    await provider?.dispose();
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
