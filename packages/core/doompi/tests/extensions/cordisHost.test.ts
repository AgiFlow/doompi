import { connectDoomCordisHost, DOOM_CORDIS_SESSION_SERVICE } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import cordisFinalizerExtension from '../../src/extensions/entries/cordisFinalizer.ts';
import cordisHostExtension from '../../src/extensions/entries/cordisHost.ts';

type Handler = (event: never, context: ExtensionContext) => unknown;

function setup() {
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const lifecycle = new Map<string, Handler[]>();
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = busHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        busHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
    },
    on(name: string, handler: Handler) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const context = {
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
  return {
    pi,
    async dispatch(event: SessionStartEvent | SessionShutdownEvent) {
      for (const handler of lifecycle.get(event.type) ?? []) await handler(event as never, context);
    },
  };
}

describe('composed Cordis boundary entries', () => {
  it('opens first, provides the session, and finalizes last with idempotent cleanup', async () => {
    const { pi, dispatch } = setup();
    await cordisHostExtension(pi);
    const feature = await connectDoomCordisHost(pi, '@test/feature', { allowStandalone: false });
    await cordisFinalizerExtension(pi);

    await dispatch({ type: 'session_start', reason: 'startup' });
    expect(feature.root.reflect.get(DOOM_CORDIS_SESSION_SERVICE)).toMatchObject({ sessionId: 'session-1' });

    await feature.dispose();
    await dispatch({ type: 'session_shutdown', reason: 'reload' });
    await dispatch({ type: 'session_shutdown', reason: 'reload' });
    expect(feature.root.reflect.get(DOOM_CORDIS_SESSION_SERVICE)).toBeUndefined();
  });
});
