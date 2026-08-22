import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { readDoomSkillSourcesService } from '@agimon-ai/doompi-extension-contracts/skills';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import skillsExtension from '../../src/adapters/pi/extension.ts';

interface Snapshot {
  skills: Array<{ name: string }>;
  diagnostics: string[];
}

interface DeferredSnapshot {
  promise: Promise<Snapshot>;
  resolve: (snapshot: Snapshot) => void;
}

const { generations, registerLeaderContribution, buildPromptWithDeferredSkills, expandDeferredSkillCommand } =
  vi.hoisted(() => ({
    generations: [] as DeferredSnapshot[],
    registerLeaderContribution: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })),
    buildPromptWithDeferredSkills: vi.fn((prompt: string) => `${prompt}\n<available_skills />`),
    expandDeferredSkillCommand: vi.fn((text: string, skills: Array<{ name: string }>) =>
      skills.length > 0 ? `<expanded>${text}</expanded>` : text,
    ),
  }));

vi.mock('@agimon-ai/doompi-config/piContext', () => ({
  requireDoomConfigContext: () => ({ harness: { skillDirectories: ['/skills'] } }),
}));
vi.mock('../../src/adapters/deferredSkills.ts', () => ({
  DeferredSkillLoader: class DeferredSkillLoader {
    start(): Promise<Snapshot> {
      const generation = generations.shift();
      if (!generation) throw new Error('missing controlled skill generation');
      return generation.promise;
    }
  },
  buildPromptWithDeferredSkills,
  expandDeferredSkillCommand,
}));

function deferredSnapshot(): DeferredSnapshot {
  let resolve: ((snapshot: Snapshot) => void) | undefined;
  const promise = new Promise<Snapshot>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve(snapshot) {
      resolve?.(snapshot);
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];

async function register() {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, value: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(value);
      },
      on(event: string, handler: (value: unknown) => void) {
        const subscriptions = eventHandlers.get(event) ?? new Set();
        subscriptions.add(handler);
        eventHandlers.set(event, subscriptions);
        return () => subscriptions.delete(handler);
      },
    },
    on: vi.fn((event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) => {
      const previous = handlers.get(event);
      handlers.set(event, async (payload, context) => {
        await previous?.(payload, context);
        return handler(payload, context);
      });
    }),
    registerCommand: vi.fn((name: string, options: unknown) => commands.set(name, options)),
  } as unknown as ExtensionAPI;
  await skillsExtension(pi);
  const ui = { notify: vi.fn() };
  const ctx = {
    cwd: '/repo',
    ui,
    sessionManager: { getSessionId: () => 'session', getBranch: () => [] },
  } as unknown as ExtensionContext;
  const connection = await connectDoomCordisHost(pi, 'skill-readiness-test');
  const configFiber = connection.root.plugin((cordis) => {
    cordis.provide('doom/config', {});
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(),
      registerLeader: registerLeaderContribution,
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    cordis.provide(DOOM_UI_HUB_SERVICE, hub);
  });
  await configFiber;
  cleanup.push(async () => {
    await handlers.get('session_shutdown')?.({}, ctx);
    await configFiber.dispose();
    await connection.dispose();
  });
  return { commands, ctx, handlers, pi, root: connection.root, ui };
}

