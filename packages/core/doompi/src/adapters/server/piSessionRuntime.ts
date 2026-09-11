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
import { createRpcTranscript, type RpcTranscript } from '../../services/server/rpcTranscript.ts';
import { createSessionPresentation } from '../../services/server/sessionPresentation.ts';
import type { DirectHarnessRuntime, DirectHarnessFrame } from '../../types/server/directHarnessRuntime.ts';
import {
  DoomSessionManagementService,
  DoomSessionService,
  type SessionService,
  type SessionMessageArgs,
  type PromptArgs,
  type SessionServiceState,
  type SessionSnapshot,
  type TranscriptItem,
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
  runtime: DirectHarnessRuntime;
  sessionId: string;
  sessionName: string;
  cwd: string;
  telemetry?: ServerTelemetry;
  /** Subscribes to the combined harness and headless presentation projection. */
  onPresentationFrame?: (listener: (frame: DirectHarnessFrame) => void) => () => void;
  /** Delivers one answered extension UI request to the session-scoped headless host. */
  respondToExtensionUi?: (frame: DirectHarnessFrame) => boolean;
  /** Test seam for the projection. */
  transcript?: RpcTranscript;
}

export interface AgentSessionRuntime extends SessionService {
  readonly state: MutableReplicatedState<SessionServiceState>;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/** Projects one in-process harness runtime as a Chord session service. */
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
  const rejectSettlers = (error: Error): void => {
    for (const waiter of settlers) waiter.reject(error);
    settlers.clear();
  };

  void options.runtime.exited.then(
    () => {
      disposed = true;
      rejectSettlers(new Error('The session runtime exited'));
    },
    (error: unknown) => {
      disposed = true;
      rejectSettlers(error instanceof Error ? error : new Error(String(error)));
    },
  );

  const subscribePresentation =
    options.onPresentationFrame ??
    ((listener: (frame: DirectHarnessFrame) => void) => options.runtime.onPresentationFrame(listener));
  const unsubscribePresentation = subscribePresentation((frame) => {
    if (disposed) return;
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
    if (reduction.snapshot || reduction.progress || changed) state.publish(BACKGROUND_CONTEXT);
    if (frame.type === SETTLED) {
      const waiting = [...settlers];
      settlers.clear();
      for (const settle of waiting) settle.resolve();
    }
  });

