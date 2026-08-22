import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { DoomConfigContext, HarnessState } from '@agimon-ai/doompi-config/types';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HookCommand, HookOutcome, HookPayload, HookRunOptions, HookRunner } from '../../src/types/hooks.ts';

export type PiHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

export interface SentMessage {
  customType?: string;
  content?: unknown;
}

export interface PiHarness {
  cordis: Context;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  handlers: Map<string, PiHandler>;
  messages: SentMessage[];
  statuses: Array<[string, string | undefined]>;
  provideConfig(harness: Partial<HarnessState>): Promise<void>;
  removeConfig(): Promise<void>;
  dispose(): void;
}

export const SESSION_ID = 'session-under-test';
export const TEST_CORDIS_ROOT = Symbol.for('@agimon-ai/doompi-hook.test-cordis-root');

function configContext(harness: Partial<HarnessState>): DoomConfigContext {
  return {
    settings: { projectTrust: 'ask' },
    harness: { ...readHarnessState({}), ...harness },
    requiresRelaunch: false,
  };
}

function configProvider(ctx: Context, config: DoomConfigContext): void {
  provideDoomConfigContext(ctx, config);
}

/**
 * A Pi session double.
 *
 * Only the surface this package touches is implemented: handler registration,
 * steering messages, the status line, and the Doom config context the harness
 * would otherwise have bound during launch.
 */
export function piHarness(
  harness: Partial<HarnessState>,
  options: { hasUI?: boolean; provideConfig?: boolean } = {},
): PiHarness {
  const handlers = new Map<string, PiHandler>();
  const registrations = new Map<string, PiHandler[]>();
  const messages: SentMessage[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const pi = {
    on: (event: string, handler: PiHandler) => {
      const registered = [...(registrations.get(event) ?? []), handler];
      registrations.set(event, registered);
      handlers.set(event, (eventPayload, context) => {
        let pending: Promise<unknown> | undefined;
        let result: unknown;
        for (const current of registered) {
          if (pending) {
            pending = pending.then(() => current(eventPayload, context));
            continue;
          }
          result = current(eventPayload, context);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            pending = Promise.resolve(result);
          }
        }
        return (pending ?? result) as Promise<unknown>;
      });
    },
    sendMessage: (message: SentMessage) => {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const cordis = new Context();
  let configFiber: Fiber | undefined;
  (pi as unknown as Record<PropertyKey, unknown>)[TEST_CORDIS_ROOT] = cordis;
  const ctx = {
    cwd: harness.root ?? '/repo',
    hasUI: options.hasUI ?? true,
    ui: { setStatus: (key: string, label?: string) => statuses.push([key, label]) },
    sessionManager: { getSessionId: () => SESSION_ID },
  } as unknown as ExtensionContext;
  if (options.provideConfig !== false) provideDoomConfigContext(cordis, configContext(harness));
  return {
    cordis,
    pi,
    ctx,
    handlers,
    messages,
    statuses,
    async provideConfig(nextHarness) {
      await configFiber?.dispose();
      configFiber = cordis.plugin(configProvider, configContext(nextHarness));
      await configFiber.await();
    },
    async removeConfig() {
      const current = configFiber;
      configFiber = undefined;
      await current?.dispose();
    },
    dispose: () => void cordis.fiber.dispose(),
  };
}

export interface StubRunner {
  runner: HookRunner;
  calls: Array<{ hook: HookCommand; payload: HookPayload; options: HookRunOptions }>;
}

/** A runner that answers per command name and never starts a process. */
export function stubRunner(outcomes: Record<string, HookOutcome> = {}): StubRunner {
  const calls: StubRunner['calls'] = [];
  return {
    calls,
    runner: {
      run: async (hook, payload, options) => {
        calls.push({ hook, payload, options });
        return outcomes[hook.command] ?? {};
      },
    },
  };
}
