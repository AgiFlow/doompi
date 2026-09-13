import { randomUUID } from 'node:crypto';

import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import {
  createAgentServerService,
  type HeadlessHub,
  type HeadlessHubSession,
  type HeadlessSessionHost,
} from '@agimon-ai/doompi-core/server';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomSessionManagementService,
  DoomSessionService,
} from '@agimon-ai/doompi-core/session-protocol';
import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport, type ByteTransportFactory } from '@earendil-works/pi-client';
import WebSocket from 'ws';

type Frame = Record<string, unknown>;
export type { Frame };

export interface HeadlessSessionStats {
  readonly tokens: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total: number;
  };
  readonly cost: number;
  readonly contextUsage?: { readonly tokens: number; readonly contextWindow: number };
}

export interface HeadlessSession {
  readonly id: string;
  readonly cwd: string;
  readonly received: Frame[];
  emit(frame: Frame): void;
  replaceEntries(entries: readonly Frame[]): void;
  setSessionStats(stats: HeadlessSessionStats): void;
  waitForAttach(timeoutMs?: number): Promise<void>;
  waitForCommand(type: string, timeoutMs?: number): Promise<Frame>;
  dropClient(): void;
  connectAnotherClient(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface HeadlessSessionOptions {
  id?: string;
  name?: string;
  cwd?: string;
  workspaceId: string;
  webComposition: NonNullable<HeadlessHubSession['webComposition']>;
  environment: Readonly<Record<string, string | undefined>>;
  repoRoot: string;
  hub: HeadlessHub;
  headlessUrl: () => string;
  restartHeadless: () => Promise<void>;
  onHost?: (id: string, host: HeadlessSessionHost) => void;
}

type AgentRuntime = Parameters<typeof createAgentServerService>[0]['runtime'];
type PendingResult = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function websocketTransport(url: string): ByteTransportFactory {
  return async (handlers) => {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    let closed = false;
    const stop = (error?: Error): void => {
      if (closed) return;
      closed = true;
      if (error) handlers.onError(error);
      else handlers.onClose();
    };
    socket.on('message', (data) => handlers.onData(Buffer.from(data as ArrayBuffer)));
    socket.on('close', () => stop());
    socket.on('error', (error) => stop(error));
    return {
      send: (chunk) =>
        new Promise<void>((resolve, reject) => {
          socket.send(chunk, (error) => (error ? reject(error) : resolve()));
        }),
      close() {
        socket.close();
      },
    };
  };
}

/**
 * A deterministic session host behind the same headless HTTP and Pi WebSocket
 * boundary used by doompi-server. The fixture API is semantic, while the
 * browser only sees the public protocol.
 */
export async function startHeadlessSession(options: HeadlessSessionOptions): Promise<HeadlessSession> {
  const id = options.id ?? `session-${randomUUID()}`;
  const name = options.name ?? 'untitled';
  const cwd = options.cwd ?? '/workspace';
  const received: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const commandWaiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  const pending = new Map<string, PendingResult[]>();
  const entries: Frame[] = [];
  let usageEntries: unknown[] = [];
  let availableModels: unknown[] = [];
  let stats: Frame = {
    messageCount: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  let assistantDraft: { id: string; text: string } | undefined;
  let commands = [
    { name: 'mode', description: 'switch the major mode' },
    { name: 'model', description: 'pick the agent model' },
    { name: 'profile', description: 'switch the profile' },
    { name: 'skill:playwriter', description: 'drive a browser' },
  ];
  let state: Frame = {
    sessionId: id,
    sessionName: name,
    model: { provider: 'unknown', id: 'unknown' },
    thinkingLevel: 'medium',
    isStreaming: false,
    messageCount: 0,
  };
  let closed = false;
  let reconnecting = false;
  let restarting: Promise<void> | undefined;
  const reconnectFrames: Frame[] = [];
  let exitResolve!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  const record = (frame: Frame): void => {
    const { id: protocolId, ...payload } = frame;
    const command = frame.type === 'extension_ui_response' ? frame : payload;
    void protocolId;
    received.push(command);
    for (let index = commandWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = commandWaiters[index];
      if (waiter?.type !== frame.type) continue;
      waiter.resolve(command);
      commandWaiters.splice(index, 1);
    }
  };

  const answer = (command: string, defaultValue: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const waiter: PendingResult = { command, resolve, reject };
      const waiters = pending.get(command) ?? [];
      pending.set(command, [...waiters, waiter]);
      const fallbackDelay = ['get_available_models', 'get_available_thinking_levels'].includes(command) ? 1_000 : 0;
      setTimeout(() => {
        const current = pending.get(command) ?? [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) pending.delete(command);
        resolve(defaultValue);
      }, fallbackDelay);
    });

  const flushReconnectFrames = (): void => {
    if (!reconnecting) return;
    reconnecting = false;
    for (const frame of reconnectFrames.splice(0)) session.emit(frame);
  };

  const replaceEntries = (next: readonly Frame[]): void => {
    entries.splice(
      0,
      entries.length,
      ...next.map((entry, index) => ({ ...entry, seq: typeof entry.seq === 'number' ? entry.seq : index + 1 })),
    );
  };

  const readEntries = async (): Promise<{ entries: unknown[]; leafId: string | null }> => {
    flushReconnectFrames();
    record({ type: 'get_entries' });
    const tip = entries.at(-1);
    const leafId = typeof tip === 'object' && tip !== null && 'id' in tip && typeof tip.id === 'string' ? tip.id : null;
    const result = (await answer('get_entries', { entries, leafId })) as {
      entries: unknown[];
      leafId: string | null;
    };
    return { entries: result.entries, leafId: result.leafId };
  };

  const runtime = {
    sessionId: id,
    laneName: 'main',
    harnessId: id,
    session: {} as never,
    harness: {} as never,
    lane: {
      findEntries: async (query: {
        order?: 'newestFirst' | 'oldestFirst';
        limit?: number;
        cursor?: { seq: number };
        type?: string;
        customType?: string;
      }) => {
        flushReconnectFrames();
        record({ type: 'get_entries' });
        const source = (usageEntries.length > 0 ? usageEntries : entries).filter(
          (entry): entry is Frame => typeof entry === 'object' && entry !== null,
        );
        const cursor = query.cursor?.seq;
        const filtered = source.filter((entry) => {
          if (query.type !== undefined && entry.type !== query.type) return false;
          if (query.customType !== undefined && entry.customType !== query.customType) return false;
          if (cursor === undefined || typeof entry.seq !== 'number') return true;
          return query.order === 'oldestFirst' ? entry.seq > cursor : entry.seq < cursor;
        });
        const ordered = query.order === 'oldestFirst' ? filtered : filtered.toReversed();
        return query.limit === undefined ? ordered : ordered.slice(0, query.limit);
      },
      getTipId: async () => {
        const tip = entries.at(-1);
        return typeof tip?.id === 'string' ? tip.id : null;
      },
    } as never,
    exited,
    storageQuarantined: false,
    onPresentationFrame(listener: (frame: Frame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onEvent: () => () => undefined,
    stop() {
      if (closed) return;
      closed = true;
      exitResolve(0);
    },
    readState: async () => {
      record({ type: 'get_state' });
      const result = (await answer('get_state', state)) as Frame;
      flushReconnectFrames();
      return result;
    },
    readEntries,
    listCommands: async () => {
      record({ type: 'get_commands' });
      const response = (await answer('get_commands', { commands })) as { commands?: typeof commands };
      return response.commands ?? commands;
    },
    setModel: async (model: { provider: string; id: string }) => {
      record({ type: 'set_model', provider: model.provider, modelId: model.id });
      await answer('set_model', undefined);
    },
    availableModels: async () => {
      record({ type: 'get_available_models' });
      const response = (await answer('get_available_models', { models: availableModels })) as { models?: unknown[] };
      return response.models ?? [];
    },
    setThinkingLevel: async (level: string) => {
      record({ type: 'set_thinking_level', level });
      await answer('set_thinking_level', undefined);
    },
    availableThinkingLevels: async () => {
      record({ type: 'get_available_thinking_levels' });
      const response = (await answer('get_available_thinking_levels', { levels: [] })) as { levels?: unknown[] };
      return response.levels ?? [];
    },
    setSteeringMode: async () => undefined,
    setFollowUpMode: async () => undefined,
    navigateTree: async (targetId: string | null) => {
      record({ type: 'navigate_tree', entryId: targetId });
      await answer('navigate_tree', undefined);
      return { cancelled: false, entries: [] };
    },
    clearQueue: async () => {
      record({ type: 'clear_queue' });
      await answer('clear_queue', { steering: [], followUp: [] });
      return { steering: [], followUp: [] };
    },
    setName: async (next: string) => {
      record({ type: 'set_session_name', name: next });
      await answer('set_session_name', undefined);
    },
    getSessionStats: async () => {
      record({ type: 'get_session_stats' });
      return (await answer('get_session_stats', stats)) as Frame;
    },
    replaceTools: async () => undefined,
    replaceResources: async () => undefined,
    readResources: async () => ({}) as never,
    appendCustomEntry: async () => '',
    recordUsage: async () => '',
    submitPrompt: async (message: string, images?: unknown[]) => {
      record({ type: 'prompt', message, ...(images === undefined ? {} : { images }) });
      await answer('prompt', undefined);
      return { settled: Promise.resolve() };
    },
    prompt: async (message: string, images?: unknown[]) => {
      record({ type: 'prompt', message, ...(images === undefined ? {} : { images }) });
      await answer('prompt', undefined);
    },
    steer: async (message: string, images?: unknown[]) => {
      record({ type: 'steer', message, ...(images === undefined ? {} : { images }) });
      await answer('steer', undefined);
    },
    followUp: async (message: string, images?: unknown[]) => {
      record({ type: 'follow_up', message, ...(images === undefined ? {} : { images }) });
      await answer('follow_up', undefined);
    },
    abort: async () => {
      record({ type: 'abort' });
      await answer('abort', undefined);
    },
    compact: async () => {
      record({ type: 'compact' });
      await answer('compact', undefined);
    },
    resume: async () => undefined,
    dispose: async () => {
      if (closed) return;
      closed = true;
      exitResolve(0);
    },
  } as unknown as AgentRuntime;

  const activities = new Set<DoomHeadlessActivity>();
  const activityStops = new Map<DoomHeadlessActivity, () => void | Promise<void>>();
  let activateFacets: (() => Promise<void>) | undefined;
  let activation: Promise<void> | undefined;
  const selection = { majorMode: 'minimal', activeLayers: ['team', 'task', 'llm'], domains: [], state: {} } as const;
  const executionContext: DoomHeadlessExecutionContext = {
    cwd,
    repoRoot: options.repoRoot,
    sessionId: id,
    environment: options.environment,
    selection,
    client: {
      notify: () => undefined,
      request: async () => {
        throw new Error('The Playwright headless fixture does not answer package prompts.');
      },
      setStatus: () => undefined,
    },
    session: {
      entries: async (query) =>
        (await runtime.lane.findEntries({ ...query, order: 'newestFirst' } as never, {} as never)) as unknown as Record<
          string,
          unknown
        >[],
      appendCustomEntry: async (type, data) => {
        await runtime.appendCustomEntry(type, data);
      },
      prompt: (text, delivery) =>
        delivery === 'steer'
          ? runtime.steer(text)
          : delivery === 'followUp'
            ? runtime.followUp(text)
            : runtime.prompt(text),
      abort: () => runtime.abort(),
      compact: (instructions) => runtime.compact(instructions),
      activity: async () => ({ hasPendingMessages: false, isIdle: true }),
    },
    shutdown: () => runtime.stop(),
  };
  const registration = { dispose: () => undefined };
  const headlessHost = {
    context: executionContext,
    changeSelection: async () => undefined,
    assertActive: () => undefined,
    subscribeSelection: () => () => undefined,
    registerToolRestriction: () => registration,
    registerTool: () => registration,
    registerResource: () => registration,
    registerCommand: () => registration,
    registerHook: () => registration,
    registerActivity(activity: DoomHeadlessActivity) {
      activities.add(activity);
      return { dispose: () => activities.delete(activity) };
    },
  } as DoomHeadlessHostService;
  const host: HeadlessSessionHost = {
    runtime,
    host: undefined,
    prepareFacets: (root) => {
      root.provide(DOOM_HEADLESS_HOST_SERVICE, headlessHost);
    },
    activateFacets: async () => {
      activateFacets = async () => {
        for (const activity of activities) activityStops.set(activity, await activity.start(executionContext));
      };
    },
    canDispatch: () => true,
    onPresentationFrame: runtime.onPresentationFrame,
    respondToExtensionUi(frame) {
      record({ ...frame, type: 'extension_ui_response' });
      return true;
    },
    dispose: async () => {
      for (const stop of [...activityStops.values()].reverse()) await stop();
      activityStops.clear();
      await runtime.dispose();
    },
  };
  options.onHost?.(id, host);
  options.hub.register({
    id,
    workspaceId: options.workspaceId,
    environment: options.environment,
    webComposition: options.webComposition,
    name,
    cwd,
    createdAt: new Date().toISOString(),
    host,
  });

  const injectResponse = (frame: Frame): void => {
    const command = typeof frame.command === 'string' ? frame.command : undefined;
    if (command === undefined) return;
    const waiters = pending.get(command) ?? [];
    pending.delete(command);
    for (const waiter of waiters) {
      if (frame.success === false)
        waiter.reject(new Error(typeof frame.error === 'string' ? frame.error : 'The command failed.'));
      else waiter.resolve(frame.data);
    }
  };

  const session: HeadlessSession = {
    id,
    cwd,
    received,
    emit(frame) {
      if (reconnecting) {
        reconnectFrames.push(frame);
        return;
      }
      if (frame.type === 'response') {
        let confirmedSessionName: string | undefined;
        if (frame.command === 'get_state' && frame.success === true && typeof frame.data === 'object') {
          state = frame.data as Frame;
          if (typeof state.sessionName === 'string') confirmedSessionName = state.sessionName;
        }
        if (frame.command === 'get_entries' && frame.success === true && typeof frame.data === 'object') {
          const data = frame.data as Frame;
          if (Array.isArray(data.entries))
            replaceEntries(data.entries.filter((entry): entry is Frame => typeof entry === 'object' && entry !== null));
        }
        if (frame.command === 'get_commands' && frame.success === true && typeof frame.data === 'object') {
          const data = frame.data as Frame;
          if (Array.isArray(data.commands)) commands = data.commands as typeof commands;
        }
        injectResponse(frame);
        for (const listener of listeners) listener(frame);
        if (confirmedSessionName !== undefined)
          queueMicrotask(() => {
            for (const listener of listeners) listener({ type: 'session_info_changed', name: confirmedSessionName });
          });
        return;
      }
      const assistantEvent =
        typeof frame.assistantMessageEvent === 'object' && frame.assistantMessageEvent !== null
          ? (frame.assistantMessageEvent as Frame)
          : undefined;
      if (frame.type === 'message_update' && assistantEvent !== undefined) {
        if (assistantDraft === undefined) {
          assistantDraft = { id: `assistant-${randomUUID()}`, text: '' };
          for (const listener of listeners)
            listener({
              type: 'message_start',
              message: { id: assistantDraft.id, role: 'assistant', content: [] },
            });
        }
        if (assistantEvent.type === 'text_delta' && typeof assistantEvent.delta === 'string')
          assistantDraft.text += assistantEvent.delta;
        const message = {
          id: assistantDraft.id,
          role: 'assistant',
          content: [{ type: 'text', text: assistantDraft.text }],
        };
        for (const listener of listeners)
          listener({
            ...frame,
            assistantMessageEvent: { ...assistantEvent, contentIndex: assistantEvent.contentIndex ?? 0 },
            message,
          });
        return;
      }
      if (frame.type === 'agent_settled' && assistantDraft !== undefined) {
        const draft = assistantDraft;
        assistantDraft = undefined;
        const message = { id: draft.id, role: 'assistant', content: [{ type: 'text', text: draft.text }] };
        if (!entries.some((entry) => JSON.stringify(entry).includes(draft.text)))
          entries.push({ id: draft.id, seq: entries.length + 1, type: 'message', message });
        for (const listener of listeners) listener({ type: 'message_end', message });
      }
      for (const listener of listeners) listener(frame);
    },
    replaceEntries,
    setSessionStats(next) {
      const input = next.tokens.input ?? 0;
      const output = next.tokens.output ?? 0;
      const cacheRead = next.tokens.cacheRead ?? 0;
      const cacheWrite = next.tokens.cacheWrite ?? 0;
      stats = {
        messageCount: state.messageCount ?? 0,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: next.tokens.total,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: next.cost },
        },
      };
      const contextUsage = next.contextUsage;
      if (contextUsage === undefined) {
        usageEntries = [];
        availableModels = [];
        return;
      }
      const model = { provider: 'fixture', id: 'fixture', contextWindow: contextUsage.contextWindow };
      state = { ...state, model };
      availableModels = [model];
      usageEntries = [
        {
          type: 'message',
          message: {
            role: 'assistant',
            usage: {
              input: contextUsage.tokens,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: contextUsage.tokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        },
      ];
    },
    waitForAttach: async (timeoutMs = 5000) => {
      if (timeoutMs <= 0) throw new Error('Timed out waiting for the cockpit to attach.');
      activation ??= activateFacets?.() ?? Promise.resolve();
      await activation;
      await session.waitForCommand('get_state', timeoutMs);
    },
    waitForCommand(type, timeoutMs = 5000) {
      const seen = received.find((frame) => frame.type === type);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for a '${type}' command.`)), timeoutMs);
        commandWaiters.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    dropClient() {
      reconnecting = true;
      restarting ??= options.restartHeadless().finally(() => {
        restarting = undefined;
      });
    },
    async connectAnotherClient() {
      const client = await Client.connect({
        serverId: DOOM_COCKPIT_SERVER_ID,
        transportFactory: websocketTransport(
          `${options.headlessUrl().replace('http:', 'ws:')}/api/pi?token=e2e-headless-token`,
        ),
      });
      await client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: [id] },
      );
      const binding = createRemoteServiceBinding({
        services: [DoomSessionService],
        transport: createClientServiceTransport(client, () => client.attachment),
      });
      binding.use(DoomSessionService);
      await binding.ready(BACKGROUND_CONTEXT);
      return async () => {
        await binding.dispose(BACKGROUND_CONTEXT);
        await client.dispose();
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await restarting;
      await options.hub.closeSession(id);
      exitResolve(0);
    },
  };
  return session;
}
