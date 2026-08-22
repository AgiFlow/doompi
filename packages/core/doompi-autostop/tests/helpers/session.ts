import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

export interface SessionHarness {
  readonly pi: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly shutdown: ReturnType<typeof vi.fn>;
  /** Mutable session state the policy reads through the Pi context. */
  state: { hasPendingMessages: boolean; isIdle: boolean };
  /** Fires a registered hook, or throws when nothing registered it. */
  fire(event: string): Promise<void>;
  registered(): string[];
}

/**
 * A stand-in for the Pi host, not the real one.
 *
 * Pi's `on` returns nothing, so a test can only see a leaked listener by firing
 * the event again after shutdown. This harness keeps every handler reachable so
 * it can do exactly that.
 */
export function createSessionHarness(): SessionHarness {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const shutdown = vi.fn();
  const harness: SessionHarness = {
    pi: {
      events: {
        emit(event: string, payload: unknown) {
          for (const handler of busHandlers.get(event) ?? []) handler(payload);
        },
        on(event: string, handler: (payload: unknown) => void) {
          const listeners = busHandlers.get(event) ?? new Set();
          listeners.add(handler);
          busHandlers.set(event, listeners);
          return () => listeners.delete(handler);
        },
      },
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as unknown as ExtensionAPI,
    context: {
      hasPendingMessages: () => harness.state.hasPendingMessages,
      isIdle: () => harness.state.isIdle,
      shutdown,
    } as unknown as ExtensionContext,
    shutdown,
    state: { hasPendingMessages: false, isIdle: true },
    async fire(event: string) {
      const listeners = handlers.get(event);
      if (!listeners) throw new Error(`no handler registered for ${event}`);
      for (const handler of listeners) await handler({ type: event }, harness.context);
    },
    registered: () => [...handlers.keys()],
  };
  return harness;
}
