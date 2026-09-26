import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import {
  createExtensionRuntime,
  ModelRuntime,
  type Extension,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DOOM_HEADLESS_OWNER,
  requireDoomHeadlessHost,
  type DoomHeadlessSession,
  type DoomHeadlessTool,
} from '../../../../../src/exports/headless';
import type { DoomMcpPluginContext } from '../../../../../src/exports/mcpFacet';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '../../../../../src/exports/notification';
import type { DoomServerBundleEntry } from '../../../../../src/exports/serverFacet';
import * as directHarnessRuntime from '../../../../../src/server/directHarnessRuntime';
import * as piExtensionHost from '../../../../../src/services/piExtensionHost';
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

async function fixture(
  mcpPlugins: Parameters<typeof createHeadlessSessionHost>[0]['mcpPlugins'] = [],
  options: {
    candidates?: DoomServerBundleEntry[];
    modes?: string[];
    inheritedSelection?: Parameters<typeof createHeadlessSessionHost>[0]['inheritedSelection'];
    streamSimple?: ModelRuntime['streamSimple'];
  } = {},
): Promise<{
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
    hasConfiguredAuth: (provider: string) => provider === model.provider,
    complete: vi.fn(),
    streamSimple: options.streamSimple,
  } as unknown as ModelRuntime);
  const context = new Context();
  const host = await createHeadlessSessionHost({
    cwd,
    repoRoot: cwd,
    sessionId: 'headless-session-mapping',
    sessionName: 'Headless session mapping',
    agentArgs: [],
    environment: {},
    candidates: options.candidates ?? [],
    mcpPlugins,
    piExtensions: false,
    selection: { majorMode: 'test', activeLayers: [], domains: [], state: { 'minor-mode': options.modes ?? [] } },
    ...(options.inheritedSelection ? { inheritedSelection: options.inheritedSelection } : {}),
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

describe('session execution controls', () => {
  it('renames the durable session through the headless context', async () => {
    const current = await fixture();

    await current.session.setName?.('Remote conversation title');

    await expect(current.runtime.readState()).resolves.toMatchObject({ sessionName: 'Remote conversation title' });
  });
});
describe('request-private auxiliary model tools', () => {
  const tools = [
    {
      name: 'private_decision',
      description: 'Decide the private request.',
      parameters: Type.Object({ evidence: Type.String() }),
    },
  ];
  function response(stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
    return {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason,
      content: [
        { type: 'text', text: 'Private response' },
        { type: 'toolCall', id: 'private-call', name: 'private_decision', arguments: { evidence: 'verified' } },
      ],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }
  it('performs an auxiliary decision and wakes a second turn at the real native settled boundary', async () => {
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...response('stop'),
        content: [{ type: 'text', text: 'Work evidence recorded.' }],
      };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    });
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/idle-checker',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture([], { candidates: [candidate], streamSimple });
    const observations: Array<{ isIdle: boolean; hasPendingMessages: boolean }> = [];
    const registrations = current.context.extend({ [DOOM_HEADLESS_OWNER]: candidate });
    await registrations
      .plugin((context: Context) => {
        requireDoomHeadlessHost(context).registerHook({
          event: 'agent_settled',
          async handle(_event, execution) {
            observations.push(await execution.session.activity());
            const decision = await execution.toolCompletion!.complete(`${model.provider}/${model.id}`, {
              systemPrompt: 'Evaluate recorded evidence.',
              input: JSON.stringify(await execution.session.entries()),
              maxTokens: 128,
              tools,
            });
            await execution.session.appendCustomEntry('test-private-decision', decision);
            if (observations.length === 1) await execution.session.admitPrompt!('Continue verification.', 'prompt');
          },
        });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    const complete = vi.spyOn(current.runtime, 'completeModel').mockResolvedValue(response());
    await current.session.prompt('Start work.');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(streamSimple).toHaveBeenCalledTimes(2);
    // Settlement hooks still belong to the finishing operation until their callbacks complete.
    expect(observations).toEqual([
      { isIdle: false, hasPendingMessages: false },
      { isIdle: false, hasPendingMessages: false },
    ]);
    expect(current.host.toolSurface.readSurface().tools.some((tool) => tool.name === 'private_decision')).toBe(false);
    await vi.waitFor(async () =>
      expect(await current.session.activity()).toEqual({ isIdle: true, hasPendingMessages: false }),
    );
  });

  it('preserves a model error as a native assistant message without presenting a successful reply', async () => {
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...response('error'),
        content: [],
        errorMessage: 'Model request blocked: headless capability preparation is not ready.',
      };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'error', reason: 'error', error: message });
      stream.end();
      return stream;
    });
    const current = await fixture([], { streamSimple });
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const frames: Array<{ type?: string; message?: unknown }> = [];
    current.runtime.onPresentationFrame((frame) => frames.push(frame));

    await current.session.admitPrompt!('Voice transcript');
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'agent_settled' })));
    expect(streamSimple).toHaveBeenCalledOnce();
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'message_end',
        message: expect.objectContaining({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Model request blocked: headless capability preparation is not ready.',
        }),
      }),
    );
  });

  it('passes private tools through the auxiliary model request without registering them on either agent surface', async () => {
    const current = await fixture();
    const auxiliary = current.host.host!.context.toolCompletion!;
    const signal = new AbortController().signal;
    const request = { systemPrompt: 'Private checker', input: 'Execution evidence', maxTokens: 128, tools, signal };
    await expect(auxiliary.complete(`${model.provider}/${model.id}`, request)).rejects.toThrow('not ready');
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const complete = vi.spyOn(current.runtime, 'completeModel').mockResolvedValue(response());
    await expect(auxiliary.complete(`${model.provider}/${model.id}`, request)).resolves.toEqual({
      toolCalls: [
        { type: 'toolCall', id: 'private-call', name: 'private_decision', arguments: { evidence: 'verified' } },
      ],
      usage: response().usage,
    });
    expect(complete).toHaveBeenCalledWith(
      model,
      {
        systemPrompt: 'Private checker',
        messages: [{ role: 'user', content: 'Execution evidence', timestamp: expect.any(Number) }],
        tools,
      },
      expect.objectContaining({ signal, maxTokens: 128, maxRetries: 0 }),
    );
    expect(current.host.toolSurface.readSurface().tools.some((tool) => tool.name === 'private_decision')).toBe(false);
    expect(current.host.mcpSurface.readSurface().tools.some((tool) => tool.name === 'private_decision')).toBe(false);
    await expect(
      current.host.host!.context.textCompletion!.complete(`${model.provider}/${model.id}`, request),
    ).resolves.toBe('Private response');
    expect(complete.mock.calls.at(-1)?.[1].tools).toBeUndefined();
  });

  it.each(['error', 'aborted', 'length'] as const)(
    'rejects an auxiliary %s outcome instead of treating it as a decision',
    async (stopReason) => {
      const current = await fixture();
      await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
      vi.spyOn(current.runtime, 'completeModel').mockResolvedValue(response(stopReason));
      await expect(
        current.host.host!.context.toolCompletion!.complete(`${model.provider}/${model.id}`, {
          systemPrompt: 'Private checker',
          input: 'Execution evidence',
          maxTokens: 128,
          tools,
        }),
      ).rejects.toThrow();
    },
  );

  it('honors cancellation before a private request reaches the model', async () => {
    const current = await fixture();
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const complete = vi.spyOn(current.runtime, 'completeModel').mockResolvedValue(response());
    const controller = new AbortController();
    controller.abort();
    await expect(
      current.host.host!.context.toolCompletion!.complete(`${model.provider}/${model.id}`, {
        systemPrompt: 'Private checker',
        input: 'Execution evidence',
        maxTokens: 128,
        tools,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('headless session facet surface', () => {
  it.each([false, true])(
    'composes additive modes and selective exclusions across both tool surfaces (voice=%s)',
    async (voice) => {
      const ordinary = ['read', 'grep', 'edit', 'write', 'bash', 'task', 'subagent', 'intercom', 'ask_user_question'];
      const piNames = ['read', 'ask_user_question', 'pi_question', 'author_tool'];
      const piExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'pi' }], details: undefined }));
      const sourceInfo: Extension['sourceInfo'] = {
        path: '/extensions/test.mjs',
        source: 'test',
        scope: 'temporary',
        origin: 'top-level',
      };
      const preload: LoadExtensionsResult = {
        extensions: [
          {
            path: '/extensions/test.mjs',
            resolvedPath: '/extensions/test.mjs',
            sourceInfo,
            tools: new Map(
              piNames.map((name) => [
                name,
                {
                  definition: {
                    name,
                    label: name,
                    description: name,
                    parameters: Type.Object({}),
                    promptGuidelines: [`pi-guidance:${name}`],
                    execute: piExecute,
                  },
                  sourceInfo,
                },
              ]),
            ),
            handlers: new Map(),
            commands: new Map(),
            flags: new Map(),
            shortcuts: new Map(),
            messageRenderers: new Map(),
          },
        ],
        errors: [],
        runtime: createExtensionRuntime(),
      };
      vi.spyOn(piExtensionHost, 'preloadPiExtensions').mockResolvedValue(preload);
      const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
      const candidate: DoomServerBundleEntry = {
        packageName: '@test/additive-modes',
        entry: './server.ts',
        module: './server.mjs',
        scopes: ['session'],
        required: true,
        owners: [{ majorMode: 'test', layer: 'default' }],
      };
      const modes = ['workflow', 'computer-use', 'plan'];
      const current = await fixture([], { candidates: [candidate], modes: voice ? [...modes, 'voice-auto'] : modes });
      const replaceTools = vi.spyOn(current.runtime, 'replaceTools');
      const execute = vi.fn<DoomHeadlessTool['execute']>(async () => ({ content: [{ type: 'text', text: 'facet' }] }));
      const registrations = current.context.extend({ [DOOM_HEADLESS_OWNER]: candidate });
      await registrations
        .plugin((context: Context) => {
          const host = requireDoomHeadlessHost(context);
          for (const name of ordinary)
            host.registerTool({
              name,
              description: name,
              parameters: Type.Object({}),
              promptGuidelines: [`facet-guidance:${name}`],
              execute,
            });
          for (const [mode, name] of [
            ['workflow', 'list_workflows'],
            ['computer-use', 'computer_state'],
            ['plan', 'write_plan'],
            ['author', 'author_tool'],
          ]) {
            host.registerTool({
              name: name!,
              description: name!,
              parameters: Type.Object({}),
              when: { state: { 'minor-mode': mode! } },
              execute,
            });
          }
          host.registerToolRestriction({
            when: { state: { 'minor-mode': 'voice-auto' } },
            excludedTools: ['ask_user_question', 'pi_question'],
          });
        })
        .await();
      vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
      await current.host.activateFacets({
        root: current.context,
        installedPackages: [candidate.packageName],
        dispose: async () => {},
      });
      const names = () => current.host.toolSurface.readSurface().tools.map(({ name }) => name);
      const prompt = createRuntime.mock.calls.at(-1)![0].systemPrompt as () => Promise<string>;
      const assertSurface = async (voiceActive: boolean, workflowActive = true) => {
        const expected = [
          ...ordinary.filter((name) => !voiceActive || name !== 'ask_user_question'),
          ...(!voiceActive ? ['pi_question'] : []),
          ...(workflowActive ? ['list_workflows'] : []),
          'computer_state',
          'write_plan',
        ].sort();
        expect(names().sort()).toEqual(expected);
        expect(
          replaceTools.mock.calls
            .at(-1)![0]
            .map(({ name }) => name)
            .sort(),
        ).toEqual(expected);
        const text = await prompt();
        expect(text.includes('facet-guidance:ask_user_question')).toBe(!voiceActive);
        expect(text.includes('pi-guidance:pi_question')).toBe(!voiceActive);
        expect(text).not.toContain('pi-guidance:read');
        expect(text).not.toContain('pi-guidance:author_tool');
        const inventory = current.host.host!.getContextInventory();
        expect(
          inventory.sources.flatMap(({ tools }) => tools).find(({ name }) => name === 'ask_user_question')?.active,
        ).toBe(!voiceActive);
      };
      await assertSurface(voice);
      await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: modes });
      const previous = current.host.toolSurface.readSurface();
      const stalePiQuestion = replaceTools.mock.calls.at(-1)![0].find(({ name }) => name === 'pi_question')!;
      await assertSurface(false);
      await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: [...modes, 'voice-auto'] });
      await assertSurface(true);
      await expect(
        current.host.toolSurface.invokeTool({ revision: previous.revision, name: 'ask_user_question', arguments: {} }),
      ).rejects.toThrow('changed');
      const snapshot = current.host.toolSurface.readSurface();
      await expect(
        current.host.toolSurface.invokeTool({ revision: snapshot.revision, name: 'ask_user_question', arguments: {} }),
      ).rejects.toThrow();
      await expect(
        stalePiQuestion.execute('stale', {}, () => {}, undefined as never, {} as never, {} as never),
      ).rejects.toThrow('no longer active');
      expect(execute).not.toHaveBeenCalled();
      expect(piExecute).not.toHaveBeenCalled();
      await expect(
        current.host.toolSurface.invokeTool({ revision: snapshot.revision, name: 'read', arguments: {} }),
      ).resolves.toMatchObject({ content: [{ text: 'facet' }] });
      const applies = replaceTools.mock.calls.length;
      preload.runtime.setActiveTools(['read']);
      preload.runtime.setActiveTools(piNames);
      await vi.waitFor(() => expect(replaceTools.mock.calls.length).toBeGreaterThan(applies));
      await assertSurface(true);
      await current.host.host!.changeSelection({
        axis: 'state',
        key: 'minor-mode',
        values: ['computer-use', 'plan', 'voice-auto'],
      });
      await assertSurface(true, false);
      await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: ['computer-use', 'plan'] });
      await assertSurface(false, false);
      await registrations
        .plugin((context: Context) => {
          requireDoomHeadlessHost(context).registerToolRestriction({ allowedTools: ['read', 'ask_user_question'] });
        })
        .await();
      await current.host.host!.select({});
      expect(names().sort()).toEqual(['ask_user_question', 'read']);
      await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: [...modes, 'voice-auto'] });
      expect(names()).toEqual(['read']);
    },
  );
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
  const uiUri = 'ui://doompi/session/v1/index.html';
  async function remoteFixture(
    owner = { majorMode: 'test', layer: 'default' },
    ui: { uri?: string; toolUri?: string; duplicate?: boolean } = {},
  ) {
    const execute = vi.fn<DoomHeadlessTool['execute']>(async (..._args) => ({
      content: [{ type: 'text' as const, text: 'done' }],
    }));
    const read = vi.fn(async () => '# skill');
    const readUi = vi.fn(async () => '<!doctype html><title>Session</title>');
    const resource = {
      uri: ui.uri ?? uiUri,
      name: 'Session',
      mimeType: 'text/html;profile=mcp-app' as const,
      read: readUi,
    };
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
                _meta: { ui: { resourceUri: ui.toolUri ?? uiUri, visibility: ['model', 'app'] } },
                execute,
              },
            ],
            skills: [{ name: 'guide', description: 'Guide', read }],
            uiResources: ui.duplicate ? [resource, { ...resource }] : [resource],
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
      readUi,
      snapshot,
      invocation: { revision: snapshot.revision, name: 'remote', arguments: {} },
    };
  }

  it.each(['success', 'returned-error', 'thrown-error'] as const)(
    'dispatches one telemetry lifecycle for a remote %s without inventing model usage',
    async (outcome) => {
      const current = await remoteFixture();
      const dispatch = vi.spyOn(current.host.host!, 'dispatchHook');
      if (outcome === 'returned-error') {
        current.execute.mockResolvedValue({ content: [{ type: 'text', text: 'failed' }], isError: true });
      } else if (outcome === 'thrown-error') {
        current.execute.mockRejectedValue(new Error('failed'));
      }
      const result = await current.host.mcpSurface.invokeTool(current.invocation);
      const lifecycle = dispatch.mock.calls.filter(([name]) => name.startsWith('tool_execution_'));
      expect(lifecycle.map(([name]) => name)).toEqual(['tool_execution_start', 'tool_execution_end']);
      const start = lifecycle[0]![1];
      expect(start).toMatchObject({ toolName: 'remote', toolCallId: expect.stringMatching(/^external-/) });
      expect(lifecycle[1]![1]).toMatchObject({
        toolName: 'remote',
        toolCallId: start.toolCallId,
        isError: outcome !== 'success',
        result,
      });
      expect(dispatch.mock.calls.some(([name]) => name === 'turn_end')).toBe(false);
    },
  );
  it('preserves explicit MCP contracts and does not bypass a result-redaction hook', async () => {
    const current = await remoteFixture();
    expect(current.snapshot.tools[0]).toMatchObject({
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: uiUri, visibility: ['model', 'app'] } },
    });
    current.execute.mockResolvedValue({
      content: [{ type: 'text', text: 'sensitive' }],
      structuredContent: { status: 'sensitive' },
      _meta: { displayValue: 'sensitive' },
    });
    await expect(current.host.mcpSurface.invokeTool(current.invocation)).resolves.toMatchObject({
      structuredContent: { status: 'sensitive' },
      _meta: { displayValue: 'sensitive' },
    });
    vi.spyOn(current.host.host!, 'dispatchHook').mockImplementation(async (name) =>
      name === 'tool_result' ? [{ content: [{ type: 'text', text: 'redacted' }] }] : [],
    );
    const result = await current.host.mcpSurface.invokeTool(current.invocation);
    expect(result.content).toEqual([{ type: 'text', text: 'redacted' }]);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta).toBeUndefined();
  });

  it('does not reconcile unchanged inherited defaults at turn admission', async () => {
    const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
    const current = await fixture([], { inheritedSelection: () => ({ majorMode: 'test', domains: [] }) });
    const beforeModelRequest = createRuntime.mock.calls.at(-1)?.[0].beforeModelRequest;
    expect(beforeModelRequest).toBeDefined();
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const revision = current.host.host!.status.requestedRevision;
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    expect(current.host.host!.status.requestedRevision).toBe(revision);
    expect(current.host.host!.status.ready).toBe(true);
  });

  it('does not reconcile an unchanged selection on each turn without inherited defaults', async () => {
    const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
    const current = await fixture();
    const beforeModelRequest = createRuntime.mock.calls.at(-1)?.[0].beforeModelRequest;
    expect(beforeModelRequest).toBeDefined();
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const revision = current.host.host!.status.requestedRevision;
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    expect(current.host.host!.status.requestedRevision).toBe(revision);
    expect(current.host.host!.status.ready).toBe(true);
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

  it('withdraws a restricted tool from the remote surface and restores it when the mode clears', async () => {
    const execute = vi.fn<DoomHeadlessTool['execute']>(async (..._args) => ({
      content: [{ type: 'text' as const, text: 'done' }],
    }));
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/mcp-restriction',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture(
      [
        {
          declaration: {
            packageName: 'test',
            entry: './mcp.mjs',
            module: './mcp.mjs',
            sha256: '0'.repeat(64),
            owners: [{ majorMode: 'test', layer: 'default' }],
          },
          plugin: {
            name: 'test',
            session: {
              tools: [{ name: 'edit', description: 'Edit', parameters: Type.Object({}), execute }],
            },
          },
        },
      ],
      { candidates: [candidate], modes: [] },
    );
    vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    const remoteNames = () => current.host.mcpSurface.readSurface().tools.map(({ name }) => name);
    expect(remoteNames()).toEqual(['edit']);

    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        requireDoomHeadlessHost(context).registerToolRestriction({
          when: { state: { 'minor-mode': 'plan' } },
          excludedTools: ['edit'],
        });
      })
      .await();
    await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: ['plan'] });
    expect(remoteNames()).toEqual([]);
    const withdrawn = current.host.mcpSurface.readSurface();
    await expect(
      current.host.mcpSurface.invokeTool({ revision: withdrawn.revision, name: 'edit', arguments: {} }),
    ).rejects.toThrow("Tool 'edit' is not active");

    await current.host.host!.changeSelection({ axis: 'state', key: 'minor-mode', values: [] });
    expect(remoteNames()).toEqual(['edit']);
  });
  it.each([
    { majorMode: 'other', layer: 'default' },
    { majorMode: 'test', layer: 'inactive' },
  ])('excludes declarations owned by $majorMode/$layer', async (owner) => {
    const current = await remoteFixture(owner);

    expect(current.snapshot.tools).toEqual([]);
    expect(current.snapshot.skills).toEqual([]);
    expect(current.snapshot.uiResources).toEqual([]);
    expect(current.readUi).not.toHaveBeenCalled();
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
  it('loads static UI lazily without passing session execution context', async () => {
    const current = await remoteFixture();
    expect(current.snapshot.uiResources).toEqual([
      { uri: uiUri, name: 'Session', mimeType: 'text/html;profile=mcp-app' },
    ]);
    expect(current.readUi).not.toHaveBeenCalled();
    await expect(current.host.mcpSurface.readUiResource!(current.snapshot.revision, uiUri)).resolves.toBe(
      '<!doctype html><title>Session</title>',
    );
    expect(current.readUi).toHaveBeenCalledWith();
    await expect(current.host.mcpSurface.readUiResource!(current.snapshot.revision - 1, uiUri)).rejects.toThrow(
      'changed',
    );
    await expect(
      current.host.mcpSurface.readUiResource!(current.snapshot.revision, 'ui://missing/view'),
    ).rejects.toThrow('not active');
  });

  it.each(['selection', 'disposal'] as const)('rejects UI returned after %s changes', async (change) => {
    const current = await remoteFixture();
    current.readUi.mockImplementationOnce(async () => {
      if (change === 'disposal') await current.host.dispose();
      else await current.host.host!.changeSelection({ axis: 'state', key: 'test', values: ['other'] });
      return 'stale';
    });
    await expect(current.host.mcpSurface.readUiResource!(current.snapshot.revision, uiUri)).rejects.toThrow();
  });

  it.each([
    { uri: 'https://untrusted.example/widget.html' },
    { uri: 'ui://doompi/session.html?session=private' },
    { duplicate: true },
    { toolUri: 'ui://another-package/view.html' },
  ])('rejects invalid or unowned UI registrations: %j', async (ui) => {
    await expect(remoteFixture(undefined, ui)).rejects.toThrow();
  });
});
