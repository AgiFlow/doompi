import { childProcessContextEnvironment } from '@agimon-ai/doompi-extension-contracts/child-process';
import { createPiTestHost, type PiTestHost } from '@agimon-ai/doompi-extension-contracts/testing';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  leaderDispose: vi.fn(),
  leaderSetMode: vi.fn(),
  registerLeader: vi.fn(),
  createCordisRoot: (): unknown => undefined,
}));

const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => ({
    root: mocks.createCordisRoot(),
    runtime: { abiVersion: 1, generation: 'workflow-test', hostId: 'workflow-test', mode: 'composed' },
    dispose: async () => undefined,
  }),
}));

vi.mock('../src/adapters/pi/leader.ts', () => ({
  registerLeaderContribution: mocks.registerLeader,
}));
vi.mock('../src/adapters/pi/workflow/piExtension.ts', () => ({
  installWorkflowPiRuntime: (options: unknown) => (pi: ExtensionAPI) => mocks.install(pi, options),
}));

import { workflowExtension } from '../src/adapters/pi/extension.ts';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

/**
 * Pi types `parameters` as TypeBox, but this package builds its real schemas
 * with `z.toJSONSchema`, so the test says what the package says.
 */
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters'];

function tool(name: string, execute = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: name }] })) {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object' } as unknown as ToolParameters,
    execute,
  };
}

/** Everything the extension told the given session, in order. */
function notified(host: PiTestHost, sessionId: string): string[] {
  return host.notifications.filter((entry) => entry.sessionId === sessionId).map(({ message }) => message);
}

let host: PiTestHost;

