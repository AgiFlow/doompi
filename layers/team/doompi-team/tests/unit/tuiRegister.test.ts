import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../src/adapters/agents/types';
import { SUBAGENT_CAPABILITY_CEILING_ENV } from '../../src/exports/env';
import {
  createFleetActionDispatcher,
  registerAgentListCommand,
  registerAgentStatus,
  registerFleetCommand,
  registerSubagentLeaderContribution,
  SUBAGENT_FLEET_COMMAND,
  SUBAGENT_LEADER_SOURCE,
  SUBAGENT_LIST_COMMAND,
} from '../../src/adapters/pi/tui/register';
import type { ManagementActionsContract } from '../../src/adapters/pi/extensions/managementActions';
import { AGENT_PULSE_FRAMES, FLEET_STATUS_KEY } from '../../src/adapters/pi/tui/fleetStatus';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';

const {
  footerDispose,
  footerUpdate,
  openAgentCatalog,
  registerFooterContribution,
  registerLeaderContribution,
  resolveActiveTeamPackageConfig,
} = vi.hoisted(() => ({
  footerDispose: vi.fn(),
  footerUpdate: vi.fn(),
  openAgentCatalog: vi.fn(),
  registerFooterContribution: vi.fn(),
  registerLeaderContribution: vi.fn((_contribution: { bindings: Array<{ path: unknown[] }> }) => ({
    dispose: vi.fn(),
    update: vi.fn(),
  })),
  resolveActiveTeamPackageConfig: vi.fn(),
}));

registerFooterContribution.mockReturnValue({ update: footerUpdate, dispose: footerDispose });

const uiHub = {
  registerConfig: vi.fn(),
  registerFooter: registerFooterContribution,
  registerLeader: registerLeaderContribution,
  registerLeaderActions: vi.fn(),
} as unknown as DoomUiHubService;

vi.mock('../../src/adapters/agents/discovery', () => ({ resolveActiveTeamPackageConfig }));

vi.mock('../../src/adapters/pi/tui/agentCatalog', () => ({ openAgentCatalog }));

class FakeScheduler implements PollSchedulerContract {
  subscriptions: PollSubscription[] = [];
  unregister = vi.fn();

  register(subscription: PollSubscription): () => void {
    this.subscriptions.push(subscription);
    return this.unregister;
  }
  wake(): void {}
  start(): void {}
  stop(): void {}
}

class FakeTracker implements AsyncJobTrackerContract {
  jobs: TrackedAsyncJob[] = [{ runId: 'run-1', status: 'running' }];

  forSession() {
    return this;
  }
  track(): void {}
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return this.jobs;
  }
  get(): TrackedAsyncJob | undefined {
    return undefined;
  }
  reset(): void {}
  start(): void {}
  stop(): void {}
}

function catalogAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: false,
    systemPrompt: `You are ${name}.`,
    source: 'plugin',
    filePath: `/agents/${name}.md`,
    ...overrides,
  };
}

const DOCS_SKILL = {
  name: 'docs',
  path: '/skills/docs/SKILL.md',
  content: '# Docs',
  description: 'Documentation skill',
  source: 'project' as const,
};

