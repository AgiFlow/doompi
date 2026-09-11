import type { Context } from '@deepseek-ai/cordis';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { sessionConfigEnvironment } from '../src/adapters/process/sessionConfig.ts';

const runtimeState = vi.hoisted(() => ({
  startError: undefined as unknown,
  services: undefined as
    | {
        clientManager: {
          ensureConnected: ReturnType<typeof vi.fn>;
        };
      }
    | undefined,
}));

vi.mock('../src/adapters/node/mcpRuntime.ts', () => ({
  McpRuntimeOwner: class {
    async start(options: {
      onAuthorizationUrl: (url: URL, serverName: string) => void;
      onServerStateChange: (change: { serverName: string; state: string }) => void;
    }): Promise<void> {
      if (runtimeState.startError !== undefined) throw runtimeState.startError;
      options.onAuthorizationUrl(new URL('https://mcp.example/authorize'), 'example');
      options.onServerStateChange({ serverName: 'example', state: 'connected' });
    }
    async dispose(): Promise<void> {}
    getServices() {
      return runtimeState.services;
    }
  },
}));

import { mcpHeadlessFacet } from '../src/adapters/headless/facet.ts';

function contextFor(host: DoomHeadlessHostService): Context {
  return {
    get(name: string) {
      return name === DOOM_HEADLESS_HOST_SERVICE ? host : undefined;
    },
  } as unknown as Context;
}

function execution(environment: Readonly<Record<string, string | undefined>> = {}): DoomHeadlessExecutionContext {
  return {
    cwd: '/tmp',
    repoRoot: '/tmp',
    sessionId: 'mcp-headless-test',
    environment,
    client: {
      notify: vi.fn(),
      request: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as DoomHeadlessExecutionContext;
}

describe('MCP headless facet', () => {
  it('exposes config, status, authorization, and safe pre-runtime tool behavior', async () => {
    const resources: DoomHeadlessResource[] = [];
    const activities: DoomHeadlessActivity[] = [];
    const commands: DoomHeadlessCommand[] = [];
    const tools: DoomHeadlessTool[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const register = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return register();
      },
      registerActivity: (activity: DoomHeadlessActivity) => {
        activities.push(activity);
        return register();
      },
      registerCommand: (command: DoomHeadlessCommand) => {
        commands.push(command);
        return register();
      },
      registerTool: (tool: DoomHeadlessTool) => {
        tools.push(tool);
        return register();
      },
    } as unknown as DoomHeadlessHostService;
    const close = mcpHeadlessFacet.apply(contextFor(host));
    const resource = resources[0];
    const activity = activities[0];
    const command = commands[0];
    const tool = tools[0];
    if (!resource || !activity || !command || !tool) throw new Error('MCP headless registrations were not created');

    const testExecution = execution();
    expect(await resource.read(testExecution)).toContain('"enabled": true');
    await command.execute('', testExecution);
    expect(testExecution.client.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'DoomPi MCP', level: 'info' }),
    );

    vi.mocked(testExecution.client.request).mockResolvedValue('https://mcp.example/authorize');
    await command.execute('auth example', testExecution);
    expect(testExecution.client.notify).toHaveBeenCalledWith({
      body: 'MCP authorization received for example.',
      level: 'info',
    });

    vi.mocked(testExecution.client.request).mockResolvedValue(undefined);
    await command.execute('auth', testExecution);
    expect(testExecution.client.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Authorize MCP server' }),
    );
    await command.execute('unexpected', testExecution);
    expect(testExecution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'DoomPi MCP', level: 'warning' }),
    );
    const result = await tool.execute(
      'mcp-use-1',
      { server: 'example', tool: 'status', arguments: {} },
      undefined,
      undefined,
      testExecution,
    );
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('not started') }] });

    const callTool = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        { type: 'structured', value: 1 },
      ],
      isError: true,
    });
    const ensureConnected = vi.fn().mockResolvedValue({ callTool });
    runtimeState.services = { clientManager: { ensureConnected } };
    const stop = await activity.start(testExecution);
    expect(testExecution.client.notify).toHaveBeenCalledWith({
      title: 'Authorize MCP server example',
      body: 'https://mcp.example/authorize',
      level: 'warning',
    });
    expect(testExecution.client.setStatus).toHaveBeenCalledWith('doompi-mcp', 'example: connected');
    const success = await tool.execute(
      'mcp-use-2',
      { server: 'example', tool: 'status', arguments: { verbose: true } },
      undefined,
      undefined,
      testExecution,
    );
    expect(success).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        { type: 'text', text: '{"type":"structured","value":1}' },
      ],
      details: expect.objectContaining({ isError: true }),
    });

    ensureConnected.mockRejectedValueOnce(new Error('connection failed'));
    await expect(
      tool.execute('mcp-use-3', { server: 'example', tool: 'status' }, undefined, undefined, testExecution),
    ).resolves.toMatchObject({ isError: true, content: [{ text: 'connection failed' }] });

    await stop();
    expect(testExecution.client.setStatus).toHaveBeenCalledWith('doompi-mcp', undefined);

    runtimeState.startError = new Error('startup failed');
    const stopFailedRuntime = await activity.start(testExecution);
    expect(testExecution.client.notify).toHaveBeenLastCalledWith({
      title: 'DoomPi MCP unavailable',
      body: 'startup failed',
      level: 'warning',
    });
    await stopFailedRuntime();
    runtimeState.startError = undefined;

    close();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('reads each session MCP configuration from its admitted environment', async () => {
    const resources: DoomHeadlessResource[] = [];
    const register = () => ({ dispose: vi.fn() });
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return register();
      },
      registerActivity: vi.fn(() => register()),
      registerCommand: vi.fn(() => register()),
      registerTool: vi.fn(() => register()),
    } as unknown as DoomHeadlessHostService;
    const close = mcpHeadlessFacet.apply(contextFor(host));
    const resource = resources[0];
    if (!resource) throw new Error('MCP config resource was not registered');

    const first = execution(sessionConfigEnvironment({ repoRoot: '/first-repo', stagingDirectory: '/tmp/first-mcp' }));
    const second = execution(
      sessionConfigEnvironment({ repoRoot: '/second-repo', stagingDirectory: '/tmp/second-mcp' }),
    );

    expect(JSON.parse(await resource.read(first))).toMatchObject({ repoRoot: '/first-repo' });
    expect(JSON.parse(await resource.read(second))).toMatchObject({ repoRoot: '/second-repo' });
    close?.();
  });
});
