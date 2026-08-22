import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, type DoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerConfigExtension } from '../src/adapters/pi/configExtension.ts';

const helpDispose = vi.hoisted(() => vi.fn());
const registerDoomConfigHelp = vi.hoisted(() => vi.fn(() => ({ dispose: helpDispose })));

vi.mock('../src/adapters/pi/helpContribution.ts', () => ({ registerDoomConfigHelp }));

describe('Config standard extension lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits idempotent package-local cleanup and permits recreation', async () => {
    const handlers = new Map<string, Array<(...argumentsValue: unknown[]) => unknown>>();
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const pi = {
      events: {
        emit(event: string, value: unknown) {
          for (const handler of eventHandlers.get(event) ?? []) handler(value);
        },
        on(event: string, handler: (value: unknown) => void) {
          const registered = eventHandlers.get(event) ?? new Set();
          registered.add(handler);
          eventHandlers.set(event, registered);
          return () => registered.delete(handler);
        },
      },
      on(event: string, handler: (...argumentsValue: unknown[]) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;

    await registerConfigExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'config-help-lifecycle-test');
    const helpService = { generation: 'help-generation' } as DoomHelpService;
    const helpFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, helpService));
    await helpFiber;

    expect(registerDoomConfigHelp).toHaveBeenCalledWith(helpService);
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, {});
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, {});
    expect(helpDispose).toHaveBeenCalledOnce();
    await helpFiber.dispose();
    await connection.dispose();

    await registerConfigExtension(pi);
    const replacementConnection = await connectDoomCordisHost(pi, 'config-help-lifecycle-replacement');
    const replacementService = { generation: 'replacement-help-generation' } as DoomHelpService;
    const replacementFiber = replacementConnection.root.plugin((context) =>
      context.provide(DOOM_HELP_SERVICE, replacementService),
    );
    await replacementFiber;
    expect(registerDoomConfigHelp).toHaveBeenCalledTimes(2);
    expect(registerDoomConfigHelp).toHaveBeenLastCalledWith(replacementService);
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, {});
    await replacementFiber.dispose();
    await replacementConnection.dispose();
  });
});
