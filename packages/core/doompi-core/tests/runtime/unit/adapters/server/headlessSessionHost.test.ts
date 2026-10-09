import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

import { DOOM_BACKGROUND_WORK_SERVICE } from '../../../../../src/exports/backgroundWork';
import {
  DOOM_HEADLESS_OWNER,
  requireDoomHeadlessHost,
  toDoomHeadlessToolResult,
  type DoomHeadlessSession,
  type DoomHeadlessTool,
} from '../../../../../src/exports/headless';
import type { DoomMcpPluginContext } from '../../../../../src/exports/mcpFacet';
import { DOOM_MCP_STATUS_SERVICE } from '../../../../../src/exports/mcpStatus';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '../../../../../src/exports/notification';
import {
  createDoomServerHost,
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerBundleEntry,
  type DoomServerFacet,
} from '../../../../../src/exports/serverFacet';
import * as directHarnessRuntime from '../../../../../src/server/directHarnessRuntime';
import { createHeadlessHub } from '../../../../../src/server/headlessHub';
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
    allowedTools?: readonly string[];
    initialFastMode?: boolean;
    piExtensionPaths?: string[];
    onNotice?: (notice: string) => void;
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
  const bridge = path.join(agentDir, 'cordis-host.mjs');
  if (options.piExtensionPaths) {
    const entry = pathToFileURL(path.resolve(import.meta.dirname, '../../../../../dist/cordisHost.mjs')).href;
    fs.writeFileSync(
      bridge,
      `import {installDoomCordisHost} from ${JSON.stringify(entry)};
export default async (pi) => { await installDoomCordisHost(pi, {mode: 'composed'}); };`,
    );
  }
  const host = await createHeadlessSessionHost({
    cwd,
    repoRoot: cwd,
    sessionId: 'headless-session-mapping',
    sessionName: 'Headless session mapping',
    ...(options.initialFastMode === undefined ? {} : { initialFastMode: options.initialFastMode }),
    agentArgs: [],
    environment: {},
    candidates: options.candidates ?? [],
    mcpPlugins,
    piExtensions: options.piExtensionPaths !== undefined,
    piExtensionPaths: options.piExtensionPaths ? [bridge, ...options.piExtensionPaths] : undefined,
    onNotice: options.onNotice,
    selection: { majorMode: 'test', activeLayers: [], domains: [], state: { 'minor-mode': options.modes ?? [] } },
    ...(options.inheritedSelection ? { inheritedSelection: options.inheritedSelection } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
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

describe('real host and hub acceptance', () => {
  async function controlledHost(candidates: DoomServerBundleEntry[] = []) {
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      streams.push(stream);
      options?.signal?.addEventListener(
        'abort',
        () => {
          stream.push({ type: 'error', reason: 'aborted', error: { ...message(''), stopReason: 'aborted' } });
          stream.end();
        },
        { once: true },
      );
      return stream;
    });
    const current = await fixture([], { streamSimple, candidates });
    await current.host.activateFacets({
      root: current.context,
      installedPackages: candidates.map(({ packageName }) => packageName),
      dispose: async () => {},
    });
    const hub = createHeadlessHub({ manager: { closeSession: async () => {} } as never });
    hub.register({
      id: current.runtime.sessionId,
      name: 'Acceptance',
      cwd: current.host.host!.context.cwd,
      createdAt: new Date(0).toISOString(),
      host: current.host,
    });
    cleanup.push(() => hub.close());
    function message(text: string): AssistantMessage {
      return {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 100,
        stopReason: 'stop',
        content: [{ type: 'text', text }],
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
    function finish(index: number, text: string) {
      const response = message(text);
      streams[index]!.push({ type: 'done', reason: 'stop', message: response });
      streams[index]!.end();
    }
    return { ...current, hub, streams, streamSimple, message, finish };
  }

  it('delivers aggregate content to a delayed listener through an actual provider run', async () => {
    const current = await controlledHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.unshift(release);
    let blocked = false;
    current.runtime.onEvent(async (event) => {
      if (event.type === 'message_start' && event.message.role === 'assistant') {
        blocked = true;
        await gate;
      }
    });
    const admitted = await current.runtime.submitPrompt('Start acceptance');
    await vi.waitFor(() => expect(current.streams).toHaveLength(1));
    const frames: Record<string, unknown>[] = [];
    current.host.onPresentationFrame!((frame) => frames.push(frame));
    const partial = current.message('Already accumulated');
    current.streams[0]!.push({ type: 'start', partial });
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'message_start',
          message: expect.objectContaining({ content: partial.content }),
        }),
      ),
    );
    expect(current.hub.session(current.runtime.sessionId)?.phase).toBe('turn');
    await vi.waitFor(() => expect(blocked).toBe(true));
    current.streams[0]!.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: ' later',
      partial: current.message('Already accumulated later'),
    });
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: 'message_update',
          message: expect.objectContaining({ content: [{ type: 'text', text: 'Already accumulated later' }] }),
        }),
      ),
    );
    expect(frames.findIndex(({ type }) => type === 'message_start')).toBeLessThan(
      frames.findIndex(({ type }) => type === 'message_update'),
    );
    current.finish(0, 'Actual final reply');
    release();
    await admitted.settled;
    await vi.waitFor(() => expect(current.hub.session(current.runtime.sessionId)?.phase).toBe('idle'));
    const { entries } = await current.runtime.readEntries();
    expect(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')).toHaveLength(1);
  });

  it('delivers busy input at the next boundary and refuses a promotion aimed at the older run', async () => {
    const current = await controlledHost();
    const first = await current.runtime.submitPrompt('First run');
    await vi.waitFor(() => expect(current.streams).toHaveLength(1));
    const oldOperation = (await current.runtime.readLifecycle()).operation!.id;
    const busy = await current.runtime.submitInternalMessage('Busy completion');
    expect((await current.runtime.readLifecycle()).queue).toEqual([]);
    let busySettled = false;
    void busy.settled.then(() => {
      busySettled = true;
    });
    expect(busySettled).toBe(false);
    current.finish(0, 'First boundary');
    await vi.waitFor(() => expect(current.streams.length).toBeGreaterThanOrEqual(2));
    current.finish(1, 'Busy boundary');
    await Promise.all([first.settled, busy.settled]);
    const next = await current.runtime.submitPrompt('Replacement run');
    await vi.waitFor(() => expect(current.streams).toHaveLength(3));
    const queued = await current.runtime.enqueueAutomatic('Not for the replacement');
    expect((await current.runtime.readLifecycle()).operation?.id).not.toBe(oldOperation);
    await expect(current.runtime.promoteQueued(queued.id, oldOperation)).resolves.toBe('target_changed');
    await expect(current.runtime.removeQueued(queued.id)).resolves.toBe('removed');
    current.finish(2, 'Replacement boundary');
    await next.settled;
    await vi.waitFor(async () =>
      expect(await current.session.activity()).toEqual({ isIdle: true, hasPendingMessages: false }),
    );
    const { entries } = await current.runtime.readEntries();
    const users = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user');
    expect(users).toHaveLength(3);
    expect(current.hub.session(current.runtime.sessionId)?.phase).toBe('idle');
  });

  it('delivers an environmental completion received during an actual tool round to the next request', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/acceptance-tool',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await controlledHost([candidate]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.unshift(release);
    let started = false;
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        requireDoomHeadlessHost(context).registerTool({
          name: 'acceptance_tool',
          description: 'Controlled acceptance tool.',
          parameters: Type.Object({}),
          execute: async () => {
            started = true;
            await gate;
            return { content: [{ type: 'text', text: 'Tool completed' }] };
          },
        });
      })
      .await();
    const first = await current.runtime.submitPrompt('Execute the acceptance tool');
    await vi.waitFor(() => expect(current.streams).toHaveLength(1));
    current.streams[0]!.push({
      type: 'done',
      reason: 'toolUse',
      message: {
        ...current.message(''),
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'acceptance-call', name: 'acceptance_tool', arguments: {} }],
      },
    });
    current.streams[0]!.end();
    await vi.waitFor(() => expect(started).toBe(true));
    const completion = await current.runtime.submitInternalMessage('Environmental tool completion');
    expect((await current.runtime.readLifecycle()).queue).toEqual([]);
    expect(current.streams).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(current.streams).toHaveLength(2));
    expect(JSON.stringify(current.streamSimple.mock.calls[1]![1])).toContain('Environmental tool completion');
    current.finish(1, 'Tool round response');
    await Promise.all([first.settled, completion.settled]);
    await vi.waitFor(() => expect(current.hub.session(current.runtime.sessionId)?.phase).toBe('idle'));
  });

  it('admits one logical internal successor without an operator queue row', async () => {
    const current = await controlledHost();
    const frames: Record<string, unknown>[] = [];
    current.host.onPresentationFrame((frame) => frames.push(frame));
    const first = await current.runtime.submitPrompt('Initial loop work');
    await vi.waitFor(() => expect(current.streams).toHaveLength(1));
    const successor = await current.runtime.submitInternalMessage('One loop successor', 'followUp');
    expect((await current.runtime.readLifecycle()).queue).toEqual([]);
    current.finish(0, 'First loop boundary');
    await vi.waitFor(() => expect(current.streams).toHaveLength(2));
    current.finish(1, 'Successor loop boundary');
    await Promise.all([first.settled, successor.settled]);
    await vi.waitFor(async () =>
      expect(await current.session.activity()).toEqual({ isIdle: true, hasPendingMessages: false }),
    );
    expect(current.streamSimple).toHaveBeenCalledTimes(2);
    expect(frames.filter(({ type }) => type === 'agent_start')).toHaveLength(1);
    expect(frames.filter(({ type }) => type === 'agent_end')).toHaveLength(1);
    expect(frames.filter(({ type }) => type === 'agent_settled')).toHaveLength(1);
    const { entries } = await current.runtime.readEntries();
    expect(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(2);
    expect((await current.runtime.readLifecycle()).queue).toEqual([]);
  });

  it.each(['abort', 'failure'] as const)(
    'preserves internal input once after provider %s without waking another run',
    async (outcome) => {
      const current = await controlledHost();
      const first = await current.runtime.submitPrompt('Interrupted request');
      void first.settled.catch(() => undefined);
      await vi.waitFor(() => expect(current.streams).toHaveLength(1));
      const pending = await current.runtime.submitInternalMessage('Retained internal input', 'followUp');
      expect((await current.runtime.readState()).pendingMessageCount).toBe(1);
      expect(await current.session.activity()).toMatchObject({ hasPendingMessages: true });
      if (outcome === 'abort') await current.runtime.abort();
      else {
        current.streams[0]!.push({
          type: 'error',
          reason: 'error',
          error: { ...current.message(''), stopReason: 'error', errorMessage: 'Controlled provider failure' },
        });
        current.streams[0]!.end();
      }
      await pending.settled;
      expect(current.streams).toHaveLength(1);
      expect((await current.runtime.readState()).pendingMessageCount).toBe(0);
      expect(await current.session.activity()).toEqual({ isIdle: true, hasPendingMessages: false });
      const recovery = await current.runtime.submitPrompt('Ordinary recovery prompt');
      await vi.waitFor(() => expect(current.streams).toHaveLength(2));
      expect(JSON.stringify(current.streamSimple.mock.calls[1]![1]).split('Retained internal input')).toHaveLength(2);
      current.finish(1, 'Recovered response');
      await recovery.settled;
    },
  );

  it('does not publish an older successful compaction as the result of a failed compaction', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/acceptance-compaction',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await controlledHost([candidate]);
    let attempts = 0;
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        requireDoomHeadlessHost(context).registerHook({
          event: 'session_before_compact',
          handle: () => {
            attempts += 1;
            if (attempts > 1) throw new Error('Acceptance compaction failed');
            return { compaction: { summary: 'Older successful summary', tokensBefore: 42, retainedTail: [] } };
          },
        });
      })
      .await();
    const first = await current.runtime.submitPrompt('Content to compact');
    await vi.waitFor(() => expect(current.streams).toHaveLength(1));
    current.finish(0, 'Compaction source');
    await first.settled;
    const frames: Record<string, unknown>[] = [];
    current.runtime.onEvent((frame) => {
      frames.push(frame);
    });
    await current.runtime.compact();
    const older = (await current.runtime.readEntries()).entries.filter((entry) => entry.type === 'compaction');
    expect(older).toHaveLength(1);
    await current.runtime.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'New content after older compaction' }],
      timestamp: 200,
    });
    await expect(current.runtime.compact()).rejects.toThrow();
    await vi.waitFor(() => expect(frames.filter(({ type }) => type === 'compaction_end')).toHaveLength(2));
    const end = frames.filter(({ type }) => type === 'compaction_end').at(-1)!;
    expect(end).toMatchObject({ status: 'failed' });
    expect(end.entryId).toBeUndefined();
    expect((await current.runtime.readEntries()).entries.filter((entry) => entry.type === 'compaction')).toEqual(older);
  });
});

