import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
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

import { DOOM_HEADLESS_HOST_SERVICE, requireDoomHeadlessHost } from '../../../../../src/exports/headless';
import type { LoadedServerFacet } from '../../../../../src/exports/serverFacet';
import { serveSessionApis } from '../../../../../src/server/packageApiServer';
import type { ServerTelemetry } from '../../../../../src/services/serverTelemetry';
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
        contexts.push({
          ...requestContext,
          systemPrompt: getCurrentSystemPrompt(requestContext.messages),
          tools: getCurrentTools(requestContext.messages),
        } as unknown as Record<string, unknown>);
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
            host.registerResource({
              name: 'fixture-skill',
              description: 'Fixture skill',
              kind: 'skill',
              read: () => 'fixture instructions',
            });
            host.registerTool({
              name: 'fixture_tool',
              description: 'Fixture tool',
              parameters: Type.Object({ value: Type.String() }),
              execute: async (_toolCallId, parameters) => {
                const value = String(parameters.value);
                executed.push(value);
                return {
                  content: [{ type: 'text', text: `raw:${value}` }],
                  details: { raw: true, app: { result: { _meta: { privateValue: 'private-original' } } } },
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
                  // Even a hook that preserves renderer details must invalidate the
                  // original component snapshot after rewriting model-visible output.
                  details: { patched: true, app: { result: { _meta: { privateValue: 'private-original' } } } },
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
      const recordError = vi.fn<ServerTelemetry['recordError']>(async () => undefined);

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
          selection: { majorMode: 'development', activeLayers: ['tools'], domains: ['hooks'], state: {} },
          onNotice,
          telemetry: { recordError },
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

        await session.runtime.setModel({ provider: model.provider, id: model.id });
        expect(modelSelectEvents).toEqual([{ model }]);

        await session.runtime.prompt('allowed');
        expect(contextEvents[0]).toMatchObject({ systemPrompt: expect.stringContaining('base') });
        // The composed prompt now also carries Pi's working-directory line, so the
        // hook chain's contribution is asserted rather than the whole string.
        expect(contexts[0]?.systemPrompt).toContain('base');
        expect(contexts[0]?.systemPrompt).toContain('transformed twice');
        expect(contexts[0]?.systemPrompt).toContain('Current working directory:');
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

        const nativeResult = (await session.runtime.readEntries()).entries.find(
          (entry) => entry.type === 'message' && entry.message.role === 'toolResult',
        );
        expect(nativeResult).toMatchObject({ message: { details: { patched: true } } });
        expect(JSON.stringify(nativeResult)).not.toContain('private-original');

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
        if (failure === 'throws') expect(contexts[8]?.systemPrompt).toContain('twice');
        contextFailure = false;
        await session.runtime.prompt('recovered context');
        expect(streamSimple).toHaveBeenCalledTimes(failure === 'throws' ? 10 : 9);
        expect(contexts[failure === 'throws' ? 9 : 8]?.systemPrompt).toContain('transformed twice');

        const surface = session.toolSurface.readSurface();
        expect(surface.tools.map((tool) => tool.name)).toContain('fixture_tool');
        const skill = surface.skills.find((entry) => entry.name === 'fixture-skill');
        expect(skill).toBeDefined();
        expect(session.toolSurface.readSkill(surface.revision, skill!.uri)).toBe('fixture instructions');
        await expect(
          session.toolSurface.invokeTool({
            revision: surface.revision,
            name: 'fixture_tool',
            arguments: { value: 'external' },
          }),
        ).resolves.toMatchObject({
          content: [{ type: 'text', text: 'twice:patched:raw:guarded:checked' }],
          details: { patched: true },
          isError: false,
        });
        expect(executed.at(-1)).toBe('guarded:checked');
        expect(reportedFrames).toContainEqual(
          expect.objectContaining({
            type: 'tool_execution_end',
            runId: 'external',
            toolName: 'fixture_tool',
            isError: false,
          }),
        );
        await expect(
          session.toolSurface.invokeTool({ revision: surface.revision, name: 'fixture_tool', arguments: {} }),
        ).rejects.toThrow("Invalid arguments for tool 'fixture_tool'");

        const providerCalls = streamSimple.mock.calls.length;
        onNotice.mockClear();
        onNotice.mockImplementation(() => {
          throw new Error('Unexpected prompt preparation notice');
        });
        recordError.mockClear();
        const resourceFailure = new Error('Selection changed while reading resources');
        const readResources = vi.spyOn(session.host!, 'readResources').mockRejectedValueOnce(resourceFailure);
        await expect(session.runtime.prompt('failed prompt resources')).rejects.toThrow(
          'Agent submission failed: faulted',
        );
        expect(recordError).toHaveBeenNthCalledWith(
          1,
          'doompi_server.system_prompt_preparation_failed',
          resourceFailure,
          { session_id: session.runtime.sessionId, stage: 'resources' },
          { includeException: true },
        );
        expect(onNotice).not.toHaveBeenCalled();
        expect(streamSimple).toHaveBeenCalledTimes(providerCalls);
        expect(session.canDispatch()).toBe(false);

        const hookFailure = new Error('Selection changed while preparing the system prompt');
        const originalDispatchHook = session.host!.dispatchHook.bind(session.host!);
        const dispatchHook = vi
          .spyOn(session.host!, 'dispatchHook')
          .mockImplementation(async (event, input, signal) => {
            if (event === 'before_agent_start') throw hookFailure;
            return originalDispatchHook(event, input, signal);
          });
        await expect(session.runtime.prompt('failed prompt hooks')).rejects.toThrow('Agent submission failed: faulted');
        expect(recordError).toHaveBeenNthCalledWith(
          2,
          'doompi_server.system_prompt_preparation_failed',
          hookFailure,
          { session_id: session.runtime.sessionId, stage: 'before_agent_start hooks' },
          { includeException: true },
        );
        expect(onNotice).not.toHaveBeenCalled();
        expect(streamSimple).toHaveBeenCalledTimes(providerCalls);
        dispatchHook.mockRestore();

        for (const report of [
          () => {
            throw new Error('Telemetry failed synchronously');
          },
          async () => {
            throw new Error('Telemetry failed asynchronously');
          },
          () => new Promise<void>(() => undefined),
        ]) {
          recordError.mockImplementationOnce(report);
          readResources.mockRejectedValueOnce(resourceFailure);
          await expect(session.runtime.prompt('failed prompt diagnostics')).rejects.toThrow(
            'Agent submission failed: faulted',
          );
          expect(recordError).toHaveBeenLastCalledWith(
            'doompi_server.system_prompt_preparation_failed',
            resourceFailure,
            { session_id: session.runtime.sessionId, stage: 'resources' },
            { includeException: true },
          );
          expect(onNotice).not.toHaveBeenCalled();
          expect(streamSimple).toHaveBeenCalledTimes(providerCalls);
          expect(session.canDispatch()).toBe(false);
        }
        readResources.mockRestore();
        onNotice.mockReset();

        streamSimple.mockReturnValueOnce(response([{ type: 'text', text: 'preparation recovered' }], 'stop'));
        await session.runtime.prompt('recovered prompt preparation');
        expect(streamSimple).toHaveBeenCalledTimes(providerCalls + 1);
        expect(session.canDispatch()).toBe(true);

        vi.spyOn(session.runtime, 'replaceTools').mockRejectedValueOnce(new Error('replacement failed'));
        const applyTools = (
          session.host as unknown as { options: { applyTools(tools: readonly never[]): Promise<void> } }
        ).options.applyTools;
        await expect(applyTools([])).rejects.toThrow('replacement failed');
        expect(session.host!.status.ready).toBe(true);
        expect(() => session!.toolSurface.readSurface()).toThrow('Headless capability preparation is not ready.');
        await expect(
          session.toolSurface.invokeTool({
            revision: surface.revision,
            name: 'fixture_tool',
            arguments: { value: 'x' },
          }),
        ).rejects.toThrow('Headless capability preparation is not ready.');
      } finally {
        await session?.dispose().catch(() => undefined);
        await apis?.close().catch(() => undefined);
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(['reconciliation', 'resource-failure', 'disposal'] as const)(
    'prepares a prompt safely during %s',
    async (scenario) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-headless-preparation-'));
      const streamSimple = vi.fn<Models['streamSimple']>(() => response([{ type: 'text', text: 'done' }], 'stop'));
      vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
        getModel: () => model,
        getModels: () => [model],
        getAvailable: async () => [model],
        streamSimple,
      } as unknown as ModelRuntime);
      vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory());
      const facet: LoadedServerFacet = {
        retained: true,
        initiallyEligible: true,
        declaration: {
          packageName: '@test/preparation',
          entry: './facet.ts',
          module: './facet.mjs',
          scopes: ['session'],
          required: true,
          owners: [{ majorMode: 'development', layer: 'tools' }],
        },
        facet: {
          inject: [DOOM_HEADLESS_HOST_SERVICE],
          apply(context: Context) {
            requireDoomHeadlessHost(context).registerResource({
              name: 'preparation-context',
              kind: 'context',
              read: () => 'prepared context',
            });
          },
        },
      };
      let session: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
      let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
      let release = () => {};
      try {
        session = await createHeadlessSessionHost({
          cwd: root,
          repoRoot: root,
          sessionId: 'headless-preparation-test',
          sessionName: 'Preparation',
          agentArgs: ['--session-dir', root, '--system-prompt', 'base'],
          environment: {},
          candidates: [facet.declaration],
          selection: { majorMode: 'development', activeLayers: ['tools'], domains: [], state: {} },
        });
        apis = await serveSessionApis({
          sessionId: session.runtime.sessionId,
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
        if (scenario === 'resource-failure') {
          const failingRead = vi
            .spyOn(session.host!, 'readResources')
            .mockRejectedValue(new Error('fixture resource unavailable'));
          await expect(session.runtime.prompt('prepare failing resource')).rejects.toThrow(
            'fixture resource unavailable',
          );
          expect(streamSimple).not.toHaveBeenCalled();
          failingRead.mockRestore();
          await session.runtime.prompt('prepare recovered resource');
          expect(streamSimple).toHaveBeenCalledOnce();
        } else {
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const unsubscribe = session.host!.subscribeSelection(() => gate);
          const selecting = session.host!.select({});
          const prompted = session.runtime.prompt('prepare while selecting');
          // Attach rejection handling immediately, including on the unfixed host.
          const outcome = prompted.then(
            () => undefined,
            (error: unknown) => error,
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(streamSimple).not.toHaveBeenCalled();
          const disposing = scenario === 'disposal' ? session.dispose() : undefined;
          release();
          await selecting.catch((error: unknown) => {
            if (scenario !== 'disposal') throw error;
          });
          const result = await outcome;
          if (disposing !== undefined) {
            await disposing;
            expect(streamSimple).not.toHaveBeenCalled();
          } else {
            expect(result).toBeUndefined();
            expect(streamSimple).toHaveBeenCalledOnce();
          }
          unsubscribe();
        }
      } finally {
        release();
        await session?.dispose().catch(() => undefined);
        await apis?.close().catch(() => undefined);
        vi.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
