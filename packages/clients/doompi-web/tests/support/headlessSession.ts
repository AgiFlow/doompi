import { Client, type ByteTransportFactory } from '@earendil-works/pi-client';
import { DOOM_COCKPIT_SERVER_ID, DoomSessionManagementService } from '@agimon-ai/doompi-core/session-protocol';
import { createAgentServerService, type HeadlessHub, type HeadlessSessionHost } from '@agimon-ai/doompi-core/server';
import WebSocket from 'ws';

type Frame = Record<string, unknown>;
export type { Frame };

export interface HeadlessSession {
  readonly id: string;
  readonly cwd: string;
  readonly received: Frame[];
  emit(frame: Frame): void;
  waitForAttach(timeoutMs?: number): Promise<void>;
  waitForCommand(type: string, timeoutMs?: number): Promise<Frame>;
  dropClient(): void;
  holdFromAnotherClient(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface HeadlessSessionOptions {
  id?: string;
  name?: string;
  cwd?: string;
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
  const id = options.id ?? `session-${Math.random().toString(36).slice(2)}`;
  const name = options.name ?? 'untitled';
  const cwd = options.cwd ?? '/workspace';
  const received: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const commandWaiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  const pending = new Map<string, PendingResult[]>();
  const entries: unknown[] = [];
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
  let exitResolve!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  const record = (frame: Frame): void => {
    const { id: _id, ...command } = frame;
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
      setTimeout(() => {
        const current = pending.get(command) ?? [];
        const index = current.indexOf(waiter);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) pending.delete(command);
        resolve(defaultValue);
      }, 0);
    });

  const readEntries = async (): Promise<{ entries: unknown[]; leafId: null }> => {
    record({ type: 'get_entries' });
    const result = (await answer('get_entries', { entries, leafId: null })) as { entries: unknown[]; leafId: null };
    return { entries: result.entries, leafId: null };
  };

  const runtime = {
    sessionId: id,
    laneName: 'main',
    harnessId: id,
    session: {} as never,
    harness: {} as never,
    lane: {} as never,
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
      return (await answer('get_state', state)) as Frame;
    },
    readEntries,
    listCommands: () => {
      record({ type: 'get_commands' });
      return commands;
    },
    setModel: async (model: { provider: string; id: string }) => {
      record({ type: 'set_model', provider: model.provider, modelId: model.id });
      await answer('set_model', undefined);
    },
    availableModels: async () => {
      record({ type: 'get_available_models' });
      const response = (await answer('get_available_models', { models: [] })) as { models?: unknown[] };
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
      return (await answer('get_session_stats', {})) as Frame;
    },
    replaceTools: async () => undefined,
    replaceResources: async () => undefined,
    readResources: async () => ({}) as never,
    appendCustomEntry: async () => '',
    recordUsage: async () => '',
    submitPrompt: async (message: string) => {
      record({ type: 'prompt', message });
      await answer('prompt', undefined);
      return { settled: Promise.resolve() };
    },
    prompt: async (message: string) => {
      record({ type: 'prompt', message });
      await answer('prompt', undefined);
    },
    steer: async (message: string) => {
      record({ type: 'steer', message });
      await answer('steer', undefined);
    },
    followUp: async (message: string) => {
      record({ type: 'follow_up', message });
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

  const host: HeadlessSessionHost = {
    runtime,
    host: undefined,
    prepareFacets: () => undefined,
    activateFacets: async () => undefined,
    canDispatch: () => true,
    onPresentationFrame: runtime.onPresentationFrame,
    respondToExtensionUi(frame) {
      record({ ...frame, type: 'extension_ui_response' });
      return true;
    },
    dispose: () => runtime.dispose(),
  };
  options.onHost?.(id, host);
  options.hub.register({ id, name, cwd, createdAt: new Date().toISOString(), host });

  const injectResponse = (frame: Frame): void => {
    const command = typeof frame.command === 'string' ? frame.command : undefined;
    if (command === undefined) return;
    const waiters = pending.get(command);
    const waiter = waiters?.shift();
    if (waiters?.length === 0) pending.delete(command);
    if (waiter === undefined) return;
    if (frame.success === false)
      waiter.reject(new Error(typeof frame.error === 'string' ? frame.error : 'The command failed.'));
    else waiter.resolve(frame.data);
  };

  const session: HeadlessSession = {
    id,
    cwd,
    received,
    emit(frame) {
      if (frame.type === 'response') {
        if (frame.command === 'get_state' && frame.success === true && typeof frame.data === 'object')
          state = frame.data as Frame;
        if (frame.command === 'get_entries' && frame.success === true && typeof frame.data === 'object') {
          const data = frame.data as Frame;
          entries.splice(0, entries.length, ...(Array.isArray(data.entries) ? data.entries : []));
        }
        if (frame.command === 'get_commands' && frame.success === true && typeof frame.data === 'object') {
          const data = frame.data as Frame;
          if (Array.isArray(data.commands)) commands = data.commands as typeof commands;
        }
        injectResponse(frame);
        return;
      }
      for (const listener of listeners) listener(frame);
    },
    waitForAttach: async (timeoutMs = 5000) => {
      if (timeoutMs <= 0) throw new Error('Timed out waiting for the cockpit to attach.');
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      void options.restartHeadless();
    },
    async holdFromAnotherClient() {
      await options.restartHeadless();
      const client = await Client.connect({
        serverId: DOOM_COCKPIT_SERVER_ID,
        transportFactory: websocketTransport(`${options.headlessUrl().replace('http:', 'ws:')}/api/pi`),
      });
      await client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: [id] },
      );
      return async () => {
        await client.dispose();
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await options.hub.closeSession(id);
      exitResolve(0);
    },
  };
  return session;
}
