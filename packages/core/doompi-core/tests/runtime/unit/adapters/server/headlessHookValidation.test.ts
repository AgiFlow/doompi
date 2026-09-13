import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import * as directRuntime from '../../../../../src/server/directHarnessRuntime';
import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';
import type { DirectHarnessRuntimeOptions } from '../../../../../src/types/server/directHarnessRuntime';

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe('headless hook boundary validation', () => {
  let root: string;
  let session: Awaited<ReturnType<typeof createHeadlessSessionHost>>;
  let hooks: DirectHarnessRuntimeOptions;
  let patches: unknown[] = [];
  const context = new Context();
  const call = { name: 'fixture', args: { original: true } };
  const result = { ...call, content: [{ type: 'text', text: 'original' }], details: null, isError: false };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-validation-'));
    const model: Model<Api> = {
      id: 'test',
      name: 'Test',
      api: 'test-api',
      provider: 'test-provider',
      baseUrl: 'http://localhost',
      reasoning: false,
      input: ['text'],
      contextWindow: 65536,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
      getModel: () => model,
      getModels: () => [model],
      getAvailable: async () => [model],
    } as unknown as ModelRuntime);
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());
    const factory = vi.spyOn(directRuntime, 'createDirectHarnessRuntime');
    session = await createHeadlessSessionHost({
      cwd: root,
      repoRoot: root,
      sessionId: 'validation',
      sessionName: 'Validation',
      agentArgs: ['--session-dir', root],
      environment: {},
      candidates: [],
      selection: { majorMode: 'test', activeLayers: [], domains: [], state: {} },
    });
    hooks = factory.mock.calls[0]![0];
    // Exercise startup admission before installing even an empty capability composition.
    for (const invoke of [
      () => hooks.beforeModelRequest!({ phase: 'turn' } as never, BACKGROUND_CONTEXT),
      () => hooks.transformContext!({ messages: [], systemPrompt: '' } as never, BACKGROUND_CONTEXT),
      () => hooks.beforeTool!(call as never, BACKGROUND_CONTEXT),
      () => hooks.afterTool!(result as never, BACKGROUND_CONTEXT),
      () => hooks.dispatchCommand!('/fixture'),
    ])
      await expect(invoke()).rejects.toThrow('not installed');
    expect(() => hooks.listCommands!()).toThrow('not installed');
    expect(() => hooks.guardModelRequest!()).toThrow('not ready');
    session.prepareFacets(context);
    await session.activateFacets({ root: context, installedPackages: [], dispose: async () => {} });
    vi.spyOn(session.host!, 'dispatchHook').mockImplementation(async () => patches);
  });

  afterAll(async () => {
    await session?.dispose();
    await context.fiber.dispose();
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { args: null },
    { args: [] },
    { args: { value: Infinity } },
    { args: { nested: [undefined] } },
    { block: null },
    { block: [] },
    { block: { reason: 1 } },
    { block: { reason: 'no', terminate: 'yes' } },
  ])('rejects malformed tool-call patches: %j', async (patch) => {
    patches = [patch];
    await expect(hooks.beforeTool!(call as never, BACKGROUND_CONTEXT)).rejects.toThrow('Invalid headless tool');
  });

  it('preserves JSON arguments and explicit termination on tool denial', async () => {
    const args = { number: 1, values: [null, true, 'value', { nested: 2 }] };
    patches = [null, { args, block: { reason: 'no', terminate: false } }];
    await expect(hooks.beforeTool!(call as never, BACKGROUND_CONTEXT)).resolves.toEqual({
      args,
      block: { reason: 'no', terminate: false },
    });
    patches = [false, {}];
    await expect(hooks.beforeTool!(call as never, BACKGROUND_CONTEXT)).resolves.toEqual({});
  });

  it.each([
    { content: [null] },
    { content: [{ type: 'text', text: 1 }] },
    { content: [{ type: 'image', data: 1, mimeType: 'image/png' }] },
    { content: [{ type: 'image', data: 'data', mimeType: 1 }] },
    { content: [{ type: 'unknown' }] },
    { details: NaN },
    { details: [undefined] },
    { usage: null },
    { usage: { cost: null } },
    { usage: { ...usage, input: '1' } },
    { usage: { ...usage, input: Infinity } },
    { usage: { ...usage, cost: { ...usage.cost, total: NaN } } },
    { isError: 'yes', terminate: 'yes' },
  ])('does not forward malformed result fields: %j', async (patch) => {
    patches = [patch];
    await expect(hooks.afterTool!(result as never, BACKGROUND_CONTEXT)).resolves.toEqual({});
  });

  it('forwards valid image, nested details, usage, error and termination patches', async () => {
    const patch = {
      content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
      details: { items: [null, false, 1, 'text'] },
      usage,
      isError: true,
      terminate: true,
    };
    patches = [null, patch];
    await expect(hooks.afterTool!(result as never, BACKGROUND_CONTEXT)).resolves.toEqual(patch);
  });

  it('preserves context with no patch and replaces valid messages', async () => {
    const event = { messages: [], systemPrompt: 'original' };
    patches = [null, {}];
    await expect(hooks.transformContext!(event as never, BACKGROUND_CONTEXT)).resolves.toEqual(event);
    patches = [{ messages: [] }];
    await expect(hooks.transformContext!(event as never, BACKGROUND_CONTEXT)).resolves.toEqual(event);
  });
});
