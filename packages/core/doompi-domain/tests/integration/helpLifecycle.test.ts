import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_HELP_SERVICE,
  type DoomHelpContribution,
  type DoomHelpService,
} from '@agimon-ai/doompi-extension-contracts/help';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { domainsExtension } from '../../src/adapters/pi/extension.ts';
import type { DomainTelemetry } from '../../src/types/telemetry.ts';

const EXPECTED_DESCRIPTION =
  'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.';

function piFixture(): {
  readonly pi: ExtensionAPI;
  readonly handlers: Map<string, Array<(...argumentsValue: unknown[]) => unknown>>;
} {
  const handlers = new Map<string, Array<(...argumentsValue: unknown[]) => unknown>>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    pi: {
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
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI,
    handlers,
  };
}

describe('Domain Help contribution lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers reactively, follows provider replacement, and disposes each handle', async () => {
    const { pi, handlers } = piFixture();
    const telemetry = {
      recordError: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
    } satisfies DomainTelemetry;
    const firstDispose = vi.fn();
    const replacementDispose = vi.fn();
    const contributions: DoomHelpContribution[] = [];
    const services = [firstDispose, replacementDispose].map((dispose, index) => ({
      generation: `help-${index}`,
      register: vi.fn((contribution: DoomHelpContribution) => {
        contributions.push(contribution);
        return { source: contribution.source, generation: `registration-${index}`, dispose };
      }),
    })) as unknown as DoomHelpService[];

    await domainsExtension(pi, telemetry);
    const connection = await connectDoomCordisHost(pi, 'domain-help-lifecycle-test');
    const firstFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, services[0]!));
    await firstFiber;

    expect(contributions[0]).toEqual({
      source: '@agimon-ai/doompi-domain',
      moduleUrl: expect.stringMatching(/extension\.ts$/u),
      skills: [{ name: 'doompi-author-domain', description: EXPECTED_DESCRIPTION }],
    });

    await firstFiber.dispose();
    expect(firstDispose).toHaveBeenCalledOnce();

    const replacementFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, services[1]!));
    await replacementFiber;
    expect(contributions).toHaveLength(2);

    const shutdownContext = { sessionManager: { getSessionId: () => 'session' } };
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, shutdownContext);
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, shutdownContext);
    expect(replacementDispose).toHaveBeenCalledOnce();

    await replacementFiber.dispose();
    await connection.dispose();
  });
});
