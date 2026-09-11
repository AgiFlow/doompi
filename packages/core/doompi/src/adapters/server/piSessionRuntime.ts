import { randomUUID } from 'node:crypto';
import {
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
  type Context,
  type MutableReplicatedState,
  type RemoteServiceEndpoint,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost } from '@earendil-works/pi-server';
import { SessionNotFoundError } from '@earendil-works/pi-server';
import { activeBranch, createRpcTranscript, type RpcTranscript } from '../../services/server/rpcTranscript.ts';
import { createSessionPresentation } from '../../services/server/sessionPresentation.ts';
import type { AgentProcess } from '../../types/server/session.ts';
import {
  DoomSessionManagementService,
  DoomSessionService,
  type SessionService,
  type SessionMessageArgs,
  type PromptArgs,
  type SessionServiceState,
  type SessionSnapshot,
  type TranscriptItem,
  type ClearQueueResult,
  type RewindResult,
  type SessionStateInfo,
  type SessionStats,
  type SessionCommand,
  type ModelRef,
  type ThinkingLevel,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { observe, type ServerTelemetry } from './serverTelemetry.ts';

const SETTLED = 'agent_settled';

export interface AgentSessionRuntimeOptions {
  agent: AgentProcess;
  sessionId: string;
  sessionName: string;
  cwd: string;
  telemetry?: ServerTelemetry;
  /** Test seam for the projection. */
  transcript?: RpcTranscript;
}

export interface AgentSessionRuntime extends SessionService {
  readonly state: MutableReplicatedState<SessionServiceState>;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/** Projects one supervised RPC agent as a Chord session service. */
export function createAgentSessionRuntime(options: AgentSessionRuntimeOptions): AgentSessionRuntime {
  const transcript =
    options.transcript ??
    createRpcTranscript({ id: options.sessionId, cwd: options.cwd, name: options.sessionName, now: Date.now });
  const presentation = createSessionPresentation();
  const inFlight = new Map<string, TranscriptItem>();
  const state = replicatedState<SessionServiceState>({
    snapshot: transcript.snapshot(),
    progress: null,
    inFlight: [],
    presentation: { revision: 0, dropped: 0, events: [], projections: [] },
  });
  const present = (frame: Record<string, unknown>): boolean => {
    const next = presentation.record(frame);
    if (next) state.state.presentation = next;
    return next !== undefined;
  };
  const settlers = new Set<{ resolve(): void; reject(error: Error): void }>();
  let disposed = false;
  const pending = new Map<string, { command: string; resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    for (const waiter of settlers) waiter.reject(error);
  };
  void options.agent.exited.then(
    () => {
      disposed = true;
      rejectPending(new Error('The session agent exited'));
    },
    (error: unknown) => {
      disposed = true;
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    },
  );

  options.agent.onFrame((frame) => {
    if (disposed) return;
    let hydrated = false;
    if (
      frame.type === 'response' &&
      frame.command === 'get_entries' &&
      frame.success === true &&
      frame.data &&
      typeof frame.data === 'object' &&
      !Array.isArray(frame.data)
    ) {
      // Hydrate in source-event order, before a later live selection can arrive.
      const entries = activeBranch(frame.data as Record<string, unknown>);
      if (entries) {
        state.state.presentation = presentation.resetCustomEntries();
        hydrated = true;
        for (const entry of entries) if (entry.type === 'custom') present({ type: 'entry_appended', entry });
      }
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const request = pending.get(frame.id);
      if (request && frame.command === request.command) {
        if (frame.success === true) request.resolve(frame.data);
        else request.reject(new Error(typeof frame.error === 'string' ? frame.error : 'The session command failed'));
      }
    }
    const reduction = transcript.apply(frame);
    if (reduction.aggregate && options.telemetry) {
      observe(
        options.telemetry.recordEvent('doompi_server.transcript.aggregate', {
          session_id: options.sessionId,
          ...reduction.aggregate,
        }),
      );
    }
    if (reduction.snapshot) state.state.snapshot = reduction.snapshot;
    state.state.progress = reduction.progress ?? null;
    if (reduction.progress) {
      const progress = reduction.progress;
      if (progress.type === 'item_finished') inFlight.delete(progress.item.id);
      else inFlight.set(progress.item.id, progress.item);
    }
    if (state.state.snapshot.phase === 'idle') inFlight.clear();
    state.state.inFlight = [...inFlight.values()];
    const changed = present(frame);
    if (reduction.snapshot || reduction.progress || changed || hydrated) state.publish(BACKGROUND_CONTEXT);
    if (frame.type === SETTLED) {
      const waiting = [...settlers];
      settlers.clear();
      for (const settle of waiting) settle.resolve();
    }
  });

  const requireLive = (): void => {
    if (disposed) throw new Error('The session runtime is disposed');
  };
  const awaitSettled = (context: Context): { promise: Promise<void>; reject(error: Error): void } => {
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        settlers.delete(waiter);
        context.abortSignal?.removeEventListener('abort', cancel);
      };
      const waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const cancel = (): void => {
        waiter.reject(new Error('The session prompt was cancelled', { cause: context.abortSignal?.reason }));
        // This prompt owns the active turn. Cancellation requests its abort, not just a stopped wait.
        try {
          options.agent.send({ type: 'abort' });
        } catch (error) {
          rejectPending(error instanceof Error ? error : new Error(String(error)));
        }
      };
      fail = waiter.reject;
      settlers.add(waiter);
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
    });
    return { promise, reject: fail };
  };

  // Correlation is registered before send, including agents that answer synchronously.
  const request = <T>(command: string, args: Record<string, unknown>, context: Context): Promise<T> => {
    requireLive();
    context.abortSignal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const cleanup = (): void => {
        clearTimeout(timer);
        pending.delete(id);
        context.abortSignal?.removeEventListener('abort', cancel);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cancel = (): void =>
        fail(new Error('The session request was cancelled', { cause: context.abortSignal?.reason }));
      const timer = setTimeout(() => fail(new Error(`Session command ${command} timed out`)), 60_000);
      pending.set(id, {
        command,
        resolve: (data) => {
          cleanup();
          resolve(data as T);
        },
        reject: fail,
      });
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
      try {
        options.agent.send({ ...args, type: command, id });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const messageArgs = (
    input: string | SessionMessageArgs,
  ): { message: string; images?: SessionMessageArgs['images'] } => {
    const args = typeof input === 'string' ? { text: input } : input;
    if (!args || typeof args.text !== 'string') throw new Error('Prompt message must be a string');
    if (
      args.images !== undefined &&
      (!Array.isArray(args.images) ||
        !args.images.every(
          (image) => image?.type === 'image' && typeof image.data === 'string' && typeof image.mimeType === 'string',
        ))
    ) {
      throw new Error('Invalid message images');
    }
    return { message: args.text, ...(args.images === undefined ? {} : { images: args.images }) };
  };
  let initializing: Promise<void> | undefined;
  const hydrate = async (context: Context): Promise<void> => {
    await request('get_entries', {}, context);
  };
  return {
    state,
    initialize() {
      initializing ??= (async () => {
        await request('get_state', {}, BACKGROUND_CONTEXT);
        await hydrate(BACKGROUND_CONTEXT);
      })().catch((error: unknown) => {
        initializing = undefined;
        throw error;
      });
      return initializing;
    },
    async prompt(text: string | PromptArgs, context) {
      requireLive();
      context.abortSignal?.throwIfAborted();
      const args = messageArgs(text);
      const waitFor = typeof text === 'string' ? 'settled' : (text.waitFor ?? 'settled');
      if (waitFor !== 'accepted' && waitFor !== 'settled') throw new Error('Invalid prompt acknowledgement mode');
      if (
        transcript.phase() !== 'idle' ||
        settlers.size > 0 ||
        [...pending.values()].some((call) => call.command === 'prompt')
      )
        throw new Error('A turn is already running');
      if (waitFor === 'accepted') {
        // A browser owns its submission, not the lifetime of the supervised agent.
        await request('prompt', args, context);
        return;
      }
      const settled = awaitSettled(context);
      const run = async (): Promise<void> => {
        try {
          await request('prompt', args, context);
        } catch (error) {
          settled.reject(error instanceof Error ? error : new Error(String(error)));
        }
        await settled.promise;
      };
      if (options.telemetry) {
        await options.telemetry.runInSpan('doompi_server.prompt_to_settled', { session_id: options.sessionId }, run);
      } else {
        await run();
      }
    },
    async steer(text: string | SessionMessageArgs) {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to steer');
      options.agent.send({ type: 'steer', ...messageArgs(text) });
    },
    async abort() {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to abort');
      options.agent.send({ type: 'abort' });
    },
    async setModel(model, context) {
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string')
        throw new Error('Invalid model');
      await request('set_model', { provider: model.provider, modelId: model.id }, context);
    },
    async setThinking(thinkingLevel, context) {
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel))
        throw new Error('Invalid thinking level');
      await request('set_thinking_level', { level: thinkingLevel }, context);
    },
    async followUp(args, context) {
      await request('follow_up', messageArgs(args), context);
    },
    clearQueue: (context) => request<ClearQueueResult>('clear_queue', {}, context),
    async rewind(args, context) {
      if (!args || typeof args.itemId !== 'string' || !args.itemId) throw new Error('Invalid rewind identity');
      const data = await request<Record<string, unknown>>('get_entries', {}, context);
      const entry = (activeBranch(data) ?? []).toReversed().find((candidate) => {
        if (candidate.type !== 'message' || typeof candidate.id !== 'string') return false;
        const message = candidate.message;
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const record = message as Record<string, unknown>;
        return (
          candidate.id === args.itemId ||
          record.id === args.itemId ||
          (record.role === 'user' && typeof record.timestamp === 'number' && args.itemId === `user-${record.timestamp}`)
        );
      });
      if (!entry) throw new Error('The selected message is not in the active session tree.');
      const result = await request<RewindResult>(
        'navigate_tree',
        {
          targetId: entry.id,
          entryId: entry.id,
          options: {
            ...(args.summarize === undefined ? {} : { summarize: args.summarize }),
            ...(args.customInstructions === undefined ? {} : { customInstructions: args.customInstructions }),
            ...(args.replaceInstructions === undefined ? {} : { replaceInstructions: args.replaceInstructions }),
            ...(args.label === undefined ? {} : { label: args.label }),
          },
        },
        context,
      );
      if (!result.cancelled) await hydrate(context);
      return result;
    },
    async extensionUiResponse(response, context) {
      requireLive();
      context.abortSignal?.throwIfAborted();
      if (
        !response ||
        typeof response.id !== 'string' ||
        !response.id ||
        !(
          ('value' in response && typeof response.value === 'string') ||
          ('confirmed' in response && typeof response.confirmed === 'boolean') ||
          ('cancelled' in response && response.cancelled === true)
        )
      )
        throw new Error('Invalid extension UI response');
      options.agent.send({ ...response, type: 'extension_ui_response' });
      present({ type: 'extension_ui_answered', id: response.id });
      state.publish(context);
    },
    getState: (context) => request<SessionStateInfo>('get_state', {}, context),
    getSessionStats: (context) => request<SessionStats>('get_session_stats', {}, context),
    async getCommands(context) {
      return (await request<{ commands: SessionCommand[] }>('get_commands', {}, context)).commands;
    },
    async getAvailableModels(context) {
      const { models } = await request<{ models: ModelRef[] }>('get_available_models', {}, context);
      return models.map((model) => ({ provider: model.provider, id: model.id }));
    },
    async getAvailableThinkingLevels(context) {
      return (await request<{ levels: ThinkingLevel[] }>('get_available_thinking_levels', {}, context)).levels;
    },
    compact: (args, context) => request('compact', { customInstructions: args.customInstructions }, context),
    async setName(name, context) {
      if (typeof name !== 'string' || name.length > 256) throw new Error('Invalid session name');
      await request('set_session_name', { name }, context);
    },
    async dispose() {
      disposed = true;
      rejectPending(new Error('The session runtime is disposed'));
      settlers.clear();
    },
  };
}

