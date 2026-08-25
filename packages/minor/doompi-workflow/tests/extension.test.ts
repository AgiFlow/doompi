import {
  childProcessContextEnvironment,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-extension-contracts/child-process';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import type { LeaderContribution } from '@agimon-ai/doompi-extension-contracts/leader';
import {
  createDoomSkillSourcesService,
  DOOM_SKILL_SOURCES_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/skills';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { DoomLeaderRegistry } from '@agimon-ai/doompi-ui/leaderRegistry';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDispatcherBridge,
  isWorkflowDispatcherProcess,
  resolveDispatcherParentSession,
  workflowExtension,
} from '../src/adapters/pi/extension.ts';
import { registerLeaderContribution, workflowLeaderBindings } from '../src/adapters/pi/leader.ts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(SUBAGENT_ROOT_SESSION_ENV, '');
});
afterEach(() => vi.unstubAllEnvs());

describe('doom workflow extension', () => {
  // The mode itself is reached through the leader menu, the way plan mode is,
  // so the palette carries exactly one entry for this extension: the launch
  // verb, which exists because a browser can only send a session a prompt
  // frame and has no other way to start a workflow.
  it('registers lifecycle handlers and claims only the launch command', async () => {
    const registerCommand = vi.fn();
    const on = vi.fn();
    const eventListeners = new Map<string, Set<(data: unknown) => void>>();
    const pi = {
      events: {
        emit(channel: string, data: unknown) {
          for (const listener of eventListeners.get(channel) ?? []) listener(data);
        },
        on(channel: string, listener: (data: unknown) => void) {
          const listeners = eventListeners.get(channel) ?? new Set<(data: unknown) => void>();
          listeners.add(listener);
          eventListeners.set(channel, listeners);
          return () => listeners.delete(listener);
        },
      },
      getActiveTools: vi.fn(() => []),
      registerCommand,
      registerMessageRenderer: vi.fn(),
      registerShortcut: vi.fn(),
      registerTool: vi.fn(),
      on,
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;

    await workflowExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'workflow-contributions-test');
    const help = createDoomHelpService('workflow-help-test');
    const skills = createDoomSkillSourcesService('workflow-skills-test');
    const providers = connection.root.plugin((context) => {
      context.provide(DOOM_HELP_SERVICE, help);
      context.provide(DOOM_SKILL_SOURCES_SERVICE, skills);
    });
    await providers;

    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(['workflow-launch']);
    expect(on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(help.listContributions()).toEqual([
      expect.objectContaining({
        source: '@agimon-ai/doompi-workflow',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-author-workflow',
            description:
              'Author DoomPi workflow definitions. Use when creating or changing a *.workflow.yml graph, arranging job dependencies and host-executed steps, or deciding how a command requiring a TTY should run.',
          },
          {
            name: 'doompi-use-workflow',
            description:
              'Use DoomPi workflows. Use when discovering or launching workflows, monitoring or controlling asynchronous runs, interpreting terminal notifications, or recovering a failed run safely.',
          },
        ],
      }),
    ]);
    expect(skills.list()).toEqual([
      expect.objectContaining({
        source: '@agimon-ai/doompi-workflow',
        directories: [expect.stringMatching(/[/\\]skills$/u)],
      }),
    ]);

    await providers.dispose();
    expect(help.listContributions()).toEqual([]);
    expect(skills.list()).toEqual([]);

    const replacementHelp = createDoomHelpService('workflow-help-replacement');
    const replacementSkills = createDoomSkillSourcesService('workflow-skills-replacement');
    const replacementProviders = connection.root.plugin((context) => {
      context.provide(DOOM_HELP_SERVICE, replacementHelp);
      context.provide(DOOM_SKILL_SOURCES_SERVICE, replacementSkills);
    });
    await replacementProviders;
    expect(replacementHelp.listContributions()).toHaveLength(1);
    expect(replacementSkills.list()).toHaveLength(1);

    const shutdownCall = on.mock.calls.filter(([event]) => event === 'session_shutdown').at(-1);
    expect(shutdownCall).toBeDefined();
    await shutdownCall?.[1]({}, {});
    expect(replacementHelp.listContributions()).toEqual([]);
    expect(replacementSkills.list()).toEqual([]);
    await replacementProviders.dispose();
    help.dispose();
    skills.dispose();
    replacementHelp.dispose();
    replacementSkills.dispose();
    await connection.dispose();
  });
});

