import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '@agimon-ai/doompi-extension-contracts/headless';
import type { LoadedServerFacet } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createHeadlessSessionHost } from '../../../../src/adapters/server/headlessSessionHost';
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

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
    usage,
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: stopReason, message });
  stream.end();
  return stream;
}

describe('active headless execution hooks', () => {
  it.each(['throws', 'invalid-messages', 'invalid-system-prompt'] as const)(
    'transforms context, guards tools, and recovers from %s',
    async (failure) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-hooks-'));
      const contexts: Array<Record<string, unknown>> = [];
      const contextEvents: Array<Record<string, unknown>> = [];
      const providerEvents: Array<Record<string, unknown>> = [];
      const payloadCallbacks: Array<NonNullable<Parameters<Models['streamSimple']>[2]>['onPayload']> = [];
      const compactionEvents: Array<Record<string, unknown>> = [];
      const modelSelectEvents: Array<Record<string, unknown>> = [];
      let laterCompactionCalls = 0;
      const toolCallEvents: Array<Record<string, unknown>> = [];
      const toolResultEvents: Array<Record<string, unknown>> = [];
      const secondToolCallEvents: Array<Record<string, unknown>> = [];
      const executed: string[] = [];
      let contextFailure = false;
      let invalidPayload = false;
      let compactionMode: 'decline' | 'invalid' | 'custom' = 'decline';
      const responses = [
        response(
          [{ type: 'toolCall', id: 'allowed-1', name: 'fixture_tool', arguments: { value: 'allowed' } }],
          'toolUse',
        ),
        response([{ type: 'text', text: 'first done' }], 'stop'),
        response(
          [{ type: 'toolCall', id: 'disabled-1', name: 'fixture_tool', arguments: { value: 'deny' } }],
          'toolUse',
        ),
        response([{ type: 'text', text: 'disabled done' }], 'stop'),
        response(
          [{ type: 'toolCall', id: 'reported-error-1', name: 'fixture_tool', arguments: { value: 'reported-error' } }],
          'toolUse',
        ),
        response([{ type: 'text', text: 'reported error done' }], 'stop'),
        response([{ type: 'toolCall', id: 'denied-1', name: 'fixture_tool', arguments: { value: 'deny' } }], 'toolUse'),
        response([{ type: 'text', text: 'denied done' }], 'stop'),
        response([{ type: 'text', text: 'failed hook continued' }], 'stop'),
        response([{ type: 'text', text: 'recovered' }], 'stop'),
      ];
      const streamSimple = vi.fn<Models['streamSimple']>((_requestedModel, requestContext, streamOptions) => {
        contexts.push(requestContext as unknown as Record<string, unknown>);
        payloadCallbacks.push(streamOptions?.onPayload);
        const next = responses.shift();
        if (next === undefined) throw new Error('Test provider ran out of responses');
        return next;
      });
      const runtime = {
        getModel: (provider: string, id: string) =>
          provider === model.provider && id === model.id ? model : undefined,
        getModels: () => [model],
        getAvailable: async () => [model],
        streamSimple,
      } as unknown as ModelRuntime;
      const facet: LoadedServerFacet = {
        retained: true,
        initiallyEligible: true,
        declaration: {
          packageName: '@test/hooks',
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
            host.registerTool({
              name: 'fixture_tool',
              description: 'Fixture tool',
              parameters: Type.Object({ value: Type.String() }),
              execute: async (_toolCallId, parameters) => {
                const value = String(parameters.value);
                executed.push(value);
                return {
                  content: [{ type: 'text', text: `raw:${value}` }],
                  details: { raw: true },
                  ...(value === 'reported-error' ? { isError: true } : {}),
                };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'context',
              handle: (event) => {
                contextEvents.push({ ...event });
                if (contextFailure) {
                  if (failure === 'invalid-messages')
                    return { messages: 'not messages' } as unknown as { messages: unknown[] };
                  if (failure === 'invalid-system-prompt')
                    return { systemPrompt: 42 } as unknown as { systemPrompt: string };
                  throw new Error('context hook failed');
                }
                return { systemPrompt: `${String(event.systemPrompt)} transformed` };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'context',
              handle: (event) => ({ systemPrompt: `${String(event.systemPrompt)} twice` }),
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'model_select',
              handle: (event) => modelSelectEvents.push({ ...event }),
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'before_provider_request',
              handle: () => undefined,
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'before_provider_request',
              handle: (event) => {
                providerEvents.push({ ...event });
                if (invalidPayload) return {} as { payload: unknown };
                return { payload: { ...(event.payload as Record<string, unknown>), transformed: true } };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'before_provider_request',
              handle: (event) => ({
                payload: { ...(event.payload as Record<string, unknown>), transformedTwice: true },
              }),
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'session_before_compact',
              handle: () => undefined,
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'session_before_compact',
              handle: (event) => {
                compactionEvents.push({ ...event });
                if (compactionMode === 'decline') return { cancel: true };
                if (compactionMode === 'invalid') {
                  return {
                    compaction: {
                      summary: 'invalid',
                      tokensBefore: 42,
                      retainedTail: [null] as unknown as Record<string, unknown>[],
                    },
                  };
                }
                return { compaction: { summary: 'hook summary', tokensBefore: 42, retainedTail: [] } };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'session_before_compact',
              handle: () => {
                laterCompactionCalls += 1;
                return { cancel: true };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'tool_call',
              handle: (event) => {
                toolCallEvents.push({ ...event });
                return (event.args as { value?: string }).value === 'deny'
                  ? { block: { reason: 'denied by headless hook' } }
                  : { args: { value: 'guarded' } };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'tool_call',
              handle: (event) => {
                secondToolCallEvents.push({ ...event });
                return { args: { value: `${String((event.args as { value: string }).value)}:checked` } };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'tool_result',
              handle: (event) => {
                toolResultEvents.push({ ...event });
                return {
                  content: [
                    { type: 'text', text: `patched:${String((event.content as Array<{ text?: unknown }>)[0]?.text)}` },
                  ],
                  details: { patched: true },
                };
              },
            });
            host.registerHook({
              when: { domain: 'hooks' },
              event: 'tool_result',
              handle: (event) => ({
                content: [
                  { type: 'text', text: `twice:${String((event.content as Array<{ text: string }>)[0]?.text)}` },
                ],
              }),
            });
          },
        },
      };
      vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
      vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());
      const onNotice = vi.fn();

      let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
      let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
      try {
        session = await createHeadlessSessionHost({
          cwd: root,
          repoRoot: root,
          sessionId: 'headless-hooks-test',
          sessionName: 'Hooks',
          agentArgs: ['--session-dir', root, '--system-prompt', 'base'],
          environment: {},
          candidates: [facet.declaration],
          selection: { majorMode: 'development', activeLayers: ['tools'], domains: ['hooks'], minorModes: [] },
          onNotice,
        });
        apis = await serveSessionApis({
          sessionId: 'headless-hooks-test',
          cwd: root,
          internalToken: 'internal',
          hubToken: 'hub',
          environment: {},
          directEvents: {
            publish: () => undefined,
            subscribe: () => () => undefined,
            close: () => undefined,
          },
          apis: [],
          facets: [facet],
          prepareFacets: session.prepareFacets,
          activateFacets: session.activateFacets,
          canDispatch: session.canDispatch,
          onNotice: vi.fn(),
        });
        expect(session.canDispatch()).toBe(true);

        await session.runtime.lane.setModel({ provider: model.provider, modelId: model.id }, BACKGROUND_CONTEXT);
        expect(modelSelectEvents).toEqual([{ model }]);

        await session.runtime.prompt('allowed');
        expect(contextEvents[0]).toMatchObject({ systemPrompt: expect.stringContaining('base') });
        expect(contexts[0]?.systemPrompt).toBe('base transformed twice');
        const transformPayload = payloadCallbacks[0];
        expect(transformPayload).toBeTypeOf('function');
        await expect(transformPayload!({ raw: true }, model)).resolves.toEqual({
          raw: true,
          transformed: true,
          transformedTwice: true,
        });
        expect(providerEvents[0]).toMatchObject({ model, payload: { raw: true } });
        invalidPayload = true;
        await expect(transformPayload!({ raw: true }, model)).rejects.toThrow(
          'Invalid headless provider payload patch',
        );
        invalidPayload = false;
        await expect(transformPayload!({ recovered: true }, model)).resolves.toEqual({
          recovered: true,
          transformed: true,
          transformedTwice: true,
        });
        await expect(session.runtime.compact('keep fixture')).resolves.toBeUndefined();
        expect(compactionEvents[0]).toMatchObject({ instructions: 'keep fixture', customInstructions: 'keep fixture' });
        compactionMode = 'invalid';
        await expect(session.runtime.compact()).resolves.toBeUndefined();
        expect(onNotice).toHaveBeenCalledWith(
          expect.stringContaining('Headless compaction hook rejected: Invalid headless compaction result'),
        );
        compactionMode = 'custom';
        await expect(session.runtime.compact()).resolves.toBeUndefined();
        expect(compactionEvents).toHaveLength(3);
        expect(laterCompactionCalls).toBe(0);
        expect(executed).toEqual(['guarded:checked']);
        expect(secondToolCallEvents[0]?.args).toEqual({ value: 'guarded' });
        expect(toolResultEvents[0]).toMatchObject({ toolName: 'fixture_tool', details: { raw: true } });
        expect(contexts[1]?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'toolResult',
              content: [{ type: 'text', text: 'twice:patched:raw:guarded:checked' }],
            }),
          ]),
        );

        await session.host!.select({ majorMode: 'development', activeLayers: ['tools'], domains: [] });
        await session.runtime.prompt('disabled hook');
        expect(executed).toEqual(['guarded:checked', 'deny']);
        expect(toolCallEvents).toHaveLength(1);
        expect(toolResultEvents).toHaveLength(1);

        const reportedFrames: Record<string, unknown>[] = [];
        session.onPresentationFrame((frame) => reportedFrames.push(frame));
        await session.runtime.prompt('reported tool error');
        expect(executed).toEqual(['guarded:checked', 'deny', 'reported-error']);
        expect(reportedFrames).toContainEqual(
          expect.objectContaining({
            type: 'tool_execution_end',
            toolCallId: 'reported-error-1',
            isError: true,
          }),
        );

        await session.host!.select({ majorMode: 'development', activeLayers: ['tools'], domains: ['hooks'] });
        await session.runtime.prompt('denied hook');
        expect(executed).toEqual(['guarded:checked', 'deny', 'reported-error']);
        expect(toolCallEvents).toHaveLength(2);
        expect(secondToolCallEvents).toHaveLength(1);
        expect(toolResultEvents).toHaveLength(1);

        contextFailure = true;
        await session.runtime.prompt('failed context').catch(() => undefined);
        expect(streamSimple).toHaveBeenCalledTimes(failure === 'throws' ? 9 : 8);
        if (failure === 'throws') expect(contexts[8]?.systemPrompt).toBe('base twice');
        contextFailure = false;
        await session.runtime.prompt('recovered context');
        expect(streamSimple).toHaveBeenCalledTimes(failure === 'throws' ? 10 : 9);
        expect(contexts[failure === 'throws' ? 9 : 8]?.systemPrompt).toBe('base transformed twice');
      } finally {
        await session?.dispose().catch(() => undefined);
        await apis?.close().catch(() => undefined);
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
