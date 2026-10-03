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

import {
  DoomSessionManagementService,
  DoomSessionService,
  type SessionService,
  type SessionMessageArgs,
  type PromptArgs,
  type SessionServiceState,
  type SessionSnapshot,
  type SessionLifecycle,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptPageRequest,
  type RewindResult,
  type SessionStateInfo,
  type SessionStats,
  type SessionCommand,
  type ModelRef,
  type ThinkingLevel,
} from '../exports/sessionProtocol';
import { createAcpSessionUpdateProjection } from '../services/acpSessionUpdates';
import { createRpcTranscript, type RpcTranscript } from '../services/rpcTranscript';
import { observe, type ServerTelemetry } from '../services/serverTelemetry';
import { createSessionPresentation } from '../services/sessionPresentation';
import { readTranscriptPage, transcriptCursor } from '../services/transcriptPages';
import type { DirectHarnessRuntime, DirectHarnessFrame } from '../types/server/directHarnessRuntime';

const SETTLED = 'agent_settled';
const PROMPT_LATENCY_EVENT = 'doompi_server.prompt_latency';
const SELECTION_COMMANDS = new Set(['mode', 'domains', 'profile', 'minor']);

function isSelectionCommand(text: string): boolean {
  const match = /^\/(\S+)/.exec(text);
  return match !== null && SELECTION_COMMANDS.has(match[1]!);
}

type PromptLatency = {
  readonly startedAt: number;
  lastStageAt: number;
  readonly reported: Set<string>;
};