describe('registerAgentListCommand', () => {
  beforeEach(() => {
    openAgentCatalog.mockReset();
    resolveActiveTeamPackageConfig.mockReset();
    vi.stubEnv(SUBAGENT_CAPABILITY_CEILING_ENV, '');
  });

  it('snapshots handler-time discovery, skills, Team exclusions, and capability policy into catalog entries', async () => {
    const agents = [
      catalogAgent('worker', {
        tools: ['read', 'write', 'bash'],
        skills: ['docs'],
        inheritSkills: true,
      }),
    ];
    const discover = vi.fn().mockReturnValue({ agents, warnings: [] });
    const resolveSkillsWithFallback = vi.fn().mockReturnValue({ resolved: [DOCS_SKILL], missing: [] });
    const discoverAvailableSkills = vi.fn().mockReturnValue([
      { name: 'docs', source: 'project' },
      { name: 'ambient', source: 'extension' },
    ]);
    const resolve = vi.fn().mockReturnValue({
      version: 2,
      allowedTools: ['read', 'write'],
      allowedExternalProfiles: [],
      denyExtensions: false,
      sources: ['plan-mode'],
    });
    resolveActiveTeamPackageConfig.mockReturnValue({
      config: { excludeTools: ['write'] },
      path: '/workspace/.doom/modes.yaml',
    });
    const registerCommand = vi.fn();
    const pi = { registerCommand } as never;
    registerAgentListCommand(pi, {
      discovery: { discover } as never,
      skills: { resolveSkillsWithFallback, discoverAvailableSkills } as never,
      policies: { resolve } as never,
    });
    const handler = registerCommand.mock.calls[0][1].handler as (args: string, ctx: unknown) => Promise<void>;
    const ctx = { cwd: '/session/cwd' };

    await handler('', ctx);

    expect(registerCommand).toHaveBeenCalledWith(SUBAGENT_LIST_COMMAND, expect.any(Object));
    expect(discover).toHaveBeenCalledWith('/session/cwd', 'both');
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolveActiveTeamPackageConfig).toHaveBeenCalledOnce();
    expect(resolveSkillsWithFallback).toHaveBeenCalledWith(
      ['docs'],
      '/session/cwd',
      '/session/cwd',
      undefined,
      '/session/cwd',
    );
    expect(discoverAvailableSkills).toHaveBeenCalledWith('/session/cwd');
    const entries = openAgentCatalog.mock.calls[0]?.[1];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.resources.tools.effective).toContainEqual(expect.objectContaining({ name: 'read' }));
    expect(entries?.[0]?.resources.tools.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'write', detail: expect.stringContaining('Team package policy') }),
        expect.objectContaining({ name: 'bash', detail: expect.stringContaining('plan-mode') }),
      ]),
    );
    expect(entries?.[0]?.resources.skills.effective).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'docs' }), expect.objectContaining({ name: 'ambient' })]),
    );
    expect(openAgentCatalog).toHaveBeenCalledWith(ctx, entries, {});
  });

  it('keeps a failed agent projection inspectable without blocking other entries or the overlay', async () => {
    const agents = [
      catalogAgent('invalid', { tools: ['grep'], skills: ['docs'] }),
      catalogAgent('valid', { tools: ['grep'] }),
    ];
    const resolveSkillsWithFallback = vi.fn((names: string[]) =>
      names.includes('docs') ? { resolved: [DOCS_SKILL], missing: [] } : { resolved: [], missing: [] },
    );
    const registerCommand = vi.fn();
    const pi = { registerCommand } as never;
    registerAgentListCommand(pi, {
      discovery: { discover: vi.fn().mockReturnValue({ agents, warnings: [] }) } as never,
      skills: {
        resolveSkillsWithFallback,
        discoverAvailableSkills: vi.fn().mockReturnValue([]),
      } as never,
      policies: {
        resolve: vi.fn().mockReturnValue({
          version: 2,
          allowedTools: ['grep'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['plan-mode'],
        }),
      } as never,
    });
    const handler = registerCommand.mock.calls[0][1].handler as (args: string, ctx: unknown) => Promise<void>;
    const ctx = { cwd: '/session/cwd' };

    await expect(handler('', ctx)).resolves.toBeUndefined();

    const entries = openAgentCatalog.mock.calls[0]?.[1];
    expect(entries).toHaveLength(2);
    expect(entries?.[0]?.resources.error).toContain("excludes required tool 'read'");
    expect(entries?.[1]?.resources.error).toBeUndefined();
    expect(openAgentCatalog).toHaveBeenCalledWith(ctx, entries, {});
  });

  it('binds the catalog launcher to the handler-time context', async () => {
    const launchAgent = vi.fn();
    const registerCommand = vi.fn();
    registerAgentListCommand({ registerCommand } as never, {
      discovery: { discover: vi.fn().mockReturnValue({ agents: [catalogAgent('worker')], warnings: [] }) } as never,
      skills: {
        resolveSkillsWithFallback: vi.fn().mockReturnValue({ resolved: [], missing: [] }),
        discoverAvailableSkills: vi.fn().mockReturnValue([]),
      } as never,
      policies: {
        resolve: vi.fn().mockReturnValue({
          version: 2,
          allowedTools: ['read'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: [],
        }),
      } as never,
      launchAgent,
    });
    const handler = registerCommand.mock.calls[0][1].handler as (args: string, ctx: unknown) => Promise<void>;
    const ctx = { cwd: '/session/cwd' };

    await handler('', ctx);
    const request = { agent: 'worker', task: 'ship it', context: 'fresh' as const };
    openAgentCatalog.mock.calls[0]?.[2]?.launchAgent?.(request);

    expect(launchAgent).toHaveBeenCalledWith(ctx, request);
  });
});