export interface AgentServerServiceOptions extends AgentSessionRuntimeOptions {
  createdAt: number;
}

export interface DoomSessionMetadata {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd: string;
  sessionName: string;
}

function endpointAttachment(endpoint: RemoteServiceEndpoint): {
  invokeService: RemoteServiceEndpoint['invoke'];
  release(): void;
} {
  return {
    invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
    release: () => endpoint.dispose(),
  };
}

function managementHost(): RoutedServerServiceHost {
  return {
    attachClient(presentation) {
      const provider = new RemoteServiceProvider([{ service: DoomSessionManagementService, mode: 'singleton' }]);
      provider.provide(DoomSessionManagementService, {
        attach: (sessionId, context) => presentation.attachSession(sessionId, context),
        detach: (context) => presentation.detachSession(context),
      });
      return endpointAttachment(createRemoteServiceEndpoint(provider));
    },
  };
}

/** Creates the 0.85 routed host for one supervised DoomPi session. */
export function createAgentServerService(options: AgentServerServiceOptions): ServerHost<DoomSessionMetadata> {
  const metadata: DoomSessionMetadata = {
    id: options.sessionId,
    createdAt: options.createdAt,
    storageVersion: 1,
    cwd: options.cwd,
    sessionName: options.sessionName,
  };
  const runtime = createAgentSessionRuntime(options);
  let closed = false;

  return {
    serverServices: managementHost(),
    async resolveSession(sessionId) {
      if (sessionId !== metadata.id) throw new SessionNotFoundError(`No session ${sessionId}`);
      return metadata;
    },
    async openSession() {
      if (closed) throw new SessionNotFoundError('The session service is closed');
      await runtime.initialize();
      const provider = new RemoteServiceProvider([{ service: DoomSessionService, mode: 'singleton' }]);
      provider.provide(DoomSessionService, runtime);
      const handle: RoutedSessionHandle = {
        attachClient: () => endpointAttachment(createRemoteServiceEndpoint(provider)),
        async close() {
          if (closed) return;
          closed = true;
          provider.dispose();
          await runtime.dispose();
        },
      };
      return handle;
    },
  };
}

export type { SessionSnapshot };