async function flushImports(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  generations.splice(0);
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('skills readiness generations', () => {
  it('registers the command immediately and provides session-owned skill sources', async () => {
    generations.push(deferredSnapshot());
    const { commands, ctx, handlers, root } = await register();
    expect(readDoomSkillSourcesService(root)).toBeUndefined();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(readDoomSkillSourcesService(root)?.generation).toMatch(/:skill-sources$/u);
    expect(registerLeaderContribution).toHaveBeenCalledOnce();
    expect(commands.has('skills')).toBe(true);
    expect(handlers.has('session_start')).toBe(true);
    expect(handlers.has('input')).toBe(true);
    expect(handlers.has('before_agent_start')).toBe(true);
  });

  it('contributes authoring and usage Help and rebinds a replacement provider', async () => {
    generations.push(deferredSnapshot());
    const { root } = await register();
    const first = createDoomHelpService('skill-help-first');
    const firstProvider = root.plugin((context) => context.provide(DOOM_HELP_SERVICE, first));
    await firstProvider;

    expect(first.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-skill',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-author-skill',
            description:
              'Author and distribute DoomPi agent skills. Use when creating a SKILL.md, adding supporting references or scripts, contributing a runtime skill directory through Cordis, or publishing activation-gated Help prompts from a DoomPi package.',
          },
          {
            name: 'doompi-use-skill',
            description:
              "Use DoomPi's skill catalog and deferred discovery. Use when browsing available skills, invoking /skill:name, understanding Help and extension-owned skill groups, or diagnosing why a skill is absent or shadowed.",
          },
        ],
      },
    ]);

    await firstProvider.dispose();
    expect(first.listContributions()).toEqual([]);

    const replacement = createDoomHelpService('skill-help-replacement');
    const replacementProvider = root.plugin((context) => context.provide(DOOM_HELP_SERVICE, replacement));
    await replacementProvider;
    expect(replacement.listContributions()).toHaveLength(1);

    await replacementProvider.dispose();
    first.dispose();
    replacement.dispose();
  });

  it('lets ordinary input continue while discovery is unresolved', async () => {
    generations.push(deferredSnapshot());
    const { ctx, handlers } = await register();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    await expect(handlers.get('input')?.({ text: 'hello', images: [] }, ctx)).resolves.toEqual({
      action: 'continue',
    });
  });

  it('waits for discovery before expanding an explicit skill invocation', async () => {
    const generation = deferredSnapshot();
    generations.push(generation);
    const { ctx, handlers } = await register();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    const result = Promise.resolve(handlers.get('input')?.({ text: '/skill:review now', images: [] }, ctx));
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await flushImports();
    expect(settled).toBe(false);
    generation.resolve({ skills: [{ name: 'review' }], diagnostics: [] });

    await expect(result).resolves.toMatchObject({
      action: 'transform',
      text: '<expanded>/skill:review now</expanded>',
    });
  });

  it('waits before agent start, injects inventory, and reports diagnostics once', async () => {
    const generation = deferredSnapshot();
    generations.push(generation);
    const { ctx, handlers, ui } = await register();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    const event = { systemPrompt: 'base', systemPromptOptions: {} };
    const first = Promise.resolve(handlers.get('before_agent_start')?.(event, ctx));
    await flushImports();
    generation.resolve({ skills: [{ name: 'review' }], diagnostics: ['bad metadata'] });

    await expect(first).resolves.toEqual({ systemPrompt: 'base\n<available_skills />' });
    await expect(handlers.get('before_agent_start')?.(event, ctx)).resolves.toEqual({
      systemPrompt: 'base\n<available_skills />',
    });
    expect(ui.notify).toHaveBeenCalledTimes(1);
  });

  it('does not append deferred skills already included by Pi', async () => {
    const generation = deferredSnapshot();
    generations.push(generation);
    const { ctx, handlers } = await register();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    const event = {
      systemPrompt: 'base\n<available_skills>native</available_skills>',
      systemPromptOptions: { skills: [{ name: 'review' }] },
    };
    const result = Promise.resolve(handlers.get('before_agent_start')?.(event, ctx));

    generation.resolve({ skills: [{ name: 'review' }], diagnostics: [] });

    await expect(result).resolves.toBeUndefined();
    expect(buildPromptWithDeferredSkills).not.toHaveBeenCalled();
  });

  it('ignores completion from a stale reload generation', async () => {
    const oldGeneration = deferredSnapshot();
    const currentGeneration = deferredSnapshot();
    generations.push(oldGeneration, currentGeneration);
    const { ctx, handlers } = await register();
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await flushImports();
    await handlers.get('session_start')?.({ reason: 'reload' }, ctx);
    await flushImports();

    const result = Promise.resolve(
      handlers.get('before_agent_start')?.({ systemPrompt: 'base', systemPromptOptions: {} }, ctx),
    );
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    oldGeneration.resolve({ skills: [{ name: 'old' }], diagnostics: [] });
    await flushImports();
    expect(settled).toBe(false);

    currentGeneration.resolve({ skills: [{ name: 'current' }], diagnostics: [] });
    await expect(result).resolves.toEqual({ systemPrompt: 'base\n<available_skills />' });
  });
});