describe('session execution controls', () => {
  it('reads only its own coordinator and keeps missing coordination unknown', async () => {
    const { host, context } = await fixture();
    expect(await host.readExecutionState?.()).toEqual({ isIdle: true, hasPendingMessages: false });
    const snapshot = vi.fn(() => ({
      items: [{ id: 'child-run', sessionId: 'headless-session-mapping', provider: 'team-direct-runs' }],
      errors: [],
    }));
    context.provide(DOOM_BACKGROUND_WORK_SERVICE, { generation: 'test', register: vi.fn(), snapshot });
    expect(await host.readExecutionState?.()).toMatchObject({
      isIdle: true,
      hasPendingMessages: false,
      backgroundWork: { items: [{ id: 'child-run' }], errors: [] },
    });
    expect(snapshot).toHaveBeenCalledWith('headless-session-mapping');
  });
  it.each([true, false])('seeds the creation Fast snapshot %s', async (initialFastMode) => {
    const current = await fixture([], { initialFastMode });
    await expect(current.runtime.readState()).resolves.toMatchObject({ fastMode: initialFastMode });
  });

  it('defaults a fresh top-level session to Fast off', async () => {
    const current = await fixture();
    await expect(current.runtime.readState()).resolves.toMatchObject({ fastMode: false });
  });

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

    await current.session.admitPrompt!('Voice transcript', undefined, 'operator');
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
  it('emits both configured MCP declarations with complete schemas in the actual main model request', async () => {
    const parameters = Type.Object(
      {
        query: Type.String({ minLength: 1, description: 'Search expression' }),
        filters: Type.Optional(Type.Object({ tags: Type.Array(Type.String()), limit: Type.Integer({ minimum: 1 }) })),
      },
      { additionalProperties: false },
    );
    const declarations = ['personal', 'work'].map((server) => ({
      name: `${server}_search`,
      description: `Search ${server} account`,
      parameters,
    }));
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done' }],
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
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/direct-mcp',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture([], { candidates: [candidate], streamSimple });
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        for (const tool of declarations)
          requireDoomHeadlessHost(context).registerTool({ ...tool, execute: async () => ({ content: [] }) });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    await current.session.prompt('Inspect available search tools.');
    expect(streamSimple).toHaveBeenCalledOnce();
    // Pi 1.0 carries declarations as transcript tool deltas, not context.tools.
    const emitted = streamSimple.mock.calls[0]![1].messages.flatMap((message) =>
      'toolsAdded' in message ? (message.toolsAdded ?? []) : [],
    );
    expect(emitted.map(({ name }) => name)).toEqual(['personal_search', 'work_search']);
    expect(emitted.map(({ name, description, parameters }) => ({ name, description, parameters }))).toEqual(
      declarations,
    );
  });

  it('attributes registered MCP names by exact status mapping, without changing package eligibility', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/mcp-owner',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture([], { candidates: [candidate] });
    current.context.provide(DOOM_MCP_STATUS_SERVICE, {
      generation: 'test',
      getSnapshot: () => ({
        servers: [
          { name: 'configured-account', state: 'connected', tools: ['opaque_registered_name'], resourceCount: 0 },
        ],
      }),
    });
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        const host = requireDoomHeadlessHost(context);
        for (const name of ['opaque_registered_name', 'configured_account_not_mcp'])
          host.registerTool({
            name,
            description: 'Complete description',
            parameters: Type.Object({ query: Type.String() }),
            execute: async () => ({ content: [] }),
          });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    const inventory = current.host.host!.getContextInventory();
    expect(inventory.sources.find((source) => source.kind === 'mcp')).toMatchObject({
      key: 'mcp:configured-account',
      packageName: candidate.packageName,
      tools: [{ name: 'opaque_registered_name', active: true }],
    });
    expect(inventory.sources.find((source) => source.kind === 'extension')?.tools.map((tool) => tool.name)).toEqual([
      'configured_account_not_mcp',
    ]);
    expect(inventory.attribution['configured-account']).toEqual(inventory.attribution[candidate.packageName]);
  });

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
  it('keeps every tool outside the session allowlist off the agent surface', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/allowlist',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture([], { candidates: [candidate], allowedTools: ['read', 'launch_workflow'] });
    const execute = vi.fn<DoomHeadlessTool['execute']>(async () => ({ content: [{ type: 'text', text: 'facet' }] }));
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        const host = requireDoomHeadlessHost(context);
        for (const name of ['read', 'edit', 'write', 'launch_workflow'])
          host.registerTool({ name, description: name, parameters: Type.Object({}), execute });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });

    const surface = current.host.toolSurface.readSurface();
    expect(surface.tools.map(({ name }) => name).sort()).toEqual(['launch_workflow', 'read']);
    await expect(
      current.host.toolSurface.invokeTool({ revision: surface.revision, name: 'edit', arguments: {} }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps prompt and admitPrompt deliveries onto the runtime', async () => {
    const { session, runtime } = await fixture();
    const internal = vi.spyOn(runtime, 'submitInternalMessage').mockResolvedValue({ settled: Promise.resolve() });
    const steer = vi.spyOn(runtime, 'steer').mockResolvedValue(undefined);
    const followUp = vi.spyOn(runtime, 'followUp').mockResolvedValue(undefined);
    const submitPrompt = vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.resolve() });
    const submitUserPrompt = vi.spyOn(runtime, 'submitUserPrompt').mockResolvedValue({ settled: Promise.resolve() });

    // Facet prompts use operator preflight and await settlement.
    await session.prompt('steered', 'steer');
    await session.prompt('queued', 'followUp');
    await session.prompt('plain');
    // admitPrompt returns at admission, and 'steer' also wakes an idle agent.
    await session.admitPrompt!('admitted steer', 'steer', 'operator');
    // Operator follow-up uses the public queue rather than internal admission.
    await session.admitPrompt!('admitted follow up', 'followUp', 'operator');
    await session.admitPrompt!('admitted plain', undefined, 'operator');
    await session.admitPrompt!('interrupt now', 'interrupt', 'operator');

    expect(internal).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledExactlyOnceWith('admitted follow up');
    expect(submitPrompt.mock.calls).toEqual([
      ['steered', undefined, 'steer'],
      ['queued', undefined, 'followUp'],
      ['plain', undefined, undefined],
      ['admitted steer', undefined, 'steer'],
      ['admitted plain', undefined, undefined],
    ]);
    expect(submitUserPrompt).toHaveBeenCalledExactlyOnceWith('interrupt now');
  });

  it('dispatches a facet prompt command without admitting a model turn', async () => {
    const current = await fixture();
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    vi.spyOn(current.host.host!, 'listCommands').mockReturnValue([{ name: 'inspect', description: 'Inspect state' }]);
    const dispatch = vi.spyOn(current.host.host!, 'dispatchCommand').mockResolvedValue(undefined);
    const internal = vi.spyOn(current.runtime, 'submitInternalMessage');
    const stream = vi.spyOn(current.runtime, 'completeModel');

    await current.session.prompt('/inspect details');

    expect(dispatch).toHaveBeenCalledExactlyOnceWith('inspect', 'details');
    expect(internal).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect((await current.runtime.readLifecycle()).queue).toEqual([]);
  });

  it('propagates operator paused-admission rejection without falling back to internal admission', async () => {
    const { session, runtime } = await fixture();
    vi.spyOn(runtime, 'submitPrompt').mockRejectedValue(new Error('The queue is paused'));
    const internal = vi.spyOn(runtime, 'submitInternalMessage').mockResolvedValue({ settled: Promise.resolve() });

    await expect(session.prompt('ordinary facet input')).rejects.toThrow('The queue is paused');
    expect(internal).not.toHaveBeenCalled();
  });

  it('awaits facet prompt settlement and propagates its failure', async () => {
    const { session, runtime } = await fixture();
    let rejectSettlement!: (error: Error) => void;
    const settled = new Promise<void>((_resolve, reject) => {
      rejectSettlement = reject;
    });
    const submit = vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled });
    const internal = vi.spyOn(runtime, 'submitInternalMessage').mockResolvedValue({ settled: Promise.resolve() });
    const finished = vi.fn();
    const pending = session.prompt('ordinary facet input').finally(finished);
    const result = expect(pending).rejects.toThrow('turn failed');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    rejectSettlement(new Error('turn failed'));
    await result;
    expect(internal).not.toHaveBeenCalled();
  });

  it('admits default internal continuations without using the operator queue', async () => {
    const { session, runtime } = await fixture();
    const internal = vi.spyOn(runtime, 'submitInternalMessage').mockResolvedValue({ settled: Promise.resolve() });
    const submit = vi.spyOn(runtime, 'submitPrompt');
    const followUp = vi.spyOn(runtime, 'followUp');
    const steer = vi.spyOn(runtime, 'steer');

    await session.admitPrompt!('continue');
    await session.admitPrompt!('result', 'followUp');
    await session.admitPrompt!('redirect', 'steer');
    await session.admitPrompt!('runner finished', 'steer', undefined, 'runner-completion');

    expect(internal.mock.calls).toEqual([
      ['continue', 'followUp', undefined],
      ['result', 'followUp', undefined],
      ['redirect', 'steer', undefined],
      ['runner finished', 'steer', 'runner-completion'],
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it('reports an admitted prompt that fails after admission to the operator', async () => {
    const { session, runtime } = await fixture();
    vi.spyOn(runtime, 'submitPrompt').mockResolvedValue({ settled: Promise.reject(new Error('turn failed')) });
    const appendCustomEntry = vi.spyOn(runtime, 'appendCustomEntry').mockResolvedValue('entry');

    await session.admitPrompt!('admitted', undefined, 'operator');
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
    activate = true,
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
    if (activate) {
      await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    }
    let snapshot = activate ? current.host.mcpSurface.readSurface() : undefined;
    return {
      ...current,
      execute,
      read,
      readUi,
      get snapshot() {
        return (snapshot ??= current.host.mcpSurface.readSurface());
      },
      get invocation() {
        snapshot ??= current.host.mcpSurface.readSurface();
        return { revision: snapshot.revision, name: 'remote', arguments: {} };
      },
    };
  }

  it('awaits real startup recovery admission before the first idle MCP invocation', async () => {
    const current = await remoteFixture(undefined, {}, false);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let armed = false;
    let blocked = false;
    let activated = false;
    const host = current.host.host!;
    const dispatchHook = host.dispatchHook.bind(host);
    vi.spyOn(host, 'dispatchHook').mockImplementation(async (...args) => {
      const result = await dispatchHook(...args);
      if (args[0] === 'session_start') armed = true;
      return result;
    });
    const mutate = current.runtime.session.commit.bind(current.runtime.session);
    vi.spyOn(current.runtime.session, 'commit').mockImplementation(async (...args) => {
      if (armed && !blocked) {
        blocked = true;
        entered();
        await barrier;
      }
      return mutate(...args);
    });
    const activation = current.host
      .activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} })
      .then(() => {
        activated = true;
      });
    try {
      await reached;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(activated).toBe(false);
      release();
      await activation;
      const surface = current.host.mcpSurface.readSurface();
      await expect(
        current.host.mcpSurface.invokeTool({ revision: surface.revision, name: 'remote', arguments: {} }),
      ).resolves.toMatchObject({ content: [{ type: 'text', text: 'done' }] });
      expect(current.execute).toHaveBeenCalledOnce();
    } finally {
      release();
      await activation;
    }
  });

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
      details: { server: 'fixture', app: { result: { _meta: { privateValue: 'sensitive' } } } },
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
    expect(result.details).toEqual({ server: 'fixture' });
  });

  it('does not reconcile unchanged inherited defaults at turn admission', async () => {
    const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
    const current = await fixture([], { inheritedSelection: () => ({ majorMode: 'test', domains: [] }) });
    const beforeModelRequest = createRuntime.mock.calls.at(-1)?.[0].beforeModelRequest;
    expect(beforeModelRequest).toBeDefined();
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
    await current.host.activateFacets({ root: current.context, installedPackages: [], dispose: async () => {} });
    const revision = current.host.host!.status.requestedRevision;
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    await beforeModelRequest!({ phase: 'turn' } as never, undefined as never);
    expect(current.host.host!.status.requestedRevision).toBe(revision);
    expect(current.host.host!.status.ready).toBe(true);
  });

  it('settles tool registrations triggered by inherited selection before model admission', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/selection-tools',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
    const current = await fixture([], {
      candidates: [candidate],
      inheritedSelection: () => ({ domains: ['apps'] }),
    });
    const beforeModelRequest = createRuntime.mock.calls.at(-1)![0].beforeModelRequest!;
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        const host = requireDoomHeadlessHost(context);
        let registered = false;
        return host.subscribeSelection((selection) => {
          if (registered || !selection.domains.includes('apps')) return;
          registered = true;
          host.registerTool({
            name: 'selected_app_tool',
            description: 'Selection-owned tool',
            parameters: Type.Object({}),
            execute: async () => ({ content: [] }),
          });
        });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });

    await beforeModelRequest({ phase: 'turn' } as never, undefined as never);
    expect(current.host.canDispatch()).toBe(true);
    expect(current.host.toolSurface.readSurface().tools.map((tool) => tool.name)).toContain('selected_app_tool');
    await expect(current.host.host!.dispatchHook('context', {})).resolves.toEqual([]);
  });

  it('keeps app-only tools admitted without advertising them to the model', async () => {
    const candidate: DoomServerBundleEntry = {
      packageName: '@test/app-surface',
      entry: './server.ts',
      module: './server.mjs',
      scopes: ['session'],
      required: true,
      owners: [{ majorMode: 'test', layer: 'default' }],
    };
    const current = await fixture([], { candidates: [candidate] });
    const replaceTools = vi.spyOn(current.runtime, 'replaceTools');
    const execute = vi.fn<DoomHeadlessTool['execute']>(async () => ({ content: [{ type: 'text', text: 'done' }] }));
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        const host = requireDoomHeadlessHost(context);
        for (const [name, visibility] of [
          ['app_action', ['app']],
          ['ordinary', undefined],
          ['model_only', ['model']],
          ['hidden', []],
        ] as const)
          host.registerTool({
            name,
            description: name,
            parameters: Type.Object({}),
            ...(visibility === undefined ? {} : { _meta: { ui: { visibility: [...visibility] } } }),
            promptGuidelines: [`guidance:${name}`],
            execute,
          });
      })
      .await();
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    expect(
      replaceTools.mock.calls
        .at(-1)![0]
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['model_only', 'ordinary']);
    const inventory = current.host.host!.getContextInventory();
    expect(
      inventory.sources
        .flatMap(({ tools }) => tools)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(['model_only', 'ordinary']);
    expect(
      current.host.host!.inspectCapabilities().capabilities.find(({ name }) => name === 'app_action'),
    ).toMatchObject({ active: true, discoverable: false });
    const surface = requireDoomHeadlessHost(current.context).toolSurface!;
    const snapshot = surface.readSurface();
    expect(snapshot.tools.find(({ name }) => name === 'app_action')).toMatchObject({
      _meta: { ui: { visibility: ['app'] } },
    });
    const authorize = vi.fn();
    const admission = vi.spyOn(current.runtime, 'runExternalOperation');
    await surface.invokeTool({ revision: snapshot.revision, name: 'app_action', arguments: {}, authorize });
    expect(admission.mock.calls[0]![1]?.waitMs).toBeUndefined();
    expect(authorize).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      surface.invokeTool({
        revision: snapshot.revision,
        name: 'app_action',
        arguments: {},
        authorize: () => {
          throw new Error('denied');
        },
      }),
    ).rejects.toThrow('denied');
    expect(execute).toHaveBeenCalledOnce();
    await current.host.host!.changeSelection({ axis: 'majorMode', majorMode: 'other' });
    await expect(
      surface.invokeTool({ revision: snapshot.revision, name: 'app_action', arguments: {} }),
    ).rejects.toThrow();
  });

  it('preserves component metadata when narrowing a tool result', () => {
    expect(
      toDoomHeadlessToolResult({
        content: [],
        structuredContent: { visible: true },
        _meta: { privateValue: 'private' },
      }),
    ).toEqual({
      content: [],
      details: undefined,
      structuredContent: { visible: true },
      _meta: { privateValue: 'private' },
    });
    expect(
      toDoomHeadlessToolResult({ content: [], structuredContent: ['not-an-object'] }).structuredContent,
    ).toBeUndefined();
  });

  it('keeps the remote surface empty without explicit declarations', async () => {
    const current = await fixture();
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

  it.each(['grant', 'selection', 'cancellation'] as const)(
    'rejects %s changes during remote admission before any tool hook',
    async (change) => {
      const current = await remoteFixture();
      const controller = new AbortController();
      const dispatchHook = vi.spyOn(current.host.host!, 'dispatchHook');
      const original = current.runtime.runExternalOperation.bind(current.runtime);
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admission = vi
        .spyOn(current.runtime, 'runExternalOperation')
        .mockImplementationOnce(async (work, options) => {
          expect(options).toMatchObject({ waitMs: 30_000, signal: expect.any(AbortSignal) });
          entered();
          await barrier;
          return original(work, options);
        });
      let granted = true;
      const call = current.host.mcpSurface.invokeTool({
        ...current.invocation,
        signal: controller.signal,
        authorize: () => {
          if (!granted) throw new Error('revoked');
        },
      });
      const rejected = expect(call).rejects.toThrow();
      await waiting;
      if (change === 'grant') granted = false;
      else if (change === 'selection')
        await current.host.host!.changeSelection({ axis: 'state', key: 'test', values: ['other'] });
      else controller.abort();
      release();
      await rejected;
      expect(admission).toHaveBeenCalledOnce();
      expect(dispatchHook.mock.calls.some(([name]) => name === 'tool_call')).toBe(false);
      expect(current.execute).not.toHaveBeenCalled();
    },
  );

  it('reauthorizes before and after tool hooks and never executes on denial', async () => {
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
          if (order.length > 1) throw new Error('revoked');
        },
      }),
    ).rejects.toThrow('revoked');
    expect(order).toEqual(['authorize', 'hook', 'authorize']);
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
      const dispatchHook = vi.spyOn(current.host.host!, 'dispatchHook');
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
      expect(dispatchHook.mock.calls.some(([event]) => event === 'tool_result')).toBe(false);
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