describe('workflow dispatcher bridge', () => {
  it('detects the dispatcher while retaining typed and legacy parent identity', () => {
    expect(
      resolveDispatcherParentSession({
        [SUBAGENT_PARENT_SESSION_ENV]: 'legacy-session',
        ...childProcessContextEnvironment({
          parentSessionId: 'typed-session',
          workingDirectory: '/repo',
          mode: 'agiflow-dispatcher',
        }),
      }),
    ).toBe('typed-session');
    expect(resolveDispatcherParentSession({ [SUBAGENT_PARENT_SESSION_ENV]: 'legacy-session' })).toBe('legacy-session');
    expect(resolveDispatcherParentSession({})).toBeUndefined();
    expect(
      isWorkflowDispatcherProcess(
        childProcessContextEnvironment({
          parentSessionId: 'typed-session',
          workingDirectory: '/repo',
          mode: 'agiflow-dispatcher',
        }),
      ),
    ).toBe(true);
    expect(
      isWorkflowDispatcherProcess({
        PI_SUBAGENT_CHILD_AGENT: 'agiflow-dispatcher',
        [SUBAGENT_PARENT_SESSION_ENV]: 'legacy-session',
      }),
    ).toBe(true);
    expect(isWorkflowDispatcherProcess({ [SUBAGENT_PARENT_SESSION_ENV]: 'legacy-session' })).toBe(false);
  });

  it('passes through tools when no parent session is available', () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    const tool = { name: 'list_workflows' } as Parameters<ExtensionAPI['registerTool']>[0];

    const bridge = createDispatcherBridge(pi, undefined);
    bridge.registerTool(tool);

    expect((bridge as unknown as { events?: unknown }).events).toBeUndefined();
    expect(registerTool).toHaveBeenCalledWith(tool);
  });

  it('does not wrap non-run tools for a parent session', () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    const tool = { name: 'list_workflows' } as Parameters<ExtensionAPI['registerTool']>[0];

    createDispatcherBridge(pi, 'parent-session').registerTool(tool);

    expect(registerTool).toHaveBeenCalledWith(tool);
  });

  it('reads non-function context properties through the parent proxy', async () => {
    let registered: Parameters<ExtensionAPI['registerTool']>[0] | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        registered = tool;
      }),
    } as unknown as ExtensionAPI;
    const bridge = createDispatcherBridge(pi, 'parent-session');
    bridge.registerTool({
      name: 'launch_workflow',
      label: 'Launch',
      description: 'Launch',
      parameters: { type: 'object' },
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => ({
        content: [{ type: 'text', text: `${ctx.sessionManager.getSessionId()}:${String(ctx.cwd)}` }],
        details: undefined,
      }),
    });

    const result = await registered?.execute('call', {}, undefined, undefined, {
      cwd: '/child',
      sessionManager: { getSessionId: () => 'child-session' },
    } as never);

    expect(result?.content[0]).toEqual({ type: 'text', text: 'parent-session:/child' });
  });

  it('attributes launch_workflow calls to the root session', async () => {
    let registered: Parameters<ExtensionAPI['registerTool']>[0] | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        registered = tool;
      }),
    } as unknown as ExtensionAPI;
    const bridge = createDispatcherBridge(pi, 'parent-session', {
      [SUBAGENT_ROOT_SESSION_ENV]: 'root-session',
    });
    bridge.registerTool({
      name: 'launch_workflow',
      label: 'Workflow',
      description: 'Workflow',
      parameters: { type: 'object' },
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => ({
        content: [{ type: 'text', text: ctx.sessionManager.getSessionId() }],
        details: undefined,
      }),
    });

    const result = await registered?.execute('call', {}, undefined, undefined, {
      sessionManager: { getSessionId: () => 'child-session' },
    } as never);

    expect(result?.content[0]).toEqual({ type: 'text', text: 'root-session' });
  });

  it('keeps dispatcher tools limited to list_workflows and launch_workflow', () => {
    const registerTool = vi.fn();
    const setActiveTools = vi.fn();
    const bridge = createDispatcherBridge(
      { registerTool, setActiveTools } as unknown as ExtensionAPI,
      'parent-session',
    );

    bridge.registerTool({ name: 'list_workflows' } as Parameters<ExtensionAPI['registerTool']>[0]);
    bridge.registerTool({ name: 'launch_workflow' } as Parameters<ExtensionAPI['registerTool']>[0]);
    bridge.registerTool({ name: 'workflow_run' } as Parameters<ExtensionAPI['registerTool']>[0]);
    bridge.setActiveTools(['foreign_tool', 'list_workflows', 'launch_workflow', 'workflow_run']);

    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(['list_workflows', 'launch_workflow']);
    expect(setActiveTools).toHaveBeenCalledWith(['foreign_tool', 'list_workflows', 'launch_workflow']);
  });
});