  const requireLive = (): void => {
    if (disposed) throw new Error('The session runtime is disposed');
  };
  const guardContext = (context: Context): void => {
    requireLive();
    context.abortSignal?.throwIfAborted();
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
        void options.runtime.abort().catch(() => undefined);
      };
      fail = waiter.reject;
      settlers.add(waiter);
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
    });
    return { promise, reject: fail };
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
    )
      throw new Error('Invalid message images');
    return { message: args.text, ...(args.images === undefined ? {} : { images: args.images }) };
  };
  const hydrate = async (): Promise<void> => {
    const { entries } = await options.runtime.readEntries();
    state.state.presentation = presentation.resetCustomEntries();
    for (const entry of entries) if (entry.type === 'custom') present({ type: 'entry_appended', entry });
    state.publish(BACKGROUND_CONTEXT);
  };
  let initializing: Promise<void> | undefined;

  return {
    state,
    initialize() {
      initializing ??= hydrate().catch((error: unknown) => {
        initializing = undefined;
        throw error;
      });
      return initializing;
    },
    async prompt(text: string | PromptArgs, context) {
      guardContext(context);
      const args = messageArgs(text);
      const waitFor = typeof text === 'string' ? 'settled' : (text.waitFor ?? 'settled');
      if (waitFor !== 'accepted' && waitFor !== 'settled') throw new Error('Invalid prompt acknowledgement mode');
      if (transcript.phase() !== 'idle' || settlers.size > 0) throw new Error('A turn is already running');
      if (waitFor === 'accepted') {
        await options.runtime.submitPrompt(args.message, args.images);
        return;
      }
      const settled = awaitSettled(context);
      const run = async (): Promise<void> => {
        try {
          const submission = await options.runtime.submitPrompt(args.message, args.images);
          await submission.settled;
        } catch (error) {
          settled.reject(error instanceof Error ? error : new Error(String(error)));
        }
        await settled.promise;
      };
      if (options.telemetry)
        await options.telemetry.runInSpan('doompi_server.prompt_to_settled', { session_id: options.sessionId }, run);
      else await run();
    },
    async steer(text: string | SessionMessageArgs) {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to steer');
      const args = messageArgs(text);
      await options.runtime.steer(args.message, args.images);
    },
    async abort() {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to abort');
      await options.runtime.abort();
    },
    async setModel(model, context) {
      guardContext(context);
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string')
        throw new Error('Invalid model');
      await options.runtime.setModel(model);
    },
    async setThinking(thinkingLevel, context) {
      guardContext(context);
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel))
        throw new Error('Invalid thinking level');
      await options.runtime.setThinkingLevel(thinkingLevel);
    },
    async followUp(args, context) {
      guardContext(context);
      const message = messageArgs(args);
      await options.runtime.followUp(message.message, message.images);
    },
    async clearQueue(context) {
      guardContext(context);
      return options.runtime.clearQueue();
    },
    async rewind(args, context) {
      guardContext(context);
      if (!args || typeof args.itemId !== 'string' || !args.itemId) throw new Error('Invalid rewind identity');
      const { entries } = await options.runtime.readEntries();
      const entry = entries.toReversed().find((candidate) => {
        if (candidate.type !== 'message' || typeof candidate.id !== 'string') return false;
        const message = candidate.message;
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const record = message as unknown as Record<string, unknown>;
        return (
          candidate.id === args.itemId ||
          record.id === args.itemId ||
          (record.role === 'user' && typeof record.timestamp === 'number' && args.itemId === `user-${record.timestamp}`)
        );
      });
      if (!entry) throw new Error('The selected message is not in the active session tree.');
      const result = await options.runtime.navigateTree(entry.id, {
        ...(args.summarize === undefined ? {} : { summarize: args.summarize }),
        ...(args.customInstructions === undefined ? {} : { customInstructions: args.customInstructions }),
        ...(args.replaceInstructions === undefined ? {} : { replaceInstructions: args.replaceInstructions }),
        ...(args.label === undefined ? {} : { label: args.label }),
      });
      if (!result.cancelled) await hydrate();
      return result as RewindResult;
    },
    async extensionUiResponse(response, context) {
      guardContext(context);
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
      if (!options.respondToExtensionUi?.({ ...response, type: 'extension_ui_response' }))
        throw new Error(`No pending extension UI request: ${response.id}`);
      present({ type: 'extension_ui_answered', id: response.id });
      state.publish(context);
    },
    async getState(context) {
      guardContext(context);
      return (await options.runtime.readState()) as unknown as SessionStateInfo;
    },
    async getSessionStats(context) {
      guardContext(context);
      return (await options.runtime.getSessionStats()) as unknown as SessionStats;
    },
    async getCommands(context) {
      guardContext(context);
      return options.runtime.listCommands() as SessionCommand[];
    },
    async getAvailableModels(context) {
      guardContext(context);
      return (await options.runtime.availableModels()).map((model) => ({
        provider: model.provider,
        id: model.id,
      })) as ModelRef[];
    },
    async getAvailableThinkingLevels(context) {
      guardContext(context);
      return (await options.runtime.availableThinkingLevels()) as ThinkingLevel[];
    },
    async compact(args, context) {
      guardContext(context);
      await options.runtime.compact(args.customInstructions);
      return null;
    },
    async setName(name, context) {
      guardContext(context);
      if (typeof name !== 'string' || name.length > 256) throw new Error('Invalid session name');
      await options.runtime.setName(name);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePresentation();
      rejectSettlers(new Error('The session runtime is disposed'));
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
