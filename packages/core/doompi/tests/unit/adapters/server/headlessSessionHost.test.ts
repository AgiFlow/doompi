import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { LoadedServerFacet } from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import {
  createHeadlessSessionHost,
  validateDirectHeadlessArgs,
  isDirectHeadlessOptedIn,
} from '../../../../src/adapters/server/headlessSessionHost';
import { serveSessionApis } from '../../../../src/adapters/server/packageApiServer';

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

describe('gated headless startup', () => {
  it('requires explicit opt-in and rejects unsupported or malformed arguments', () => {
    expect(isDirectHeadlessOptedIn({})).toBe(false);
    expect(isDirectHeadlessOptedIn({ DOOMPI_TEST_DIRECT_HEADLESS: '1' })).toBe(true);
    expect(() => validateDirectHeadlessArgs(['--mode', 'invalid'])).toThrow('does not support --mode');
    expect(() => validateDirectHeadlessArgs(['--name'])).toThrow('requires a value');
    expect(() => validateDirectHeadlessArgs(['--resume'])).toThrow('does not support --resume');
  });

  it('installs retained facets into the real API host and changes actual provider tools in place', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-startup-'));
    const streamSimple = vi.fn<Models['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: model.api,
        model: model.id,
        provider: model.provider,
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
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
      getModel: () => model,
      getModels: () => [model],
      getAvailable: async () => [model],
      streamSimple,
    } as unknown as ModelRuntime);
    vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());
    const installed = vi.fn();
    const shutdown = vi.fn();
    let resourceText = 'Fixture context';
    let resourceFailure = false;
    const facet: LoadedServerFacet = {
      retained: true,
      initiallyEligible: true,
      declaration: {
        packageName: '@test/tool',
        entry: './server.ts',
        module: './server.mjs',
        scopes: ['session'],
        required: true,
        owners: [{ majorMode: 'development', layer: 'tools' }],
      },
      facet: {
        inject: [DOOM_HEADLESS_HOST_SERVICE],
        apply(context) {
          installed();
          const host = requireDoomHeadlessHost(context);
          host.registerTool({
            name: 'fixture_tool',
            description: 'Fixture tool',
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          });
          host.registerHook({ event: 'session_shutdown', handle: shutdown });
          host.registerResource({
            name: 'context',
            kind: 'context',
            read: () => {
              if (resourceFailure) throw new Error('Fixture resource unavailable');
              return resourceText;
            },
          });
          host.registerHook({
            event: 'before_agent_start',
            handle: (event) => ({ systemPrompt: `${String(event.systemPrompt)}\nFirst patch` }),
          });
          host.registerHook({
            event: 'before_agent_start',
            handle: (event) => ({ systemPrompt: `${String(event.systemPrompt)}\nSecond patch` }),
          });
        },
      },
    };
    let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
    let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
    try {
      session = await createHeadlessSessionHost({
        cwd: root,
        repoRoot: root,
        sessionId: 'startup-test',
        sessionName: 'Test',
        agentArgs: ['--session-dir', root],
        candidates: [facet.declaration],
        selection: { majorMode: 'development', activeLayers: ['tools'], domains: [], minorModes: [] },
      });
      expect(session.canDispatch()).toBe(false);
      apis = await serveSessionApis({
        socketDir: root,
        sessionId: 'startup-test',
        cwd: root,
        internalToken: 'test-internal-token',
        hubToken: 'test-hub-token',
        apis: [],
        facets: [facet],
        prepareFacets: session.prepareFacets,
        activateFacets: session.activateFacets,
        canDispatch: session.canDispatch,
        onNotice: vi.fn(),
      });
      expect(session.canDispatch()).toBe(true);
      const harness = session.runtime.harness;
      await session.runtime.prompt('First');
      expect(streamSimple.mock.calls[0]?.[1].tools?.map((tool) => tool.name)).toEqual(['fixture_tool']);
      expect(streamSimple.mock.calls[0]?.[1].systemPrompt).toBe('Fixture context\nFirst patch\nSecond patch');
      await session.host!.select({ activeLayers: [] });
      await session.runtime.prompt('Disabled');
      expect(streamSimple.mock.calls[1]?.[1].tools ?? []).toEqual([]);
      await session.host!.select({ activeLayers: ['tools'] });
      resourceText = 'Updated context';
      await session.runtime.prompt('Reenabled');
      expect(streamSimple.mock.calls[2]?.[1].systemPrompt).toBe('Updated context\nFirst patch\nSecond patch');
      resourceFailure = true;
      await session.runtime.prompt('Resource failure').catch(() => undefined);
      expect(streamSimple).toHaveBeenCalledTimes(3);
      expect(session.canDispatch()).toBe(false);
      resourceFailure = false;
      await session.runtime.prompt('Resource recovered');
      expect(streamSimple).toHaveBeenCalledTimes(4);
      expect(session.canDispatch()).toBe(true);
      expect(session.runtime.harness).toBe(harness);
      expect(installed).toHaveBeenCalledOnce();
      await session.dispose();
      expect(shutdown).toHaveBeenCalledOnce();
      expect(session.canDispatch()).toBe(false);
    } finally {
      await session?.dispose();
      await apis?.close();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
