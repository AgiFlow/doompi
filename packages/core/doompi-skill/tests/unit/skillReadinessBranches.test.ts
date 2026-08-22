import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSkillReadiness } from '../../src/adapters/pi/skillReadiness.ts';

type Handler = (event: never, ctx: ExtensionContext) => unknown;

let cordis: Context | undefined;

const helpSkillView = {
  merge: vi.fn(() => ({ additionalSkills: [], helpSkills: [], diagnostics: [], diagnosticKey: 'k' })),
  dispose: vi.fn(),
} as never;

function harness(pi: Partial<ExtensionAPI>) {
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    ...pi,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/repo',
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => 'readiness-session' },
  } as unknown as ExtensionContext;
  cordis = new Context();
  provideDoomConfigContext(cordis, {
    settings: { projectTrust: 'ask' },
    harness: { ...readHarnessState({}), root: '/repo' },
    requiresRelaunch: false,
  });
  return { api, ctx, handlers, cordis };
}

afterEach(() => {
  void cordis?.fiber.dispose();
  cordis = undefined;
  vi.clearAllMocks();
});

describe('skill readiness edges', () => {
  it('reports discovery failure as a diagnostic rather than throwing', async () => {
    const { api, ctx, handlers, cordis } = harness({});
    const loadDeferredSkills = vi.fn(async () => {
      throw new Error('discovery boom');
    }) as never;
    const readiness = registerSkillReadiness(api, helpSkillView, loadDeferredSkills, () => cordis);

    handlers.get('session_start')?.({} as never, ctx);
    const snapshot = await readiness.current();

    expect(snapshot?.skills).toEqual([]);
    expect(snapshot?.diagnostics[0]).toContain('discovery boom');
  });

  it('has no snapshot before a session has started', async () => {
    const { api, cordis } = harness({});
    const readiness = registerSkillReadiness(api, helpSkillView, (async () => ({})) as never, () => cordis);

    expect(await readiness.current()).toBeUndefined();
  });

  it('tolerates a Pi build with no getCommands', async () => {
    const { api, ctx, handlers, cordis } = harness({});
    const expandDeferredSkillCommand = vi.fn((text: string) => text);
    const loadDeferredSkills = vi.fn(async () => ({
      DeferredSkillLoader: class {
        start() {
          return Promise.resolve({ skills: [], diagnostics: [] });
        }
      },
      expandDeferredSkillCommand,
    })) as never;
    registerSkillReadiness(api, helpSkillView, loadDeferredSkills, () => cordis);

    handlers.get('session_start')?.({} as never, ctx);
    const result = await handlers.get('input')?.(
      { type: 'input', text: '/skill:thing', source: 'interactive' } as never,
      ctx,
    );

    expect(result).toEqual({ action: 'continue' });
    expect(expandDeferredSkillCommand).toHaveBeenCalled();
  });

  it('leaves input that is not a skill invocation alone', async () => {
    const { api, ctx, handlers, cordis } = harness({ getCommands: vi.fn(() => []) as never });
    registerSkillReadiness(api, helpSkillView, (async () => ({})) as never, () => cordis);

    handlers.get('session_start')?.({} as never, ctx);
    expect(
      await handlers.get('input')?.({ type: 'input', text: 'hello', source: 'interactive' } as never, ctx),
    ).toEqual({ action: 'continue' });
  });
});
