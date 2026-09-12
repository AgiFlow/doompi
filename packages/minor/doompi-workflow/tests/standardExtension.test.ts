import {
  childProcessContextEnvironment,
  SUBAGENT_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-extension-contracts/child-process';
import { createPiTestHost, type PiTestHost } from '@agimon-ai/doompi-extension-contracts/testing';
import {
  createDoomToolSurface,
  DOOM_TOOL_SURFACE_SERVICE,
  type DoomToolSurfaceService,
} from '@agimon-ai/doompi-extension-contracts/tool-surface';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  leaderDispose: vi.fn(),
  leaderSetMode: vi.fn(),
  registerLeader: vi.fn(),
  createCordisRoot: (): Context => new Context(),
}));

const cordisRoots: Context[] = [];

vi.mock('../src/tui/leader', () => ({
  registerLeaderContribution: mocks.registerLeader,
}));
vi.mock('../src/tui/workflowRuntime', () => ({
  createWorkflowPiRuntime: (pi: ExtensionAPI, options: unknown) => mocks.install(pi, options),
}));

vi.mock('../src/tools/workflowTools', () => ({
  createWorkflowTools: (tools: unknown) => tools,
}));

import { workflowExtension } from '../src/extensions/pi';
import type { WorkflowPiRuntime } from '../src/tui/workflowRuntime';

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

interface WorkflowRuntimeFixture extends Omit<WorkflowPiRuntime, 'toolDependencies'> {
  toolDependencies: ReturnType<typeof tool>[];
}

function runtime(overrides: Partial<WorkflowRuntimeFixture> = {}): WorkflowRuntimeFixture {
  return {
    toolDependencies: [],
    commands: [],
    waitForReadiness: async () => undefined,
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function install(): Promise<Context> {
  const root = mocks.createCordisRoot();
  await workflowExtension.install(root, host.pi);
  return root;
}

/** Everything the extension told the given session, in order. */
function notified(host: PiTestHost, sessionId: string): string[] {
  return host.notifications.filter((entry) => entry.sessionId === sessionId).map(({ message }) => message);
}

let host: PiTestHost;
let toolSurface: DoomToolSurfaceService | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // A real subagent shell exports this, and it would otherwise decide the root
  // session these tests are asserting on.
  vi.stubEnv(SUBAGENT_ROOT_SESSION_ENV, '');
  host = createPiTestHost({ cwd: '/repo' });
  toolSurface = undefined;
  mocks.createCordisRoot = () => {
    const root = new Context();
    root.provide(DOOM_UI_HUB_SERVICE, {} as DoomUiHubService);
    // The surface is the session's, not the package's, so the fixture owns it
    // exactly the way the composed host does.
    const surface = createDoomToolSurface({
      generation: 'workflow-test',
      allTools: () => host.pi.getAllTools().map((entry) => entry.name),
      activeTools: () => host.pi.getActiveTools(),
      setActiveTools: (names) => host.pi.setActiveTools([...names]),
    });
    toolSurface = surface;
    root.provide(DOOM_TOOL_SURFACE_SERVICE, surface);
    root.effect(() => () => surface.dispose(), 'workflow-test-tool-surface');
    cordisRoots.push(root);
    return root;
  };
  mocks.registerLeader.mockReturnValue({ dispose: mocks.leaderDispose, setMode: mocks.leaderSetMode });
  mocks.install.mockImplementation(() => runtime());
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
    mocks.install.mockImplementation(() => {
      return runtime({ toolDependencies: [tool('launch_workflow', executes[installation++])] });
    });

    const firstRoot = await install();
    await install();
    expect(host.tools).toHaveLength(2);

    await firstRoot.fiber.dispose();
    await expect(
      host.tools[0]?.execute('old', {}, undefined, undefined, host.context({ sessionId: 'session' })),
    ).rejects.toThrow();
    await host.tools[1]?.execute('new', {}, undefined, undefined, host.context({ sessionId: 'session' }));

    expect(executes[0]).not.toHaveBeenCalled();
    expect(executes[1]).toHaveBeenCalledOnce();
  });

  it('awaits one idempotent Cordis disposal for repeated host shutdown requests', async () => {
    const gate = deferred();
    const disposeRuntime = vi.fn(() => gate.promise);
    mocks.install.mockReturnValue(runtime({ dispose: disposeRuntime }));
    const root = await install();

    const first = root.fiber.dispose();
    const second = root.fiber.dispose();
    await vi.waitFor(() => expect(disposeRuntime).toHaveBeenCalledOnce());

    gate.resolve();
    await Promise.all([first, second]);
    expect(mocks.leaderDispose).toHaveBeenCalledOnce();
  });

  it('fences callbacks and contexts from a replaced session generation', async () => {
    const gate = deferred();
    let starts = 0;
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      return runtime({
        events: {
          session_start: async (_event: unknown, context: ExtensionContext) => {
            starts += 1;
            if (starts === 1) await gate.promise;
            context.ui.notify(`session:${context.sessionManager.getSessionId()}`, 'info');
            pi.sendMessage({
              customType: 'workflow-test',
              content: context.sessionManager.getSessionId(),
              display: true,
            });
          },
        },
      });
    });
    await install();

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

  it('makes earlier tool callbacks inert when later registration throws', async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    mocks.install.mockReturnValue(runtime({ toolDependencies: [tool('launch_workflow', execute), tool('broken')] }));
    const register = host.pi.registerTool.bind(host.pi);
    vi.spyOn(host.pi, 'registerTool').mockImplementation((definition) => {
      if (definition.name === 'broken') throw new Error('installation failed');
      register(definition);
    });
    await expect(install()).rejects.toThrow('installation failed');
    await expect(host.tools[0]?.execute('stale', {}, undefined, undefined, host.context())).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fences retained runtime capabilities after shutdown begins', async () => {
    const operation = deferred();
    const update = vi.fn();
    const observations: unknown[] = [];
    let installedPi: ExtensionAPI | undefined;
    mocks.install.mockImplementation((pi: ExtensionAPI) => {
      installedPi = pi;
      return runtime({
        toolDependencies: [
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
        ],
      });
    });
    const root = await install();
    if (!installedPi) throw new Error('workflow runtime was not installed');

    const context = host.context({ sessionId: 'fenced' });
    const execution = host.tools[0]?.execute('call', {}, undefined, update, context);
    await vi.waitFor(() => expect(host.tools[0]).toBeDefined());
    await root.fiber.dispose();
    operation.resolve();

    await expect(execution).rejects.toThrow('no longer active');
    expect(observations).toEqual([undefined, false, undefined]);
    expect(notified(host, 'fenced')).toEqual([]);
    expect(update).not.toHaveBeenCalled();
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
    mocks.install.mockImplementation(() => {
      return runtime({
        toolDependencies: [
          tool('list_workflows'),
          tool(
            'launch_workflow',
            vi.fn(async (_id, _params, _signal, _onUpdate, context: ExtensionContext) => ({
              content: [{ type: 'text', text: context.sessionManager.getSessionId() }],
            })),
          ),
          tool('workflow_run'),
        ],
      });
    });

    await install();

    expect(host.tools.map(({ name }) => name)).toEqual(['list_workflows', 'launch_workflow']);
    // Registered behind the bridge's back, so only the restriction can hide it.
    host.pi.registerTool(tool('workflow_run'));
    await vi.waitFor(() => expect(toolSurface?.active()).toContain('list_workflows'));
    toolSurface?.refresh();
    expect(toolSurface?.active()).toEqual(['list_workflows', 'launch_workflow']);
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