describe('workflow leader contribution', () => {
  it('registers, updates, and disposes a direct UI-hub contribution', () => {
    const contributions: LeaderContribution[] = [];
    const update = vi.fn();
    const dispose = vi.fn();
    const hub = {
      registerLeader(contribution: LeaderContribution) {
        contributions.push(contribution);
        return { update, dispose };
      },
    } as unknown as DoomUiHubService;
    const handle = registerLeaderContribution(hub);

    expect(contributions).toHaveLength(1);
    const firstContribution = contributions[0];
    const group = { key: 'w', label: 'workflows', detail: 'multi-step agent runs', order: 50 };
    expect(firstContribution?.bindings).toEqual([
      // Launching has no menu entry of its own: `SPC w l`'s board launches
      // the row under its cursor with `r`.
      {
        id: 'doom-workflow.catalog',
        path: [group, { key: 'l', label: 'list', detail: 'browse and launch workflows' }],
        action: { name: 'workflow.catalog' },
      },
      {
        id: 'doom-workflow.manage',
        path: [group, { key: 'r', label: 'runs', detail: 'runs in this session' }],
        action: { name: 'workflow.manage' },
      },
      {
        id: 'doom-workflow.enable',
        path: [group, { key: 'e', label: 'enter', detail: 'give the agent workflow tools' }],
        action: { name: 'workflow.enable' },
      },
      // `r` is runs in every space, so recovery moved off it rather than reading
      // as a third flavour of list in the one space that has both.
      {
        id: 'doom-workflow.recover',
        path: [group, { key: 'c', label: 'recover', detail: 'adopt a failed run' }],
        action: { name: 'workflow.recover' },
      },
    ]);

    const registry = new DoomLeaderRegistry();
    registry.register(firstContribution);
    expect(registry.getDiagnostics()).toEqual([]);
    expect(registry.getGroup([])?.options).toContainEqual(
      expect.objectContaining({ key: 'w', label: 'workflows', hasChildren: true }),
    );

    handle.setMode(true);
    expect(update).toHaveBeenCalledWith(workflowLeaderBindings(true));
    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  // One key, and it says which way it flips: a menu printing both an enable and
  // a disable row makes the reader check the mode line to find out which is live.
  it('publishes the way out of the mode in place of the way in', () => {
    const modeEntry = (mode: boolean) => workflowLeaderBindings(mode).find((binding) => binding.path[1]?.key === 'e');

    const group = { key: 'w', label: 'workflows', detail: 'multi-step agent runs', order: 50 };
    expect(workflowLeaderBindings(true).filter((binding) => binding.path[1]?.key === 'e')).toHaveLength(1);
    expect(modeEntry(false)).toEqual({
      id: 'doom-workflow.enable',
      path: [group, { key: 'e', label: 'enter', detail: 'give the agent workflow tools' }],
      action: { name: 'workflow.enable' },
    });
    // The exit tone is what paints this badge apart from the blue enter badge.
    expect(modeEntry(true)).toEqual({
      id: 'doom-workflow.disable',
      path: [group, { key: 'e', label: 'exit', detail: 'take back workflow tools', tone: 'exit' }],
      action: { name: 'workflow.disable' },
    });
  });
});