describe('real headless parent hook routing', () => {
  const hookDist = path.resolve(import.meta.dirname, '../../../../../../../default/doompi-hook/dist');
  const configDist = path.resolve(import.meta.dirname, '../../../../../../../foundations/doompi-config/dist');
  const candidate: DoomServerBundleEntry = {
    packageName: '@agimon-ai/doompi-hook',
    entry: './generated/server.ts',
    module: './dist/extensions/server.mjs',
    scopes: ['session'],
    required: true,
    owners: [{ majorMode: 'test', layer: 'default' }],
  };

  async function parent(
    moduleBody: string,
    streamSimple?: ModelRuntime['streamSimple'],
    mcpPlugins: Parameters<typeof fixture>[0] = [],
    events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
  ) {
    const notices: string[] = [];
    const current = await fixture(mcpPlugins, {
      onNotice: (notice) => notices.push(notice),
      candidates: [candidate],
      piExtensionPaths: [path.join(hookDist, 'extensions/pi.mjs')],
      streamSimple,
    });
    const cwd = current.host.host!.context.cwd;
    vi.stubEnv('HOME', path.dirname(cwd));
    const source = path.join(cwd, 'hook.ts');
    const artifact = path.join(cwd, 'hook.mjs');
    const descriptor = path.join(cwd, 'modules.json');
    const log = path.join(cwd, 'proof.jsonl');
    fs.mkdirSync(path.join(cwd, '.doom'));
    fs.writeFileSync(
      artifact,
      `import fs from 'node:fs';
const record = (phase, ctx) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase, sessionId: ctx?.sessionId}) + '\\n');
export default {setup() { record('setup'); ${moduleBody} }};`,
    );
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, modules: [{ source, artifact }] }));
    fs.writeFileSync(
      path.join(cwd, '.doom/hooks.yaml'),
      `groups:\n  proof:\n    hooks:\n${events
        .map((event) => `      - event: ${event}\n        pi:\n          module: ${JSON.stringify(source)}`)
        .join('\n')}\n`,
    );
    // Built public entries keep this core test independent of external source tsconfigs.
    const configEntry = pathToFileURL(path.join(configDist, 'piContext.mjs')).href;
    const { provideDoomConfigContext } = await import(configEntry);
    provideDoomConfigContext(current.context, {
      settings: { projectTrust: 'ask' },
      harness: { root: cwd, hookModules: { file: descriptor }, pluginHooks: [], hookGroups: ['proof'] },
      requiresRelaunch: false,
    });
    const facetEntry = pathToFileURL(path.join(hookDist, 'extensions/server.mjs')).href;
    const { default: facet } = (await import(facetEntry)) as { default: DoomServerFacet };
    const serverHost = createDoomServerHost({
      scope: 'session',
      context: { scope: 'session', cwd, onNotice: (notice) => notices.push(notice) },
    });
    current.context.provide(DOOM_SERVER_HOST_SERVICE, serverHost);
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin(facet)
      .await();
    const execute = vi.fn<DoomHeadlessTool['execute']>(async () => ({ content: [{ type: 'text', text: 'executed' }] }));
    await current.context
      .extend({ [DOOM_HEADLESS_OWNER]: candidate })
      .plugin((context: Context) => {
        requireDoomHeadlessHost(context).registerTool({
          name: 'parent_probe',
          description: 'Parent routing probe',
          parameters: Type.Object({}),
          execute,
        });
      })
      .await();
    const rows = (): Array<{ phase: string; sessionId?: string }> =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    expect(current.host.canDispatch()).toBe(false);
    await current.host.activateFacets({
      root: current.context,
      installedPackages: [candidate.packageName],
      dispose: async () => {},
    });
    expect(current.host.canDispatch()).toBe(true);
    expect(notices).toEqual([]);
    return { ...current, cwd, rows, execute };
  }

  function appendCommandRows(cwd: string) {
    const log = path.join(cwd, 'commands.jsonl');
    const script = path.join(cwd, 'record.cjs');
    fs.writeFileSync(
      script,
      `const fs = require('node:fs'); const payload = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(payload) + '\\n');`,
    );
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    fs.appendFileSync(
      path.join(cwd, '.doom/hooks.yaml'),
      `${['PreToolUse', 'PostToolUse'].map((event) => `      - event: ${event}\n        pi:\n          command: ${JSON.stringify(command)}`).join('\n')}\n`,
    );
    return (): Array<{ hook_event_name: string; tool_name: string; session_id: string }> =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
  }

  const recordingModule = `return {
    session_start(event, ctx) { record('start', ctx); },
    tool_call(event, ctx) { record('pre', ctx); },
    tool_result(event, ctx) { record('post', ctx); return {content: [{type: 'text', text: 'redacted'}]}; },
    agent_settled(event, ctx) { record('settled', ctx); },
    dispose() { record('dispose'); }
  };`;

  it('shares one module setup across real Pi lifecycle and native tool rows exactly once', async () => {
    let requests = 0;
    const streamSimple = vi.fn<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      const tool = requests++ === 0;
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 0,
        stopReason: tool ? 'toolUse' : 'stop',
        content: tool
          ? [{ type: 'toolCall', id: 'parent-call', name: 'parent_probe', arguments: {} }]
          : [{ type: 'text', text: 'Done' }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
      stream.end();
      return stream;
    });
    const current = await parent(recordingModule, streamSimple);
    expect(current.rows().map(({ phase }) => phase)).toEqual(['setup', 'start']);
    const status = current.host.host!.status;
    const commandRows = appendCommandRows(current.cwd);
    await current.session.prompt('Run the parent probe');
    expect(commandRows().map(({ hook_event_name, tool_name }) => [hook_event_name, tool_name])).toEqual([
      ['PreToolUse', 'parent_probe'],
      ['PostToolUse', 'parent_probe'],
    ]);
    await vi.waitFor(() =>
      expect(current.rows().map(({ phase }) => phase)).toEqual(['setup', 'start', 'pre', 'post', 'settled']),
    );
    expect(current.execute).toHaveBeenCalledOnce();
    expect(
      current
        .rows()
        .filter(({ sessionId }) => sessionId)
        .every(({ sessionId }) => sessionId === current.runtime.sessionId),
    ).toBe(true);
    const entries = (await current.runtime.readEntries()).entries;
    expect(entries.find((entry) => entry.type === 'message' && entry.message.role === 'toolResult')).toMatchObject({
      message: { content: [{ type: 'text', text: 'redacted' }] },
    });
    expect(current.host.host!.status).toEqual(status);
    await current.host.dispose();
    await current.context.fiber.dispose();
    expect(current.rows().map(({ phase }) => phase)).toEqual(['setup', 'start', 'pre', 'post', 'settled', 'dispose']);
  });

  it('dispatches real command rows once on MCP and direct tool surfaces (mocked tool bodies)', async () => {
    const remote = vi.fn<DoomHeadlessTool['execute']>(async () => ({ content: [{ type: 'text', text: 'remote' }] }));
    const current = await parent(recordingModule, undefined, [
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
            tools: [
              { name: 'remote_probe', description: 'Remote probe', parameters: Type.Object({}), execute: remote },
            ],
          },
        },
      },
    ]);
    const commandRows = appendCommandRows(current.cwd);
    for (const [surface, name] of [
      [current.host.toolSurface, 'parent_probe'],
      [current.host.mcpSurface, 'remote_probe'],
    ] as const) {
      await surface.invokeTool({ revision: surface.readSurface().revision, name, arguments: {} });
    }
    const rows = commandRows();
    expect(rows.map(({ hook_event_name, tool_name }) => [hook_event_name, tool_name])).toEqual([
      ['PreToolUse', 'parent_probe'],
      ['PostToolUse', 'parent_probe'],
      ['PreToolUse', 'remote_probe'],
      ['PostToolUse', 'remote_probe'],
    ]);
    expect(rows.every(({ session_id }) => session_id === current.runtime.sessionId)).toBe(true);
    expect(current.execute).toHaveBeenCalledOnce();
    expect(remote).toHaveBeenCalledOnce();
  });

  it('keeps a live headless host on its startup descriptor before its first lazy module import', async () => {
    const current = await parent(recordingModule, undefined, [], ['PreToolUse', 'PostToolUse']);
    expect(current.rows()).toEqual([]);
    const source = path.join(current.cwd, 'hook.ts');
    const artifact = path.join(current.cwd, 'replacement.mjs');
    const file = path.join(current.cwd, 'replacement.json');
    fs.writeFileSync(artifact, 'export default {setup(){throw new Error("replacement must not load")}}');
    fs.writeFileSync(file, JSON.stringify({ version: 1, modules: [{ source, artifact }] }));
    const { requireDoomConfigContext, replaceDoomConfigContext } = await import(
      pathToFileURL(path.join(configDist, 'piContext.mjs')).href
    );
    const config = requireDoomConfigContext(current.context);
    replaceDoomConfigContext(current.context, { ...config, harness: { ...config.harness, hookModules: { file } } });
    const surface = current.host.toolSurface.readSurface();
    expect(
      await current.host.toolSurface.invokeTool({ revision: surface.revision, name: 'parent_probe', arguments: {} }),
    ).toMatchObject({
      content: [{ type: 'text', text: 'redacted' }],
    });
    expect(current.rows().map(({ phase }) => phase)).toEqual(['setup', 'pre', 'post']);
    expect(current.execute).toHaveBeenCalledOnce();
  });

  it('propagates real admission markers through a module and stops later tool rows (mocked admission rejection)', async () => {
    const current = await parent(
      `return { tool_call: async (event, ctx) => { record('pre', ctx); await ctx.sendMessage('continue', 'steer'); record('unreachable'); } };`,
    );
    const commandRows = appendCommandRows(current.cwd);
    // Only the admission failure is doubled. Session wrapping, module dispatch and facet routing are real.
    vi.spyOn(current.runtime, 'submitInternalMessage').mockRejectedValue(new Error('Queue admission refused'));
    const surface = current.host.toolSurface.readSurface();
    await expect(
      current.host.toolSurface.invokeTool({ revision: surface.revision, name: 'parent_probe', arguments: {} }),
    ).rejects.toMatchObject({ name: 'DoomHeadlessPromptAdmissionError', message: 'Queue admission refused' });
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.rows().map(({ phase }) => phase)).toEqual(['setup', 'pre']);
    expect(commandRows()).toEqual([]);
    expect(current.host.canDispatch()).toBe(true);
  });

  it('cancels an in-flight module using the operation signal without executing the tool', async () => {
    const current = await parent(
      `return { tool_call: async (event, ctx) => { record('waiting', ctx); await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), {once: true})); record('unreachable'); } };`,
    );
    const controller = new AbortController();
    const surface = current.host.toolSurface.readSurface();
    const pending = current.host.toolSurface.invokeTool({
      revision: surface.revision,
      name: 'parent_probe',
      arguments: {},
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow('Operation cancelled');
    await vi.waitFor(() => expect(current.rows().map(({ phase }) => phase)).toContain('waiting'));
    controller.abort(new Error('Operation cancelled'));
    await rejection;
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.rows().map(({ phase }) => phase)).not.toContain('unreachable');
    expect(current.host.canDispatch()).toBe(true);
  });
});
