import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DoomHeadlessSession, DoomHeadlessTool } from '../../../../../src/exports/headless';
import type { DoomMcpPluginContext } from '../../../../../src/exports/mcpFacet';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '../../../../../src/exports/notification';
import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test model',
  provider: 'test-provider',
  api: 'test-api',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65_536,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const cleanup: Array<() => Promise<void> | void> = [];

async function fixture(mcpPlugins: Parameters<typeof createHeadlessSessionHost>[0]['mcpPlugins'] = []): Promise<{
  host: Awaited<ReturnType<typeof createHeadlessSessionHost>>;
  context: Context;
  session: DoomHeadlessSession;
  runtime: Awaited<ReturnType<typeof createHeadlessSessionHost>>['runtime'];
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-session-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'outside repository');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'inside repository');
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }),
  );
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
    getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    getModels: () => [model],
    getAvailable: async () => [model],
  } as unknown as ModelRuntime);
  const context = new Context();
  const host = await createHeadlessSessionHost({
    cwd,
    repoRoot: cwd,
    sessionId: 'headless-session-mapping',
    sessionName: 'Headless session mapping',
    agentArgs: [],
    environment: {},
    candidates: [],
    mcpPlugins,
    piExtensions: false,
    selection: { majorMode: 'test', activeLayers: [], domains: [], state: {} },
  });
  host.prepareFacets(context);
  cleanup.push(async () => {
    await host.dispose();
    await context.fiber.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { host, context, session: host.host!.context.session, runtime: host.runtime };
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('headless session facet surface', () => {
  it('maps prompt and admitPrompt deliveries onto the runtime', async () => {
    const { session, runtime } = await fixture();
    const prompt = vi.spyOn(runtime, 'prompt').mockResolvedValue(undefined);
    const steer = vi.spyOn(runtime, 'steer').mockResolvedValue(undefined);
    const followUp = vi.spyOn(runtime, 'followUp').mockResolvedValue(undefined);
    const submitPrompt = vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.resolve() });

    // prompt awaits the turn, so a streaming delivery only enqueues into a running turn.
    await session.prompt('steered', 'steer');
    await session.prompt('queued', 'followUp');
    await session.prompt('plain');
    // admitPrompt returns at admission, and 'steer' also wakes an idle agent.
    await session.admitPrompt!('admitted steer', 'steer');
    // followUp stays enqueue-only: voiceServer/index.ts:120 asks for 'followUp' while idle whenever
    // a capture is queued, so routing it through submitPrompt would start an unrequested turn.
    await session.admitPrompt!('admitted follow up', 'followUp');
    await session.admitPrompt!('admitted plain');

    expect(steer).toHaveBeenCalledExactlyOnceWith('steered');
    expect(followUp.mock.calls).toEqual([['queued'], ['admitted follow up']]);
    expect(prompt).toHaveBeenCalledExactlyOnceWith('plain');
    expect(submitPrompt).toHaveBeenNthCalledWith(1, 'admitted steer', undefined, 'steer');
    expect(submitPrompt).toHaveBeenNthCalledWith(2, 'admitted plain', undefined, undefined);
    expect(submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('reports an admitted prompt that fails after admission to the operator', async () => {
    const { session, runtime } = await fixture();
    vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.reject(new Error('turn failed')) });
    const appendCustomEntry = vi.spyOn(runtime, 'appendCustomEntry').mockResolvedValue('entry');

    await session.admitPrompt!('admitted');
    await new Promise((resolve) => setImmediate(resolve));

    expect(appendCustomEntry).toHaveBeenCalledExactlyOnceWith(
      DOOM_NOTIFICATION_ENTRY_TYPE,
      expect.objectContaining({ body: 'turn failed', level: 'error' }),
    );
  });

  it('derives activity from the runtime state', async () => {
    const { session, runtime } = await fixture();
    const readState = vi.spyOn(runtime, 'readState');

    readState.mockResolvedValueOnce({ pendingMessageCount: 2, isStreaming: true, isCompacting: false });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: true, isIdle: false });
    readState.mockResolvedValueOnce({ pendingMessageCount: 0, isStreaming: false, isCompacting: true });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: false, isIdle: false });
    readState.mockResolvedValueOnce({ pendingMessageCount: 0, isStreaming: false, isCompacting: false });
    await expect(session.activity()).resolves.toEqual({ hasPendingMessages: false, isIdle: true });
  });
});

