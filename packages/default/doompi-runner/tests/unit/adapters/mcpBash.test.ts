import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it, vi } from 'vitest';

import mcpBash from '../../../src/extensions/workspaces/sessions/(backend)/tool/bash.mcp';
import { createHeadlessBashTool } from '../../../src/services/headless';
import type { BashRunRequest, BashRunResult } from '../../../src/types/bashRunService';

const execution = {
  cwd: '/repo',
  repoRoot: '/repo',
  sessionId: 'mcp-session',
  environment: {},
  selection: { majorMode: 'copilot', activeLayers: ['runner'], domains: [], state: {} },
  client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
  session: {
    entries: () => [],
    appendCustomEntry: vi.fn(),
    prompt: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
  },
  shutdown: vi.fn(),
} as unknown as DoomHeadlessExecutionContext;

const completed: BashRunResult = {
  kind: 'completed',
  id: 'run-1',
  name: 'pwd',
  output: '/repo',
  exitCode: 0,
  signal: null,
  logPath: '/tmp/mcp-session/pwd.log',
  backend: 'native',
};

function factory(context: DoomMcpPluginContext) {
  return (mcpBash as (context: DoomMcpPluginContext) => ReturnType<typeof createHeadlessBashTool>)(context);
}

function servicesFor(tool: ReturnType<typeof createHeadlessBashTool>): DoomMcpPluginContext['services'] {
  return { get: <T>() => ({ remoteTool: tool }) as unknown as T };
}

describe('MCP Bash adapter', () => {
  it('uses the session-owned runner tool', async () => {
    const run = vi.fn(async (_request: BashRunRequest) => completed);
    const ownedTool = createHeadlessBashTool({ run });
    const controller = new AbortController();
    const tool = factory({
      execution,
      services: servicesFor(ownedTool),
      selection: { read: () => execution.selection, change: vi.fn() },
      signal: controller.signal,
      refresh: () => {},
      loadContext: () => {
        throw new Error('Not used by this test.');
      },
    });

    await tool.execute('call', { command: 'pwd' }, undefined, undefined, execution);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'pwd', sessionId: 'mcp-session' }));
  });

  it('tells the remote caller to poll a promoted runner', async () => {
    const run = vi.fn(async (): Promise<BashRunResult> => ({
      kind: 'promoted',
      id: 'runner-7',
      name: 'build',
      pid: 4,
      logPath: '/tmp/build.log',
      backend: 'native',
      reason: 'requested',
    }));
    const tool = factory({
      execution,
      services: servicesFor(createHeadlessBashTool({ run })),
      selection: { read: () => execution.selection, change: vi.fn() },
      signal: new AbortController().signal,
      refresh: () => {},
      loadContext: () => {
        throw new Error('Not used by this test.');
      },
    });

    const result = await tool.execute('call', { command: 'make', background: true }, undefined, undefined, execution);

    expect(result.content.at(-1)).toEqual({
      type: 'text',
      text: expect.stringContaining('`doom-runner status runner-7`'),
    });
    expect(JSON.stringify(result.content)).toContain('`doom-runner logs runner-7 --lines 100`');
  });

  it('rejects calls after the MCP surface has closed', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = factory({
      execution,
      services: servicesFor(createHeadlessBashTool({ run: vi.fn() })),
      selection: { read: () => execution.selection, change: vi.fn() },
      signal: controller.signal,
      refresh: () => {},
      loadContext: () => {
        throw new Error('Not used by this test.');
      },
    });

    await expect(tool.execute('call', { command: 'pwd' }, undefined, undefined, execution)).rejects.toThrow(
      'Operation aborted',
    );
  });

  it('fails before launching when the runner session service is unavailable', () => {
    expect(() =>
      factory({
        execution,
        services: { get: <T>() => undefined as T | undefined },
        selection: { read: () => execution.selection, change: vi.fn() },
        signal: new AbortController().signal,
        refresh: () => {},
        loadContext: () => {
          throw new Error('Not used by this test.');
        },
      }),
    ).toThrow('Runner session service is unavailable.');
  });
});
