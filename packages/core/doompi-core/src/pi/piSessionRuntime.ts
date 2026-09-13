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

type PromptLatency = {
  readonly startedAt: number;
  lastStageAt: number;
  readonly reported: Set<string>;
};

async function sessionStats(runtime: DirectHarnessRuntime, sessionId: string): Promise<SessionStats> {
  const [stored, state, models] = await Promise.all([
    runtime.getSessionStats(),
    runtime.readState(),
    runtime.availableModels(),
  ]);
  // Cost and token totals are maintained by Pi at commit time. Only recent
  // assistant usage is needed to display context occupancy.
  const recent = await runtime.lane.findEntries(
    { type: 'message', order: 'newestFirst', limit: 100 },
    BACKGROUND_CONTEXT,
  );
  const latestAssistant = recent.find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
  const latestUsage =
    latestAssistant?.type === 'message' && latestAssistant.message.role === 'assistant'
      ? latestAssistant.message.usage
      : undefined;
  const contextTokens =
    latestUsage === undefined ? null : latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite;
  const selected =
    typeof state.model === 'object' && state.model !== null
      ? (state.model as { provider?: unknown; id?: unknown })
      : undefined;
  const model = models.find((candidate) => candidate.provider === selected?.provider && candidate.id === selected?.id);
  const contextWindow = model?.contextWindow;
  const sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : undefined;
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
    ...(contextWindow === undefined
      ? {}
      : {
          contextUsage: {
            tokens: contextTokens,
            contextWindow,
            percent: contextTokens === null ? null : Math.round((contextTokens / contextWindow) * 100),
          },
        }),
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
    snapshot: summary(transcript.snapshot()),
    progress: null,
    updates: [],
    presentation: { revision: 0, dropped: 0, events: [], projections: [] },
  });
  const present = (frame: Record<string, unknown>): boolean => {
    const entry = frame.entry as { seq?: number } | undefined;
    if (frame.type === 'entry_appended' && typeof entry?.seq === 'number')
      frame = {
        ...frame,
        transcriptCursor: transcriptCursor(options.sessionId, options.runtime.laneName, historyGeneration, entry.seq),
      };
    const next = presentation.record(frame);
    if (next) state.state.presentation = next;
    return next !== undefined;
  };
  const settlers = new Set<{ resolve(): void; reject(error: Error): void }>();
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
    if (reduction.snapshot) state.state.snapshot = summary(reduction.snapshot);
    if (updates.length > 0) {
      const events = state.state.updates ?? [];
      for (const update of updates) events.push({ sequence: ++updateSequence, update });
      if (events.length > 128) events.splice(0, events.length - 128);
      state.state.updates = events;
    }
    if (reduction.progress) {
      const progress = reduction.progress;
      if (progress.type === 'item_finished') inFlight.delete(progress.item.id);
      else inFlight.set(progress.item.id, progress.item);
    }
    if (state.state.snapshot.phase === 'idle') inFlight.clear();
    if (frame.type === 'navigation_end') historyGeneration += 1;
    const changed = present(frame);
    const publishStartedAt = performance.now();
    if (reduction.snapshot || reduction.progress || updates.length > 0 || changed) state.publish(BACKGROUND_CONTEXT);
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

  const requireLive = (): void => {
    if (disposed) throw new Error('The session runtime is disposed');
  };
  const guardContext = (context: Context): void => {
    requireLive();
    context.abortSignal?.throwIfAborted();
  };
  const awaitSettled = (context: Context): { promise: Promise<void>; resolve(): void; reject(error: Error): void } => {
    let fail!: (error: Error) => void;
    let finish!: () => void;
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
      finish = waiter.resolve;
      settlers.add(waiter);
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
    });
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
    state.state.presentation = presentation.resetCustomEntries();
    state.publish(BACKGROUND_CONTEXT);
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
      const revision = state.state.presentation?.revision ?? 0;
      const drafts = [...inFlight.values()];
      const started = performance.now();
      const page = await readTranscriptPage(options.runtime, args, generation, context);
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
      if (transcript.phase() !== 'idle' || settlers.size > 0) throw new Error('A turn is already running');
      if (waitFor === 'accepted') {
        if (!options.telemetry) {
          await options.runtime.submitPrompt(args.message, args.images);
          return;
        }
        const telemetry = options.telemetry;
        const startedAt = Date.now();
        promptLatency = { startedAt, lastStageAt: startedAt, reported: new Set() };
        const settled = awaitSettled(BACKGROUND_CONTEXT);
        let resolveAdmission!: () => void;
        let rejectAdmission!: (error: Error) => void;
        const admitted = new Promise<void>((resolve, reject) => {
          resolveAdmission = resolve;
          rejectAdmission = reject;
        });
        observe(
          telemetry.runInSpan('doompi_server.prompt_to_settled', { session_id: options.sessionId }, async () => {
            let accepted = false;
            try {
              const submission = await telemetry.runInSpan(
                'doompi_server.prompt_admission',
                { session_id: options.sessionId },
                () => options.runtime.submitPrompt(args.message, args.images),
              );
              if (submission.handledCommand) settled.resolve();
              reportPromptLatency('accepted');
              accepted = true;
              resolveAdmission();
              await Promise.all([
                telemetry.runInSpan(
                  'doompi_server.prompt_engine_settlement',
                  { session_id: options.sessionId },
                  () => submission.settled,
                ),
                telemetry.runInSpan(
                  'doompi_server.prompt_projection_settlement',
                  { session_id: options.sessionId },
                  () => settled.promise,
                ),
              ]);
            } catch (error) {
              reportPromptLatency('failed');
              promptLatency = undefined;
              const failure = error instanceof Error ? error : new Error(String(error));
              settled.reject(failure);
              if (!accepted) {
                await settled.promise.catch(() => undefined);
                rejectAdmission(failure);
              }
              throw failure;
            }
          }),
        );
        await admitted;
        return;
      }
      const startedAt = Date.now();
      promptLatency = { startedAt, lastStageAt: startedAt, reported: new Set() };
      const settled = awaitSettled(context);
      const run = async (): Promise<void> => {
        try {
          const submit = () => options.runtime.submitPrompt(args.message, args.images);
          const submission = options.telemetry
            ? await options.telemetry.runInSpan(
                'doompi_server.prompt_admission',
                { session_id: options.sessionId },
                submit,
              )
            : await submit();
          if (submission.handledCommand) settled.resolve();
          reportPromptLatency('accepted');
          const engineSettlement = options.telemetry
            ? options.telemetry.runInSpan(
                'doompi_server.prompt_engine_settlement',
                { session_id: options.sessionId },
                () => submission.settled,
              )
            : submission.settled;
          const projectionSettlement = options.telemetry
            ? options.telemetry.runInSpan(
                'doompi_server.prompt_projection_settlement',
                { session_id: options.sessionId },
                () => settled.promise,
              )
            : settled.promise;
          await Promise.all([engineSettlement, projectionSettlement]);
        } catch (error) {
          reportPromptLatency('failed');
          promptLatency = undefined;
          settled.reject(error instanceof Error ? error : new Error(String(error)));
          await settled.promise;
        }
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
  let attached = false;

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
        attachClient: () => {
          if (attached) throw new Error('session already attached');
          const attachment = endpointAttachment(createRemoteServiceEndpoint(provider));
          attached = true;
          let released = false;
          return {
            invokeService: attachment.invokeService,
            release() {
              if (released) return;
              released = true;
              try {
                attachment.release();
              } finally {
                attached = false;
              }
            },
          };
        },
        async close() {
          if (closed) return;
          attached = false;
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