beforeEach(() => {
  vi.clearAllMocks();
  host = createPiTestHost({ cwd: '/repo' });
  mocks.createCordisRoot = () => {
    const root = new Context();
    root.provide(DOOM_UI_HUB_SERVICE, {} as DoomUiHubService);
    cordisRoots.push(root);
    return root;
  };
  mocks.registerLeader.mockReturnValue({ dispose: mocks.leaderDispose, setMode: mocks.leaderSetMode });
  mocks.install.mockImplementation(() => ({ dispose: vi.fn().mockResolvedValue(undefined) }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await host.dispose();
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
});

describe('standard workflow factory lifecycle', () => {
  it('creates independent roots when invoked twice on one Pi host', async () => {
    const executes = [vi.fn().mockResolvedValue({ content: [] }), vi.fn().mockResolvedValue({ content: [] })];
    let installation = 0;
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      pi.registerTool(tool('launch_workflow', executes[installation++]));
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });

    await workflowExtension(host.pi);
    await workflowExtension(host.pi);
    expect(host.tools).toHaveLength(2);

    const firstShutdown = host.handlers('session_shutdown')[0];
    await firstShutdown?.({ type: 'session_shutdown' }, host.context({ sessionId: 'session' }));
    await host.tools[0]?.execute('old', {}, undefined, undefined, host.context({ sessionId: 'session' }));
    await host.tools[1]?.execute('new', {}, undefined, undefined, host.context({ sessionId: 'session' }));

    expect(executes[0]).not.toHaveBeenCalled();
    expect(executes[1]).toHaveBeenCalledOnce();
  });

  it('awaits one idempotent Cordis disposal for repeated shutdown callbacks', async () => {
    const gate = deferred();
    const disposeRuntime = vi.fn(() => gate.promise);
    mocks.install.mockReturnValue({ dispose: disposeRuntime });
    await workflowExtension(host.pi);

    const shutdown = host.handlers('session_shutdown').at(-1);
    const context = host.context({ sessionId: 'session' });
    const first = shutdown?.({ type: 'session_shutdown' }, context) as Promise<void>;
    const second = shutdown?.({ type: 'session_shutdown' }, context) as Promise<void>;
    await Promise.resolve();
    expect(disposeRuntime).toHaveBeenCalledOnce();

    gate.resolve();
    await Promise.all([first, second]);
    expect(mocks.leaderDispose).toHaveBeenCalledOnce();
  });

  it('fences callbacks and contexts from a replaced session generation', async () => {
    const gate = deferred();
    let starts = 0;
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      pi.on('session_start', async (_event, context) => {
        starts += 1;
        if (starts === 1) await gate.promise;
        context.ui.notify(`session:${context.sessionManager.getSessionId()}`, 'info');
        pi.sendMessage({
          customType: 'workflow-test',
          content: context.sessionManager.getSessionId(),
          display: true,
        });
      });
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });
    await workflowExtension(host.pi);

    const start = host.handlers('session_start').at(-1);
    const oldStart = start?.(
      { type: 'session_start', reason: 'startup' },
      host.context({ sessionId: 'old' }),
    ) as Promise<void>;
    await start?.({ type: 'session_start', reason: 'new' }, host.context({ sessionId: 'next' }));
    gate.resolve();
    await oldStart;

    expect(notified(host, 'old')).toEqual([]);
    expect(notified(host, 'next')).toEqual(['session:next']);
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]?.message).toMatchObject({ content: 'next' });
  });

  it('makes partially registered callbacks inert when installation throws', async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      pi.registerTool(tool('launch_workflow', execute));
      throw new Error('installation failed');
    });

    await expect(workflowExtension(host.pi)).rejects.toThrow('installation failed');
    const result = await host.tools[0]?.execute('stale', {}, undefined, undefined, host.context());

    expect(execute).not.toHaveBeenCalled();
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining('no longer active') });
  });

  it('fences retained runtime capabilities after shutdown begins', async () => {
    const operation = deferred();
    const update = vi.fn();
    const observations: unknown[] = [];
    let installedPi: ExtensionAPI | undefined;
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      installedPi = pi;
      pi.registerTool(
        tool(
          'launch_workflow',
          vi.fn(async (_id, _params, _signal, onUpdate, context: ExtensionContext) => {
            await operation.promise;
            observations.push(context.ui.theme);
            observations.push(await context.ui.confirm('Workflow', 'Continue?'));
            observations.push(await context.ui.select('Workflow', ['continue']));
            context.ui.notify('late notification', 'info');
            onUpdate?.({ content: [{ type: 'text', text: 'late update' }], details: undefined });
            return { content: [{ type: 'text', text: 'completed' }], details: undefined };
          }),
        ),
      );
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });
    await workflowExtension(host.pi);
    if (!installedPi) throw new Error('workflow runtime was not installed');

    const context = host.context({ sessionId: 'fenced' });
    const execution = host.tools[0]?.execute('call', {}, undefined, update, context);
    await vi.waitFor(() => expect(host.tools[0]).toBeDefined());
    const shutdown = host.handlers('session_shutdown').at(-1);
    await shutdown?.({ type: 'session_shutdown' }, context);
    operation.resolve();

    await expect(execution).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('no longer active') }],
    });
    expect(observations).toEqual([undefined, false, undefined]);
    expect(notified(host, 'fenced')).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    installedPi.registerTool(tool('late-tool'));
    installedPi.setActiveTools(['late-tool']);

    expect(installedPi.getActiveTools()).toEqual([]);
    await expect(installedPi.exec('late-command', [])).resolves.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no longer active'),
    });
    expect(host.tools.map(({ name }) => name)).toEqual(['launch_workflow']);
  });

  it('folds dispatcher filtering and root ownership into the same factory', async () => {
    const environment = childProcessContextEnvironment({
      parentSessionId: 'parent-session',
      workingDirectory: '/repo',
      mode: 'agiflow-dispatcher',
    });
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      pi.registerTool(tool('list_workflows'));
      pi.registerTool(
        tool(
          'launch_workflow',
          vi.fn(async (_id, _params, _signal, _onUpdate, context: ExtensionContext) => ({
            content: [{ type: 'text', text: context.sessionManager.getSessionId() }],
          })),
        ),
      );
      pi.registerTool(tool('workflow_run'));
      pi.setActiveTools(['list_workflows', 'launch_workflow', 'workflow_run']);
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });

    await workflowExtension(host.pi);

    expect(host.tools.map(({ name }) => name)).toEqual(['list_workflows', 'launch_workflow']);
    expect(mocks.registerLeader).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initialMode: true }));
    const launch = host.tool('launch_workflow');
    const result = await launch?.execute(
      'call',
      {},
      undefined,
      undefined,
      host.context({ sessionId: 'child-session' }),
    );
    expect(result?.content[0]).toEqual({ type: 'text', text: 'parent-session' });
  });
});
