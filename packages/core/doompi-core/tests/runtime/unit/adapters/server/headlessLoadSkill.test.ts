import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import {
  DOOM_HEADLESS_HOST_SERVICE,
  DOOM_LOAD_SKILL_TOOL,
  requireDoomHeadlessHost,
} from '../../../../../src/exports/headless';
import type { LoadedServerFacet } from '../../../../../src/exports/serverFacet';
import { serveSessionApis } from '../../../../../src/server/packageApiServer';
import { createHeadlessSessionHost } from '../../../../../src/systems/main/adapters/headlessSessionHost';

const model: Model<Api> = {
  id: 'test',
  name: 'Test',
  api: 'test-api',
  provider: 'test-provider',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65_536,
  maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse') {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    stopReason,
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
  stream.push({ type: 'done', reason: stopReason, message });
  stream.end();
  return stream;
}

describe('the session load_skill tool', () => {
  it('lists every skill in its description instead of the prompt, and loads one by name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-load-skill-'));
    const contexts: Array<{ systemPrompt?: string; tools?: Array<{ name: string; description: string }> }> = [];
    const responses = [
      response(
        [{ type: 'toolCall', id: 'load-1', name: DOOM_LOAD_SKILL_TOOL, arguments: { name: 'fixture-skill' } }],
        'toolUse',
      ),
      response([{ type: 'text', text: 'done' }], 'stop'),
    ];
    const loaded: Array<string | undefined> = [];
    const streamSimple = vi.fn<Models['streamSimple']>((_model, requestContext) => {
      contexts.push({
        ...requestContext,
        systemPrompt: getCurrentSystemPrompt(requestContext.messages),
        tools: getCurrentTools(requestContext.messages),
      } as never);
      const next = responses.shift();
      if (next === undefined) throw new Error('Test provider ran out of responses');
      return next;
    });
    const runtime = {
      getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      getModels: () => [model],
      getAvailable: async () => [model],
      streamSimple,
    } as unknown as ModelRuntime;
    const facet: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        packageName: '@test/skills',
        entry: './facet.ts',
        module: './facet.mjs',
        scopes: ['session'],
        required: true,
        owners: [{ majorMode: 'development', layer: 'tools' }],
      },
      facet: {
        inject: [DOOM_HEADLESS_HOST_SERVICE],
        apply(context: Context) {
          const host = requireDoomHeadlessHost(context);
          // No path: without the tool such a skill would never be listed.
          host.registerResource({
            name: 'fixture-skill',
            description: 'Fixture skill',
            kind: 'skill',
            read: () => 'fixture instructions',
          });
          host.registerTool({
            name: DOOM_LOAD_SKILL_TOOL,
            description: 'Load a skill.',
            parameters: Type.Object({ name: Type.String() }),
            execute: async (_id, { name }) => {
              loaded.push(host.readSkill(String(name)));
              return { content: [{ type: 'text', text: host.readSkill(String(name)) ?? 'missing' }] };
            },
          });
        },
      },
    };
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());

    const session = await createHeadlessSessionHost({
      cwd: root,
      repoRoot: root,
      sessionId: 'headless-load-skill-test',
      sessionName: 'Skills',
      agentArgs: ['--session-dir', root, '--system-prompt', 'base'],
      environment: {},
      candidates: [facet.declaration],
      selection: { majorMode: 'development', activeLayers: ['tools'], domains: [], state: {} },
      onNotice: vi.fn(),
    });
    const apis = await serveSessionApis({
      sessionId: 'headless-load-skill-test',
      cwd: root,
      internalToken: 'internal',
      hubToken: 'hub',
      environment: {},
      directEvents: { publish: () => undefined, subscribe: () => () => undefined, close: () => undefined },
      apis: [],
      facets: [facet],
      prepareFacets: session.prepareFacets,
      activateFacets: session.activateFacets,
      canDispatch: session.canDispatch,
      onNotice: vi.fn(),
    });
    try {
      await session.runtime.setModel({ provider: model.provider, id: model.id });
      await session.runtime.prompt('load it');

      const tool = contexts[0]?.tools?.find(({ name }) => name === DOOM_LOAD_SKILL_TOOL);
      expect(tool?.description).toContain('<name>fixture-skill</name>');
      expect(tool?.description).toContain('<description>Fixture skill</description>');
      expect(contexts[0]?.systemPrompt).not.toContain('<available_skills>');
      expect(loaded).toEqual(['fixture instructions']);
    } finally {
      await session.dispose().catch(() => undefined);
      await apis.close().catch(() => undefined);
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