async function sessionStats(runtime: DirectHarnessRuntime, sessionId: string): Promise<SessionStats> {
  const stored = await runtime.getSessionStats();
  const { contextUsage, sessionFile } = stored;
  return {
    sessionId,
    ...(sessionFile === undefined ? {} : { sessionFile }),
    totalMessages: stored.messageCount,
    tokens: {
      input: stored.usage.input,
      output: stored.usage.output,
      cacheRead: stored.usage.cacheRead,
      cacheWrite: stored.usage.cacheWrite,
      total: stored.usage.totalTokens,
    },
    cost: stored.usage.cost.total,
    ...(contextUsage === undefined ? {} : { contextUsage }),
  };
}

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
  readThreadTranscript?: (
    threadId: string,
    request: TranscriptPageRequest,
    context: Context,
  ) => Promise<TranscriptPage>;
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
    createRpcTranscript({
      id: options.sessionId,
      cwd: options.cwd,
      name: options.sessionName,
      now: Date.now,
      retainEntries: 0,
    });
  const presentation = createSessionPresentation();
  const acpUpdates = createAcpSessionUpdateProjection();
  let updateSequence = 0;
  const inFlight = new Map<string, TranscriptItem>();
  let historyGeneration = 0;
  const summary = (snapshot: SessionSnapshot): Omit<SessionSnapshot, 'transcript'> => {
    const { transcript: _history, ...value } = snapshot;
    return value;
  };
  const state = replicatedState<SessionServiceState>({
    snapshot: { ...summary(transcript.snapshot()), fastMode: false },
    progress: null,
    updates: [],
    presentation: { revision: 0, dropped: 0, events: [], projections: [] },
  });
  void options.runtime
    .readState()
    .then((runtimeState) => {
      if (!disposed)
        state.change(BACKGROUND_CONTEXT, (draft) => {
          draft.snapshot.fastMode = runtimeState.fastMode === true;
        });
    })
    .catch((error) => {
      if (!disposed) present({ type: 'error', error: String(error) });
    });
  const present = (frame: Record<string, unknown>): boolean => {
    if (frame.type === 'fast_mode_changed' && typeof frame.enabled === 'boolean')
      state.change(BACKGROUND_CONTEXT, (draft) => {
        draft.snapshot.fastMode = frame.enabled as boolean;
      });
    const entry = frame.entry as { seq?: number } | undefined;
    if (frame.type === 'entry_appended' && typeof entry?.seq === 'number')
      frame = {
        ...frame,
        transcriptCursor: transcriptCursor(options.sessionId, options.runtime.laneName, historyGeneration, entry.seq),
      };
    const next = presentation.record(frame);
    if (next)
      state.change(BACKGROUND_CONTEXT, (draft) => {
        draft.presentation = next;
      });
    return next !== undefined;
  };
  const settlers = new Set<{ resolve(): void; reject(error: Error): void }>();
  const promptFailures = new Set<(error: Error) => void>();
  let promptLatency: PromptLatency | undefined;
  let lastToolResultAt: number | undefined;
  let assistantMessageStartedAt: number | undefined;
  let disposed = false;
  const reportPromptLatency = (phase: string): void => {
    const active = promptLatency;
    if (active === undefined || active.reported.has(phase) || options.telemetry === undefined) return;
    const now = Date.now();
    active.reported.add(phase);
    observe(
      options.telemetry.recordEvent(PROMPT_LATENCY_EVENT, {
        session_id: options.sessionId,
        phase,
        duration_ms: now - active.startedAt,
        stage_duration_ms: now - active.lastStageAt,
      }),
    );
    active.lastStageAt = now;
  };
  const rejectSettlers = (error: Error): void => {
    for (const waiter of settlers) waiter.reject(error);
    settlers.clear();
  };

  const subscribePresentation =
    options.onPresentationFrame ??
    ((listener: (frame: DirectHarnessFrame) => void) => options.runtime.onPresentationFrame(listener));
  const unsubscribePresentation = subscribePresentation((frame) => {
    if (disposed) return;
    const message =
      typeof frame.message === 'object' && frame.message !== null ? (frame.message as { role?: unknown }) : undefined;
    if (frame.type === 'message_end' && message?.role === 'toolResult') lastToolResultAt = Date.now();
    if (frame.type === 'message_start' && message?.role === 'assistant') {
      const now = Date.now();
      assistantMessageStartedAt = now;
      if (lastToolResultAt !== undefined && options.telemetry) {
        observe(
          options.telemetry.recordEvent('doompi_server.tool_result_to_response', {
            session_id: options.sessionId,
            duration_ms: now - lastToolResultAt,
          }),
        );
      }
      lastToolResultAt = undefined;
    }
    if (frame.type === 'message_end' && message?.role === 'assistant') {
      if (assistantMessageStartedAt !== undefined && options.telemetry)
        observe(
          options.telemetry.recordEvent('doompi_server.assistant_message', {
            session_id: options.sessionId,
            duration_ms: Date.now() - assistantMessageStartedAt,
          }),
        );
      assistantMessageStartedAt = undefined;
    }
    if (frame.type === 'agent_start') reportPromptLatency('agent_started');
    else if (frame.type === 'message_start' && message?.role === 'assistant') reportPromptLatency('response_started');
    else if (frame.type === 'message_update' && message?.role === 'assistant') reportPromptLatency('first_response');
    else if (frame.type === 'message_end' && message?.role === 'assistant') reportPromptLatency('response_completed');
    const reductionStartedAt = performance.now();
    const reduction = transcript.apply(frame);
    if (frame.type === 'lifecycle_update' && frame.lifecycle !== undefined)
      state.change(BACKGROUND_CONTEXT, (draft) => {
        const lifecycle = frame.lifecycle as SessionLifecycle;
        if ((draft.snapshot.lifecycle?.revision ?? -1) <= lifecycle.revision) draft.snapshot.lifecycle = lifecycle;
      });
    const updates = acpUpdates.apply(frame, reduction);
    const reductionDurationMs = performance.now() - reductionStartedAt;
    if (reduction.aggregate && options.telemetry) {
      observe(
        options.telemetry.recordEvent('doompi_server.transcript.aggregate', {
          session_id: options.sessionId,
          ...reduction.aggregate,
        }),
      );
    }
    if (reduction.snapshot || updates.length > 0) {
      state.change(BACKGROUND_CONTEXT, (draft) => {
        if (reduction.snapshot)
          draft.snapshot = {
            ...summary(reduction.snapshot),
            fastMode: draft.snapshot.fastMode ?? false,
            ...(draft.snapshot.lifecycle === undefined ? {} : { lifecycle: draft.snapshot.lifecycle }),
          };
        if (updates.length > 0) {
          const events = draft.updates ?? [];
          for (const update of updates) events.push({ sequence: ++updateSequence, update });
          if (events.length > 128) events.splice(0, events.length - 128);
          draft.updates = events;
        }
      });
    }
    if (reduction.progress) {
      const progress = reduction.progress;
      if (progress.type === 'item_finished') inFlight.delete(progress.item.id);
      else inFlight.set(progress.item.id, progress.item);
    }
    if (state.value.snapshot.phase === 'idle') inFlight.clear();
    if (frame.type === 'navigation_end') historyGeneration += 1;
    const changed = present(frame);
    const publishStartedAt = performance.now();
    void (reduction.snapshot || reduction.progress || updates.length > 0 || changed);
    const publishDurationMs = performance.now() - publishStartedAt;
    if (options.telemetry && (reductionDurationMs >= 50 || publishDurationMs >= 50 || frame.type === SETTLED))
      observe(
        options.telemetry.recordEvent('doompi_server.presentation_frame', {
          session_id: options.sessionId,
          'frame.type': frame.type,
          phase: 'reduce_and_publish',
          duration_ms: reductionDurationMs + publishDurationMs,
        }),
      );
    if (frame.type === SETTLED) {
      lastToolResultAt = undefined;
      assistantMessageStartedAt = undefined;
      reportPromptLatency('settled');
      promptLatency = undefined;
      const waiting = [...settlers];
      settlers.clear();
      for (const settle of waiting) settle.resolve();
    }
  });

  const terminate = (error: Error): void => {
    if (disposed) return;
    disposed = true;
    for (const fail of promptFailures) fail(error);
    promptFailures.clear();
    rejectSettlers(error);
    unsubscribePresentation();
  };
  observe(
    options.runtime.exited.then(
      () => terminate(new Error('The session runtime exited')),
      (error: unknown) => terminate(error instanceof Error ? error : new Error(String(error))),
    ),
  );
  const requireLive = (): void => {
    if (disposed) throw new Error('The session runtime is disposed');
  };
  const guardContext = (context: Context): void => {
    requireLive();
    context.abortSignal?.throwIfAborted();
  };
  const awaitSettled = (): { promise: Promise<void>; resolve(): void; reject(error: Error): void } => {
    let fail!: (error: Error) => void;
    let finish!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          settlers.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          settlers.delete(waiter);
          reject(error);
        },
      };
      fail = waiter.reject;
      finish = waiter.resolve;
      settlers.add(waiter);
    });
    observe(promise);
    return { promise, resolve: finish, reject: fail };
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
    const lifecycle = await options.runtime.readLifecycle();
    if (disposed) return;
    state.change(BACKGROUND_CONTEXT, (draft) => {
      if ((draft.snapshot.lifecycle?.revision ?? -1) <= lifecycle.revision) draft.snapshot.lifecycle = lifecycle;
      draft.presentation = presentation.resetCustomEntries();
    });
  };
  let initializing: Promise<void> | undefined;

  return {
    state,
    async readTranscriptPage(args, context) {
      guardContext(context);
      if (args.threadId !== undefined) {
        if (!options.readThreadTranscript) throw new Error('Child transcript reader is unavailable');
        return options.readThreadTranscript(args.threadId, args, context);
      }
      const generation = historyGeneration;
      const revision = state.value.presentation?.revision ?? 0;
      const drafts = [...inFlight.values()];
      const started = performance.now();
      let snapshot: ReturnType<DirectHarnessRuntime['readEntries']> | undefined;
      const readEntries = () => (snapshot ??= options.runtime.readEntries());
      const page = await readTranscriptPage(
        {
          sessionId: options.runtime.sessionId,
          laneName: options.runtime.laneName,
          lane: {
            getTipId: async () => (await readEntries()).leafId,
            findEntries: async (query) => {
              let entries = (await readEntries()).entries;
              if (query.type) entries = entries.filter((e) => e.type === query.type);
              if (query.customType)
                entries = entries.filter((e) => e.type === 'custom' && e.customType === query.customType);
              if (query.cursor)
                entries = entries.filter((e) =>
                  query.order === 'oldestFirst' ? e.seq > query.cursor!.seq : e.seq < query.cursor!.seq,
                );
              if (query.order === 'newestFirst') entries = entries.toReversed();
              return query.limit === undefined ? entries : entries.slice(0, query.limit);
            },
          },
        },
        args,
        generation,
        context,
      );
      if (options.telemetry)
        observe(
          options.telemetry.recordEvent('doompi_server.transcript_page', {
            session_id: options.sessionId,
            phase: args.direction ?? 'latest',
            duration_ms: performance.now() - started,
            count: page.entries.length,
          }),
        );
      if (generation !== historyGeneration) throw new Error('STALE_TRANSCRIPT_CURSOR');
      return { ...page, revision, drafts };
    },
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
      let projection: ReturnType<typeof awaitSettled> | undefined;
      let latency: PromptLatency | undefined;
      let submitted = false;
      let failed: Error | undefined;
      let rejectFailure!: (error: Error) => void;
      const failure = new Promise<void>((_resolve, reject) => {
        rejectFailure = reject;
      });
      const fail = (error: Error): void => {
        if (failed !== undefined) return;
        failed = error;
        projection?.reject(error);
        rejectFailure(error);
        if (latency !== undefined && promptLatency === latency) {
          reportPromptLatency('failed');
          promptLatency = undefined;
        }
      };
      const cancel = (): void => {
        if (failed !== undefined) return;
        fail(new Error('The session prompt was cancelled', { cause: context.abortSignal?.reason }));
        if (submitted && waitFor === 'settled') void options.runtime.abort().catch(() => undefined);
      };
      const guardPrompt = (): void => {
        if (failed !== undefined) throw failed;
        guardContext(context);
      };
      const submit = async () => {
        guardPrompt();
        submitted = true;
        const submission = await options.runtime.submitPrompt(args.message, args.images);
        observe(submission.settled);
        guardPrompt();
        return submission;
      };
      const span = <T>(name: string, callback: () => Promise<T>): Promise<T> => {
        const operation = options.telemetry
          ? options.telemetry.runInSpan(name, { session_id: options.sessionId }, callback)
          : callback();
        observe(operation);
        return operation;
      };
      const run = async (): Promise<void> => {
        guardPrompt();
        const lifecycle = await options.runtime.readLifecycle();
        guardPrompt();
        if (lifecycle.operation !== null || settlers.size > 0) {
          if (isSelectionCommand(args.message)) {
            const handled = await options.runtime.dispatchCommand(args.message);
            guardPrompt();
            if (handled) return;
          }
          throw new Error('A turn is already running');
        }
        if (waitFor === 'accepted' && !options.telemetry) {
          await submit();
          return;
        }
        const startedAt = Date.now();
        latency = promptLatency = { startedAt, lastStageAt: startedAt, reported: new Set() };
        const settled = (projection = awaitSettled());
        let resolveAdmission: (() => void) | undefined;
        const admitted =
          waitFor === 'accepted'
            ? new Promise<void>((resolve) => {
                resolveAdmission = resolve;
              })
            : undefined;
        const completion = span('doompi_server.prompt_to_settled', async () => {
          const submission = await span('doompi_server.prompt_admission', submit);
          guardPrompt();
          if (submission.handledCommand) settled.resolve();
          reportPromptLatency('accepted');
          resolveAdmission?.();
          await Promise.all([
            span('doompi_server.prompt_engine_settlement', () => submission.settled),
            span('doompi_server.prompt_projection_settlement', () => settled.promise),
          ]);
        }).catch((error: unknown) => {
          const cause = error instanceof Error ? error : new Error(String(error));
          fail(cause);
          throw cause;
        });
        if (admitted) await Promise.race([admitted, completion]);
        else await completion;
      };
      promptFailures.add(fail);
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
      try {
        await Promise.race([run(), failure]);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        fail(cause);
        throw cause;
      } finally {
        promptFailures.delete(fail);
        context.abortSignal?.removeEventListener('abort', cancel);
      }
    },
    async steer(text: string | SessionMessageArgs) {
      requireLive();
      const args = messageArgs(text);
      await options.runtime.steer(args.message, args.images);
    },
    async abort() {
      requireLive();
      await options.runtime.abort((await options.runtime.readLifecycle()).operation?.id);
    },
    async abortOperation(args) {
      requireLive();
      if (!args || typeof args.operationId !== 'string' || !args.operationId)
        throw new Error('Invalid operation identity');
      await options.runtime.abort(args.operationId);
    },
    async setModel(model, context) {
      guardContext(context);
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string')
        throw new Error('Invalid model');
      await options.runtime.setModel(model);
    },
    async setFastMode(enabled, context) {
      guardContext(context);
      if (typeof enabled !== 'boolean') throw new Error('Invalid fast mode');
      await options.runtime.setFastMode(enabled);
      state.change(context, (draft) => {
        draft.snapshot.fastMode = enabled;
      });
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
    async enqueueAutomatic(args, context) {
      guardContext(context);
      const message = messageArgs(args);
      return options.runtime.enqueueAutomatic(message.message, message.images);
    },
    async removeQueued(args, context) {
      guardContext(context);
      if (!args || typeof args.id !== 'string' || !args.id) throw new Error('Invalid queue identity');
      return options.runtime.removeQueued(args.id);
    },
    async promoteQueued(args, context) {
      guardContext(context);
      if (
        !args ||
        typeof args.id !== 'string' ||
        !args.id ||
        (args.operationId !== undefined && (typeof args.operationId !== 'string' || !args.operationId))
      )
        throw new Error('Invalid queue promotion');
      return options.runtime.promoteQueued(args.id, args.operationId);
    },
    async resumeQueue(context) {
      guardContext(context);
      await options.runtime.resumeQueue();
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
      state.change(context, () => undefined);
    },
    async getState(context) {
      guardContext(context);
      const runtimeState = await options.runtime.readState();
      return { ...runtimeState, fastMode: runtimeState.fastMode === true } as unknown as SessionStateInfo;
    },
    async getSessionStats(context) {
      guardContext(context);
      return sessionStats(options.runtime, options.sessionId);
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
      terminate(new Error('The session runtime is disposed'));
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