describe('MCP execution boundary', () => {
  async function remoteFixture(owner = { majorMode: 'test', layer: 'default' }) {
    const execute = vi.fn<DoomHeadlessTool['execute']>(async (..._args) => ({
      content: [{ type: 'text' as const, text: 'done' }],
    }));
    const read = vi.fn(async () => '# skill');
    const current = await fixture([
      {
        declaration: {
          packageName: 'test',
          entry: './mcp.mjs',
          module: './mcp.mjs',
          sha256: '0'.repeat(64),
          owners: [owner],
        },
        plugin: {
          name: 'test',
          session: {
            tools: [
              {
                name: 'remote',
                description: 'Remote',
                parameters: Type.Object({}),
                annotations: { readOnlyHint: true },
                outputSchema: { type: 'object', properties: { status: { type: 'string' } } },
                execute,
              },
            ],
            skills: [{ name: 'guide', description: 'Guide', read }],
          },
        },
      },
    ]);
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const snapshot = current.host.mcpSurface.readSurface();
    return {
      ...current,
      execute,
      read,
      snapshot,
      invocation: { revision: snapshot.revision, name: 'remote', arguments: {} },
    };
  }

  it('preserves explicit MCP contracts and does not bypass a result-redaction hook', async () => {
    const current = await remoteFixture();
    expect(current.snapshot.tools[0]).toMatchObject({
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
    });
    current.execute.mockResolvedValue({
      content: [{ type: 'text', text: 'sensitive' }],
      structuredContent: { status: 'sensitive' },
    });
    await expect(current.host.mcpSurface.invokeTool(current.invocation)).resolves.toMatchObject({
      structuredContent: { status: 'sensitive' },
    });
    vi.spyOn(current.host.host!, 'dispatchHook').mockImplementation(async (name) =>
      name === 'tool_result' ? [{ content: [{ type: 'text', text: 'redacted' }] }] : [],
    );
    const result = await current.host.mcpSurface.invokeTool(current.invocation);
    expect(result.content).toEqual([{ type: 'text', text: 'redacted' }]);
    expect(result.structuredContent).toBeUndefined();
  });

  it('keeps the remote surface empty without explicit declarations', async () => {
    const current = await fixture();
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });

    const snapshot = current.host.mcpSurface.readSurface();
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.skills).toEqual([]);
    await expect(
      current.host.mcpSurface.invokeTool({ revision: snapshot.revision, name: 'read', arguments: {} }),
    ).rejects.toThrow();
  });

  it.each([
    { majorMode: 'other', layer: 'default' },
    { majorMode: 'test', layer: 'inactive' },
  ])('excludes declarations owned by $majorMode/$layer', async (owner) => {
    const current = await remoteFixture(owner);

    expect(current.snapshot.tools).toEqual([]);
    expect(current.snapshot.skills).toEqual([]);
    expect(current.read).not.toHaveBeenCalled();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it('publishes only the explicitly declared remote tools and skills', async () => {
    const current = await remoteFixture();

    expect(current.snapshot.tools.map(({ name }) => name)).toEqual(['remote']);
    expect(current.snapshot.skills.map(({ name }) => name)).toEqual(['guide']);
    expect(current.read).not.toHaveBeenCalled();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it('shares only repository instructions through the remote context reader', async () => {
    let context: DoomMcpPluginContext | undefined;
    const current = await fixture([
      {
        declaration: {
          packageName: 'test',
          entry: './mcp.mjs',
          module: './mcp.mjs',
          sha256: '0'.repeat(64),
          owners: [{ majorMode: 'test', layer: 'default' }],
        },
        plugin: { name: 'test', session: (value) => ((context = value), {}) },
      },
    ]);
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });

    expect(context!.loadContext()).toMatchObject({
      repository: { root: current.host.host!.context.repoRoot, cwd: current.host.host!.context.cwd },
      selection: { profile: null, domains: [], majorMode: 'test', activeLayers: [] },
      instructions: [{ path: 'AGENTS.md', content: 'inside repository' }],
      persona: null,
    });
  });

  it('passes remote skill access only through the invocation execution context', async () => {
    const current = await remoteFixture();
    const mcpSkills = { list: async () => [], read: async () => '# guide' };

    await current.host.mcpSurface.invokeTool({ ...current.invocation, mcpSkills });

    expect(current.execute.mock.calls[0]![4]).toMatchObject({ mcpSkills });
    expect(current.host.host!.context.mcpSkills).toBeUndefined();
  });

  it('reauthorizes after tool hooks and never executes on denial', async () => {
    const current = await remoteFixture();
    const order: string[] = [];
    vi.spyOn(current.host.host!, 'dispatchHook').mockImplementation(async (name) => {
      if (name === 'tool_call') order.push('hook');
      return [];
    });
    await expect(
      current.host.mcpSurface.invokeTool({
        ...current.invocation,
        authorize: () => {
          order.push('authorize');
          throw new Error('revoked');
        },
      }),
    ).rejects.toThrow('revoked');
    expect(order).toEqual(['hook', 'authorize']);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it('rejects cancellation during hooks before execution', async () => {
    const current = await remoteFixture();
    const controller = new AbortController();
    vi.spyOn(current.host.host!, 'dispatchHook').mockImplementation(async (name) => {
      if (name === 'tool_call') controller.abort();
      return [];
    });
    await expect(
      current.host.mcpSurface.invokeTool({ ...current.invocation, signal: controller.signal }),
    ).rejects.toThrow();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it('rechecks live state after asynchronous authorization', async () => {
    const current = await remoteFixture();
    await expect(
      current.host.mcpSurface.invokeTool({ ...current.invocation, authorize: () => current.host.dispose() }),
    ).rejects.toThrow();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it('combines caller and MCP lifecycle cancellation for running tools', async () => {
    for (const source of ['caller', 'lifecycle'] as const) {
      const current = await remoteFixture();
      const controller = new AbortController();
      let received: AbortSignal | undefined;
      current.execute.mockImplementationOnce(async (...args: unknown[]) => {
        received = args[2] as AbortSignal;
        if (source === 'caller') controller.abort();
        else await current.host.dispose();
        return { content: [{ type: 'text', text: 'done' }] };
      });
      const result = current.host.mcpSurface.invokeTool({ ...current.invocation, signal: controller.signal });
      if (source === 'lifecycle') await expect(result).rejects.toThrow();
      else await result;
      expect(received).toBeDefined();
      expect(received!.aborted).toBe(true);
      if (source === 'lifecycle') expect(controller.signal.aborted).toBe(false);
    }
  });

  it('rejects stale skill reads after a surface replacement', async () => {
    const current = await remoteFixture();
    current.read.mockImplementationOnce(async () => {
      await current.host.host!.changeSelection({ axis: 'state', key: 'test', values: ['other'] });
      return '# stale';
    });
    await expect(
      current.host.mcpSurface.readSkill(current.snapshot.revision, current.snapshot.skills[0]!.uri),
    ).rejects.toThrow('changed');
  });

  it('does not return a skill read after session disposal', async () => {
    const current = await remoteFixture();
    current.read.mockImplementationOnce(async () => {
      await current.host.dispose();
      return '# stale';
    });
    await expect(
      current.host.mcpSurface.readSkill(current.snapshot.revision, current.snapshot.skills[0]!.uri),
    ).rejects.toThrow('not ready');
  });
});
