import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo, MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { createDirectHarnessRuntime } from '../../../../src/adapters/server/directHarnessRuntime.ts';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test model',
  api: 'test-api',
  provider: 'test-provider',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
  maxTokens: 256,
};

const models = {
  getModels: () => [model],
  getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
  getAvailable: async () => [model],
} as unknown as Models;

async function frameFor(frames: Record<string, unknown>[], id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = frames.find((candidate) => candidate.id === id);
    if (frame !== undefined) return frame;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for response ${id}`);
}

describe('direct AgentHarness runtime', () => {
  it.each(['turn', 'request', 'late-tool-removal'] as const)(
    'blocks %s admission failure and recovers',
    async (phase) => {
      const repository = new MemorySessionRepo();
      const session = await repository.create({ id: `admission-${phase}` }, BACKGROUND_CONTEXT);
      const streamSimple = vi.fn<Models['streamSimple']>(() => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      });
      const tool = {
        name: 'allowed',
        label: 'Allowed',
        description: 'Allowed tool',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
      };
      let failing = true;
      const runtime = await createDirectHarnessRuntime({
        cwd: '/tmp',
        session,
        models: { ...models, streamSimple } as unknown as Models,
        model,
        tools: [tool],
        async beforeModelRequest(boundary) {
          if (failing && boundary.phase === phase) throw undefined;
          if (failing && phase === 'late-tool-removal' && boundary.phase === 'request') {
            await runtime.replaceTools([]);
          }
        },
      });
      try {
        await runtime.prompt('blocked').catch(() => undefined);
        expect(streamSimple).not.toHaveBeenCalled();
        failing = false;
        await runtime.replaceTools([tool]);
        await runtime.prompt('recovered');
        expect(streamSimple).toHaveBeenCalledOnce();
        expect(streamSimple.mock.calls[0]?.[1].tools?.map((entry) => entry.name)).toEqual(['allowed']);
        await runtime.replaceTools([]);
        await runtime.prompt('tools removed');
        expect(streamSimple).toHaveBeenCalledTimes(2);
        expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      } finally {
        await runtime.dispose();
        await repository.close(BACKGROUND_CONTEXT);
      }
    },
  );

  it('replaces lane activation along with the tool registry without replacing the harness', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'tools-replacement' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({ cwd: '/tmp', session, models, model });
    const harness = runtime.harness;
    try {
      await runtime.replaceTools([
        {
          name: 'allowed',
          label: 'Allowed',
          description: 'Allowed tool',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
        },
      ]);
      await expect(runtime.lane.getActiveTools(BACKGROUND_CONTEXT)).resolves.toEqual(['allowed']);
      await runtime.replaceTools([]);
      await expect(runtime.lane.getActiveTools(BACKGROUND_CONTEXT)).resolves.toEqual([]);
      expect(runtime.harness).toBe(harness);
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });
  it('replaces resources through the public harness and preserves framed state responses', async () => {
    const repository = new MemorySessionRepo();
    const session = await repository.create({ id: 'direct-runtime-test' }, BACKGROUND_CONTEXT);
    const runtime = await createDirectHarnessRuntime({
      cwd: '/tmp',
      session,
      models,
      model,
    });
    const frames: Record<string, unknown>[] = [];
    runtime.onFrame((frame) => frames.push(frame));

    try {
      expect(await runtime.readResources()).toEqual({});
      await runtime.replaceResources({ promptTemplates: [{ name: 'greet', content: 'Hello' }] });
      await expect(runtime.readResources()).resolves.toMatchObject({
        promptTemplates: [{ name: 'greet', content: 'Hello' }],
      });

      runtime.send({ type: 'get_state', id: 'state' });
      await expect(frameFor(frames, 'state')).resolves.toMatchObject({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'direct-runtime-test', model: { provider: 'test-provider', id: 'test-model' } },
      });
    } finally {
      await runtime.dispose();
      await repository.close(BACKGROUND_CONTEXT);
    }
  });

  it('requires and retains an exclusive lease for an existing v4 session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-direct-runtime-'));
    const environment = new NodeExecutionEnv({ cwd: root });
    const repository = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot: root });
    const source = await repository.create({ id: 'leased-runtime-test', cwd: root }, BACKGROUND_CONTEXT);
    const sessionPath = source.metadata.path;
    await source.close(BACKGROUND_CONTEXT);
    await repository.close(BACKGROUND_CONTEXT);
    await environment.cleanup(BACKGROUND_CONTEXT);

    const release = vi.fn();
    const assertQuiescent = vi.fn();
    const acquire = vi.fn(async () => ({ assertQuiescent, release }));
    const runtime = await createDirectHarnessRuntime({
      cwd: root,
      sessionPath,
      historyOwnership: { acquire },
      models,
      model,
    });

    try {
      expect(acquire).toHaveBeenCalledWith(sessionPath);
      expect(assertQuiescent).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
