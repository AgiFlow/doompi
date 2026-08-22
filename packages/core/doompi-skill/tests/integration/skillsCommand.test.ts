import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDoomConfigContext, provideDoomConfigContext } from '@agimon-ai/doompi-config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  SessionStartEvent,
  Skill,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHarnessState, resetHarnessStore } from '@agimon-ai/doompi-config/harnessStore';
import skillsExtension from '../../src/adapters/pi/extension.ts';
import { skillInvocation } from '../../src/services/skillText.ts';
import { SKILLS_LEADER_CONTRIBUTION } from '../../src/types/skills.ts';
import type { SkillsOverlayOptions, SkillsOverlayResult } from '../../src/tui/skillsOverlay.ts';

const { registerLeaderContribution, openOverlay, helpState, mergeHelp, disposeHelp } = vi.hoisted(() => {
  const state = { skills: [] as Skill[], diagnostics: [] as string[], revision: 0 };
  return {
    registerLeaderContribution: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })),
    openOverlay: vi.fn<(ctx: unknown, options: SkillsOverlayOptions) => Promise<SkillsOverlayResult>>(),
    helpState: state,
    mergeHelp: vi.fn((input: { normalSkills: readonly Skill[]; deferredSkills: readonly Skill[] }) => {
      const additionalSkills = [...input.deferredSkills, ...state.skills];
      return {
        skills: [...input.normalSkills, ...additionalSkills],
        additionalSkills,
        helpSkills: [...state.skills],
        diagnostics: [...state.diagnostics],
        diagnosticKey: `help:${state.revision}:${state.diagnostics.join(':')}`,
      };
    }),
    disposeHelp: vi.fn(),
  };
});

vi.mock('../../src/tui/skillsOverlay.ts', () => ({ openSkillsOverlay: openOverlay }));
vi.mock('../../src/adapters/helpSkills.ts', () => ({
  createActiveHelpSkillView: () => ({ bind: vi.fn(() => vi.fn()), merge: mergeHelp, dispose: disposeHelp }),
}));

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const SKILL_RELOAD_TEST_TIMEOUT_MS = 15_000;