describe('registerFleetCommand', () => {
  it('registers the fleet command under the same name the leader-space overlay (G10) will target', () => {
    const registerCommand = vi.fn();
    const pi = { registerCommand } as never;
    registerFleetCommand(pi, { scheduler: new FakeScheduler(), tracker: new FakeTracker() });
    expect(registerCommand).toHaveBeenCalledWith(SUBAGENT_FLEET_COMMAND, expect.any(Object));
  });

  it('does not replace the compact footer status while the overlay is open', async () => {
    const registerCommand = vi.fn();
    const pi = { registerCommand } as never;
    registerFleetCommand(pi, { scheduler: new FakeScheduler(), tracker: new FakeTracker() });
    const handler = registerCommand.mock.calls[0][1].handler as (args: string, ctx: unknown) => Promise<void>;

    const setStatus = vi.fn();
    const ctx = {
      sessionManager: {
        getSessionFile: () => '/sessions/session-under-test.jsonl',
        getSessionId: () => 'session-under-test',
      },
      ui: {
        setStatus,
        custom: () => Promise.reject(new Error('overlay closed unexpectedly')),
      },
    };

    await expect(handler('', ctx)).rejects.toThrow('overlay closed unexpectedly');
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('registerAgentStatus', () => {
  it('publishes active counts, clears zero counts, and disposes its poller', () => {
    const handlers = new Map<string, (event: unknown, ctx: never) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: never) => void) => handlers.set(event, handler),
    } as never;
    const scheduler = new FakeScheduler();
    const tracker = new FakeTracker();
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => 'session-under-test' },
      ui: { setStatus },
    } as never;

    const dispose = registerAgentStatus(pi, uiHub, { scheduler, tracker });
    handlers.get('session_start')?.({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(FLEET_STATUS_KEY, 'Agents ○');
    expect(footerUpdate).toHaveBeenLastCalledWith({
      fullText: 'Agents ○',
      compactText: 'A ○',
      fullSegments: [{ text: 'Agents ' }, { text: '○', color: agentIdentityColor('run-1') }],
      compactSegments: [{ text: 'A ' }, { text: '○', color: agentIdentityColor('run-1') }],
    });

    tracker.jobs = [{ runId: 'run-1', status: 'completed' }];
    expect(scheduler.subscriptions[0]?.run()).toBe(true);
    expect(setStatus).toHaveBeenLastCalledWith(FLEET_STATUS_KEY, 'Agents ✓');
    expect(footerUpdate).toHaveBeenLastCalledWith({
      fullText: 'Agents ✓',
      compactText: 'A ✓',
      fullSegments: [{ text: 'Agents ' }, { text: '✓', color: agentIdentityColor('run-1') }],
      compactSegments: [{ text: 'A ' }, { text: '✓', color: agentIdentityColor('run-1') }],
    });

    dispose();
    expect(scheduler.unregister).toHaveBeenCalledOnce();
    expect(footerDispose).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith(FLEET_STATUS_KEY, undefined);
  });

  it('publishes every pulse frame for actively working agents', async () => {
    footerUpdate.mockClear();
    const handlers = new Map<string, (event: unknown, ctx: never) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: never) => void) => handlers.set(event, handler),
    } as never;
    const scheduler = new FakeScheduler();
    const tracker = new FakeTracker();
    tracker.jobs = [{ runId: 'run-pulse', agent: 'researcher', status: 'running', activityState: 'working' }];
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => 'session-under-test' },
      ui: { setStatus: vi.fn() },
    } as never;

    const dispose = registerAgentStatus(pi, uiHub, { scheduler, tracker });
    handlers.get('session_start')?.({}, ctx);
    await scheduler.subscriptions[0]?.run();
    await scheduler.subscriptions[0]?.run();
    await scheduler.subscriptions[0]?.run();

    const frames = footerUpdate.mock.calls
      .map(([value]) => (value as { compactText?: string } | undefined)?.compactText)
      .filter((value): value is string => Boolean(value));
    expect(new Set(frames)).toEqual(new Set(AGENT_PULSE_FRAMES.map((glyph) => `A ${glyph}`)));
    dispose();
  });
});

