import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';

it.each(['global', 'project', 'cli'] as const)(
  'uses %s model settings and preserves a selected model through prompts and reopening',
  async (scope) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-model-settings-'));
    const agentDir = path.join(root, 'agent');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'test-provider', defaultModel: 'global', defaultThinkingLevel: 'high' }),
    );
    if (scope !== 'global') {
      fs.writeFileSync(
        path.join(cwd, '.pi', 'settings.json'),
        JSON.stringify({ defaultModel: 'project', defaultThinkingLevel: 'low' }),
      );
    }
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const models: Model<Api>[] = ['fallback', 'global', 'project', 'cli', 'selected'].map((id) => ({
      id,
      name: id,
      provider: 'test-provider',
      api: 'test-api',
      baseUrl: 'http://localhost',
      reasoning: true,
      input: ['text'],
      contextWindow: 65536,
      maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const streamSimple = vi.fn((model: Model<Api>) => {
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
      stream.end();
      return stream;
    });
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
      getModel: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getModels: () => models,
      getAvailable: async () => models,
      streamSimple,
    } as unknown as ModelRuntime);
    const options = {
      cwd,
      repoRoot: cwd,
      sessionId: 'model-settings',
      sessionName: 'Model settings',
      agentArgs: scope === 'cli' ? ['--provider', 'test-provider', '--model', 'cli'] : [],
      environment: {},
      candidates: [],
      piExtensions: false,
      selection: { majorMode: 'test', activeLayers: [], domains: [], state: {} },
    };
    const context = new Context();
    let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
    try {
      session = await createHeadlessSessionHost(options);
      await expect(session.runtime.readState()).resolves.toMatchObject({
        model: { provider: 'test-provider', id: scope },
        thinkingLevel: scope === 'global' ? 'high' : 'low',
      });
      session.prepareFacets(context);
      await session.activateFacets({ root: context, installedPackages: [], dispose: async () => {} });
      await session.runtime.prompt('first message');
      expect(streamSimple.mock.calls.at(-1)?.[0].id).toBe(scope);
      await session.runtime.setModel({ provider: 'test-provider', id: 'selected' });
      await session.runtime.prompt('second message');
      expect(streamSimple.mock.calls.at(-1)?.[0].id).toBe('selected');
      await expect(session.runtime.readState()).resolves.toMatchObject({ model: { id: 'selected' } });
      await session.dispose();
      session = await createHeadlessSessionHost(options);
      await expect(session.runtime.readState()).resolves.toMatchObject({ model: { id: 'selected' } });
    } finally {
      await session?.dispose();
      await context.fiber.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
