import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainsExtension } from '../../src/adapters/pi/extension.ts';
import type { DomainTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';
import { bindConfig } from '../helpers/session.ts';

const telemetry: DomainTelemetry = {
  recordError: async () => undefined,
  recordEvent: async () => undefined,
};

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startSession(domains: string[]): Promise<{ setStatus: ReturnType<typeof vi.fn> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-status-'));
  cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
  const { pi, handlers } = piFixture();
  await domainsExtension(pi, telemetry);
  const connection = await connectDoomCordisHost(pi, 'domain-status-runtime');
  const fiber = connection.root.plugin((cordis) => {
    bindConfig(cordis, root, { domains });
    const coordinator = bindStubCoordinator(cordis, 'domain-status-session', {
      domains,
      majorMode: 'copilot',
      layers: [],
    });
    return () => coordinator.dispose();
  });
  await fiber;
  cleanups.push(async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) {
      await handler({}, { sessionManager: { getSessionId: () => 'domain-status-session' } });
    }
    await fiber.dispose();
    await connection.dispose();
  });

  const setStatus = vi.fn();
  const ctx = {
    ui: { setStatus, addAutocompleteProvider: vi.fn() },
    sessionManager: { getSessionId: () => 'domain-status-session' },
  };
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  return { setStatus };
}

describe('domain axis status', () => {
  it('publishes the active domains on session start', async () => {
    const { setStatus } = await startSession(['development', 'testing']);
    expect(setStatus).toHaveBeenCalledWith('doom-domain', 'development,testing');
  });

  it('publishes empty for a session with no active domains, keeping the axis on the bar', async () => {
    const { setStatus } = await startSession([]);
    expect(setStatus).toHaveBeenCalledWith('doom-domain', '');
  });
});