describe('createFleetActionDispatcher', () => {
  it('routes interrupt and stop controls through management actions', async () => {
    const management = {
      interrupt: vi.fn(),
      stop: vi.fn(),
      steer: vi.fn(),
    } as unknown as ManagementActionsContract;
    const dispatch = createFleetActionDispatcher(management, new FakeTracker());

    await expect(dispatch({ action: 'interrupt', id: 'run-1' })).resolves.toEqual({ status: 'requested' });
    await expect(dispatch({ action: 'stop', id: 'run-1' })).resolves.toEqual({ status: 'requested' });
    expect(management.interrupt).toHaveBeenCalledWith('run-1', undefined);
    expect(management.stop).toHaveBeenCalledWith('run-1', undefined);
  });

  it('returns the correlated steering acknowledgment', async () => {
    const management = {
      interrupt: vi.fn(),
      stop: vi.fn(),
      steer: vi.fn().mockResolvedValue({ state: 'delivered', message: 'accepted' }),
    } as unknown as ManagementActionsContract;

    await expect(
      createFleetActionDispatcher(
        management,
        new FakeTracker(),
      )({
        action: 'steer',
        id: 'run-1',
        message: 'focus here',
      }),
    ).resolves.toEqual({ status: 'delivered', detail: 'accepted' });
    expect(management.steer).toHaveBeenCalledWith('run-1', 'focus here');
  });

  it('rejects controls for a run outside the current Pi session', async () => {
    const management = { stop: vi.fn() } as unknown as ManagementActionsContract;

    await expect(
      createFleetActionDispatcher(management, new FakeTracker())({ action: 'stop', id: 'run-from-other-session' }),
    ).rejects.toThrow(/No current-session run/);
    expect(management.stop).not.toHaveBeenCalled();
  });
});

describe('registerSubagentLeaderContribution', () => {
  beforeEach(() => {
    registerLeaderContribution.mockClear();
  });

  it('publishes stable nested SPC a bindings for the catalog and fleet', () => {
    const unregister = vi.fn();
    registerLeaderContribution.mockReturnValueOnce({ dispose: unregister, update: vi.fn() });

    const dispose = registerSubagentLeaderContribution(uiHub);
    expect(SUBAGENT_LEADER_SOURCE).toBe('@agimon-ai/doompi-team');
    expect(registerLeaderContribution).toHaveBeenCalledWith({
      source: SUBAGENT_LEADER_SOURCE,
      bindings: [
        {
          id: 'subagents.fleet',
          path: [
            { key: 'a', label: 'agents', detail: 'subagent resources and runs', order: 15 },
            { key: 'r', label: 'runs', detail: 'runs in this session' },
          ],
          command: { name: SUBAGENT_FLEET_COMMAND },
        },
        {
          id: 'subagents.list',
          path: [
            { key: 'a', label: 'agents', detail: 'subagent resources and runs', order: 15 },
            { key: 'l', label: 'list', detail: 'agents available here' },
          ],
          command: { name: SUBAGENT_LIST_COMMAND },
        },
      ],
    });

    const bindings = registerLeaderContribution.mock.calls[0]?.[0].bindings;
    expect(bindings?.[0]?.path[0]).toEqual(bindings?.[1]?.path[0]);
    dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });
});
