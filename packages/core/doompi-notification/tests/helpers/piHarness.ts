import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { type Mock, vi } from 'vitest';

export type EventHandler = (event: unknown, context: ExtensionContext) => unknown;
export type BusHandler = (payload: unknown) => void;

export interface PiHarness {
  appendEntry: Mock;
  busDisposers: Mock[];
  busHandlers: Map<string, BusHandler>;
  context: ExtensionContext;
  exec: Mock;
  getSessionName: Mock;
  handlers: Map<string, EventHandler>;
  notify: Mock;
  pi: ExtensionAPI;
  setTitle: Mock;
  ui: ExtensionUIContext;
}

export function execResult(code = 0) {
  return { stdout: '', stderr: '', code, killed: false };
}

/**
 * A Pi host stub that records what an extension registered.
 *
 * The real host is a running session, so the only way to exercise lifecycle
 * wiring is to capture the handlers and fire them by name.
 */
export function createPiHarness(): PiHarness {
  const busDisposers: Mock[] = [];
  const busHandlers = new Map<string, BusHandler>();
  const handlers = new Map<string, EventHandler>();
  const appendEntry = vi.fn();
  const exec = vi.fn().mockResolvedValue(execResult());
  const getSessionName = vi.fn().mockReturnValue(undefined);
  const notify = vi.fn();
  const setTitle = vi.fn();

  const ui = {
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue('Approve'),
    input: vi.fn().mockResolvedValue('feedback'),
    editor: vi.fn().mockResolvedValue('feedback'),
    notify,
    setTitle,
  } as unknown as ExtensionUIContext;

  const pi = {
    appendEntry,
    exec,
    getSessionName,
    events: {
      on: vi.fn((channel: string, handler: BusHandler) => {
        busHandlers.set(channel, handler);
        const disposer = vi.fn(() => {
          if (busHandlers.get(channel) === handler) busHandlers.delete(channel);
        });
        busDisposers.push(disposer);
        return disposer;
      }),
      emit: vi.fn((channel: string, payload: unknown) => {
        busHandlers.get(channel)?.(payload);
      }),
    },
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
  } as unknown as ExtensionAPI;

  const context = {
    cwd: '/repo/example',
    hasPendingMessages: () => false,
    hasUI: true,
    mode: 'tui',
    ui,
  } as unknown as ExtensionContext;

  return { appendEntry, busDisposers, busHandlers, context, exec, getSessionName, handlers, notify, pi, setTitle, ui };
}