function writeSkill(directory: string, name: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nBody.\n`);
}

/** Resolves the overlay with the first skill the command discovered. */
function invokeFirstSkill(): void {
  openOverlay.mockImplementation(async (_ctx, options) => {
    const skill = options.catalog.groups.flatMap((group) => group.owners.flatMap((owner) => owner.skills))[0];
    if (!skill) throw new Error('fixture built an empty catalog');
    return { kind: 'invoke', skill };
  });
}

describe('skills pi extension', () => {
  let root: string;
  let disposeConfig: (() => void) | undefined;
  let activeCordis: Context | undefined;
  let activeHandlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown> | undefined;
  const previousRoot = process.env.DOOMPI_ROOT;
  const previousSkillDirs = process.env.DOOMPI_SKILL_DIRS;

  beforeEach(() => {
    vi.clearAllMocks();
    helpState.skills = [];
    helpState.diagnostics = [];
    helpState.revision = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-entry-'));
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'domains.yaml'), 'domains:\n  default:\n    plugins: []\n');
    writeSkill(path.join(root, '.claude', 'skills', 'git-commit'), 'git-commit');
    process.env.DOOMPI_ROOT = root;
  });

  afterEach(() => {
    disposeConfig?.();
    disposeConfig = undefined;
    activeCordis = undefined;
    activeHandlers = undefined;
    process.env.DOOMPI_ROOT = previousRoot;
    process.env.DOOMPI_SKILL_DIRS = previousSkillDirs;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function register() {
    const commands = new Map<string, CommandHandler>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const pi = {
      events: {
        emit: vi.fn((event: string, value: unknown) => {
          for (const handler of eventHandlers.get(event) ?? []) handler(value);
        }),
        on: vi.fn((event: string, handler: (value: unknown) => void) => {
          const subscriptions = eventHandlers.get(event) ?? new Set();
          subscriptions.add(handler);
          eventHandlers.set(event, subscriptions);
          return () => subscriptions.delete(handler);
        }),
      },
      on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const previous = handlers.get(event);
        handlers.set(event, async (payload, context) => {
          await previous?.(payload, context);
          return handler(payload, context);
        });
      }),
      registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => {
        commands.set(name, options.handler);
      }),
      getCommands: vi.fn(() => []),
    } as unknown as ExtensionAPI;
    await skillsExtension(pi);
    activeHandlers = handlers;
    const connection = await connectDoomCordisHost(pi, 'skills-command-test');
    activeCordis = connection.root;
    const uiHub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(),
      registerLeader: registerLeaderContribution,
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    const uiFiber = connection.root.plugin((cordis) => cordis.provide(DOOM_UI_HUB_SERVICE, uiHub));
    await uiFiber;
    disposeConfig = () => void uiFiber.dispose().then(() => connection.dispose());
    return { pi, commands, handlers };
  }

  async function context(activeSkillDirectories: string[]) {
    process.env.DOOMPI_SKILL_DIRS = activeSkillDirectories.join(path.delimiter);
    resetHarnessStore();
    getHarnessState();
    const ui = { notify: vi.fn(), setEditorText: vi.fn() };
    const ctx = {
      ui,
      hasUI: true,
      mode: 'tui',
      cwd: root,
      sessionManager: { getSessionId: () => 'session-1', getBranch: () => [] },
      getSystemPromptOptions: () => ({ cwd: root, skills: [] }),
    } as unknown as ExtensionCommandContext & { ui: typeof ui };
    if (!activeCordis) throw new Error('test runtime context is unavailable');
    const configFiber = activeCordis.plugin((cordis) => {
      provideDoomConfigContext(cordis, createDoomConfigContext(ctx as unknown as ExtensionContext));
    });
    await configFiber;
    const releaseConnection = disposeConfig;
    disposeConfig = () => void configFiber.dispose().then(() => releaseConnection?.());
    await activeHandlers?.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
    return ctx;
  }

  it('registers the SPC e s binding under the core extension group', async () => {
    await register();

    expect(registerLeaderContribution).toHaveBeenCalledWith({
      source: '@agimon-ai/doompi-skill',
      bindings: [
        {
          id: 'skills.browse',
          path: [
            { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 },
            { key: 's', label: 'skills', detail: 'browse catalog' },
          ],
          command: { name: 'skills' },
        },
      ],
    });
  });

  // Key, label and order are the group's identity, so those must match the core
  // declaration exactly. The subtitle is not: the registry tolerates a
  // disagreement there so a version skew cannot cost this package its binding.
  it('repeats the core extension group prefix exactly', () => {
    expect(SKILLS_LEADER_CONTRIBUTION.bindings[0]?.path[0]).toMatchObject({
      key: 'e',
      label: 'extension',
      order: 50,
    });
  });

  it('registers the /skills command', async () => {
    expect((await register()).commands.has('skills')).toBe(true);
  });

  it('refuses to open outside interactive mode', async () => {
    const { commands } = await register();
    const ctx = await context([]);

    await commands.get('skills')?.('', { ...ctx, hasUI: false } as unknown as ExtensionCommandContext);

    expect(openOverlay).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('/skills requires interactive mode', 'error');
  });

  it('prefills the editor for the selected skill', async () => {
    const { commands } = await register();
    const ctx = await context([path.join(root, '.claude', 'skills')]);
    invokeFirstSkill();

    await commands.get('skills')?.('', ctx);

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith('/skill:git-commit ');
  });

  it('keeps an unloaded skill out of the catalog entirely', async () => {
    const { commands } = await register();
    // Nothing selected, so the shared skill on disk is not loaded and the
    // overlay is never given the chance to offer it.
    const ctx = await context([]);
    openOverlay.mockResolvedValue(undefined);

    await commands.get('skills')?.('', ctx);

    const [, options] = openOverlay.mock.calls[0] ?? [];
    expect(options?.catalog.skillCount).toBe(0);
    expect(options?.catalog.groups.flatMap((group) => group.owners)).toEqual([]);
  });

  it('does nothing when the overlay is dismissed', async () => {
    const { commands } = await register();
    const ctx = await context([path.join(root, '.claude', 'skills')]);
    openOverlay.mockResolvedValue(undefined);

    await commands.get('skills')?.('', ctx);

    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it('starts discovery on session start and waits for it before transforming first input', async () => {
    const { handlers } = await register();
    const skillRoot = path.join(root, '.claude', 'skills');
    const ctx = await context([skillRoot]);

    await handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' } satisfies SessionStartEvent,
      ctx,
    );
    const result = await handlers.get('input')?.(
      {
        type: 'input',
        text: '/skill:git-commit explain this',
        source: 'interactive',
      } satisfies InputEvent,
      ctx,
    );

    expect(result).toMatchObject({ action: 'transform' });
    expect((result as { text: string }).text).toContain('<skill name="git-commit"');
  });

  it(
    'injects the loaded inventory on every turn and resets it for a reload generation',
    { timeout: SKILL_RELOAD_TEST_TIMEOUT_MS },
    async () => {
      const { handlers } = await register();
      const skillRoot = path.join(root, '.claude', 'skills');
      const ctx = await context([skillRoot]);
      const before = {
        type: 'before_agent_start',
        prompt: 'hello',
        systemPrompt: 'base',
        systemPromptOptions: { cwd: root, selectedTools: ['read'] },
      } satisfies BeforeAgentStartEvent;

      await handlers.get('session_start')?.(
        { type: 'session_start', reason: 'startup' } satisfies SessionStartEvent,
        ctx,
      );
      await handlers.get('input')?.({ type: 'input', text: 'hello', source: 'interactive' } satisfies InputEvent, ctx);
      expect(await handlers.get('before_agent_start')?.(before, ctx)).toMatchObject({
        systemPrompt: expect.stringContaining('<available_skills>'),
      });
      expect(await handlers.get('before_agent_start')?.({ ...before, systemPrompt: 'base' }, ctx)).toMatchObject({
        systemPrompt: expect.stringContaining('<available_skills>'),
      });

      await handlers.get('session_start')?.(
        { type: 'session_start', reason: 'reload' } satisfies SessionStartEvent,
        ctx,
      );
      await handlers.get('input')?.({ type: 'input', text: 'again', source: 'interactive' } satisfies InputEvent, ctx);
      expect(await handlers.get('before_agent_start')?.(before, ctx)).toMatchObject({
        systemPrompt: expect.stringContaining('<available_skills>'),
      });
    },
  );

  it('uses one active Help view for prompt inventory, explicit invocation, and /skills', async () => {
    const { commands, handlers } = await register();
    const wrapper = path.join(root, 'generated', 'workflow-help', 'SKILL.md');
    writeSkill(path.dirname(wrapper), 'workflow-help');
    helpState.skills = [
      {
        name: 'workflow-help',
        description: 'Workflow package guidance.',
        filePath: wrapper,
        baseDir: path.dirname(wrapper),
        sourceInfo: {
          path: wrapper,
          source: '@agimon-ai/doompi-workflow',
          scope: 'temporary',
          origin: 'package',
          baseDir: path.dirname(wrapper),
        },
        disableModelInvocation: false,
      },
    ];
    helpState.revision = 1;
    const ctx = await context([]);
    await handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' } satisfies SessionStartEvent,
      ctx,
    );

    const input = await handlers.get('input')?.(
      { type: 'input', text: '/skill:workflow-help', source: 'interactive' } satisfies InputEvent,
      ctx,
    );
    expect(input).toMatchObject({ action: 'transform', text: expect.stringContaining('workflow-help') });

    const before = {
      type: 'before_agent_start',
      prompt: 'hello',
      systemPrompt: 'base',
      systemPromptOptions: { cwd: root, selectedTools: ['read'], skills: [] },
    } satisfies BeforeAgentStartEvent;
    expect(await handlers.get('before_agent_start')?.(before, ctx)).toMatchObject({
      systemPrompt: expect.stringContaining('workflow-help'),
    });

    openOverlay.mockResolvedValue(undefined);
    await commands.get('skills')?.('', ctx);
    const [, options] = openOverlay.mock.calls[0] ?? [];
    expect(options?.catalog.groups.find((group) => group.key === 'help')?.owners).toMatchObject([
      { owner: '@agimon-ai/doompi-workflow', skills: [{ name: 'workflow-help' }] },
    ]);
  });

  it('removes Help skills before the next access after deactivation', async () => {
    const { handlers } = await register();
    const wrapper = path.join(root, 'generated', 'doompi-help', 'SKILL.md');
    writeSkill(path.dirname(wrapper), 'doompi-help');
    helpState.skills = [
      {
        name: 'doompi-help',
        description: 'Help guidance.',
        filePath: wrapper,
        baseDir: path.dirname(wrapper),
        sourceInfo: {
          path: wrapper,
          source: '@agimon-ai/doompi-help',
          scope: 'temporary',
          origin: 'package',
          baseDir: path.dirname(wrapper),
        },
        disableModelInvocation: false,
      },
    ];
    const ctx = await context([]);
    await handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' } satisfies SessionStartEvent,
      ctx,
    );
    expect(
      await handlers.get('input')?.(
        { type: 'input', text: '/skill:doompi-help', source: 'interactive' } satisfies InputEvent,
        ctx,
      ),
    ).toMatchObject({ action: 'transform' });

    helpState.skills = [];
    helpState.revision += 1;

    expect(
      await handlers.get('input')?.(
        { type: 'input', text: '/skill:doompi-help', source: 'interactive' } satisfies InputEvent,
        ctx,
      ),
    ).toEqual({ action: 'continue' });
  });

  it('disposes the Help snapshot client on shutdown', async () => {
    const { handlers } = await register();
    const ctx = await context([]);

    // Disposal unwinds the cordis fiber, so the shutdown handler is async now.
    await handlers.get('session_shutdown')?.({}, ctx);

    expect(disposeHelp).toHaveBeenCalledOnce();
  });

  it('builds the command with a trailing space so arguments can follow', () => {
    expect(skillInvocation('git-commit')).toBe('/skill:git-commit ');
  });
});
