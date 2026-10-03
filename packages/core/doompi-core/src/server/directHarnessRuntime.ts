import { randomUUID } from 'node:crypto';

import type { Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import {
  createModels,
  getSupportedThinkingLevels,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Models,
  type MutableModels,
  type Api,
  type Model,
  type ImageContent,
  type Message,
  type Provider,
  type AssistantMessage,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import {
  Harness,
  createRegistry,
  defineDoc,
  GenerationTask,
  ToolTask,
  CompactionTask,
  hook,
  watchEvents,
  UsageDoc,
  LiveDoc,
  InboxDoc,
  AgentDoc,
  UserEntry,
  type Tx,
  type CompactionResult,
  type TaskId,
  type Conversation,
  type Cursor,
  type EntryRecord,
  type EntryId,
  type SubmissionId,
  type HarnessSettings,
  type ToolRegistration,
  type AgentEventStream,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

import { contextTokensOf, contextUsageOf, latestAssistantUsage } from '../services/contextUsage';
import { initializeDurableNavigation, navigateDurableConversation } from '../services/durableNavigation';
import { formatSkillsForSystemPrompt } from '../services/piExtensionHost';
import { openSqliteSessionStorage, SessionIdentityDoc, SessionMetadataDoc } from '../services/sqliteSessionStorage';
import { projectDurableEntries } from '../services/transcriptPages';
import type {
  DirectHarnessRuntime,
  DirectHarnessRuntimeOptions,
  DirectHarnessFrame,
  DirectHarnessEventListener,
  DirectHarnessLifecycle,
  DirectHarnessQueuedInput,
  Entry,
  AgentHarnessTool,
  AgentMessage,
  HarnessEvent,
} from '../types/server/directHarnessRuntime';

export const AGENT_SETTLED_ENTRY_TYPE = 'doompi.agent-settled';
const LifecycleDoc = defineDoc({
  kind: 'doompi.server.lifecycle',
  version: 1,
  scope: 'session',
  initial: () => ({ json: '{"revision":0,"paused":false,"queue":[]}' }),
});
const FastModeDoc = defineDoc({
  kind: 'doompi.fast-mode',
  version: 1,
  scope: 'session',
  initial: (): { enabled: boolean } => ({ enabled: false }),
});
const CODEX_API = 'openai-codex-responses';
const CODEX_PROVIDER = 'openai-codex';
const LabelsDoc = defineDoc({
  kind: 'doompi.labels',
  version: 1,
  scope: 'session',
  initial: () => ({ labels: {} as Record<string, string> }),
});
type Retained = Omit<DirectHarnessQueuedInput, 'disposition'> & {
  disposition: DirectHarnessQueuedInput['disposition'] | 'consumed' | 'removed';
  // Older records have unknown provenance and remain retained, not queue-owned.
  explicitQueue?: boolean;
  attempt?: number;
  submissionMode?: 'steer' | 'followUp' | 'reject' | 'write';
} & { submissionId?: number; conversationId?: number; message?: AgentMessage; operationId?: string };
type InternalDeliveryRecord = {
  message: AgentMessage;
  conversationId: number;
  submissionId?: number;
};
type LifecycleRecord = {
  revision: number;
  paused: boolean;
  abortOperationId?: string;
  abortTaskId?: number;
  queue: Retained[];
  internalDeliveries?: Record<string, InternalDeliveryRecord>;
};

function nativeId<T extends number>(id: string): T {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== id)
    throw new Error(`Invalid durable identifier: ${id}`);
  return value as T;
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function text(message: string | AgentMessage): string {
  if (typeof message === 'string') return message;
  if (!('content' in message))
    return 'summary' in message ? message.summary : 'output' in message ? message.output : '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}
/** Compatibility projection keeps protocol identities strings and retains fork ancestry. */
export async function projectDurableConversationEntries(
  conversation: Conversation,
  context: Context,
): Promise<Entry[]> {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  records.reverse();
  return projectDurableEntries(records);
}
export async function promptForAssistantText(
  runtime: DirectHarnessRuntime,
  prompt: string,
): Promise<string | undefined> {
  const previous = new Set((await runtime.readEntries()).entries.map((e) => e.id));
  await (
    await runtime.submitInternalMessage(prompt)
  ).settled;
  return (
    (await runtime.readEntries()).entries
      .toReversed()
      .filter((e) => !previous.has(e.id))
      .flatMap((e) => (e.type === 'message' && e.message.role === 'assistant' ? [text(e.message).trim()] : []))[0] ||
    undefined
  );
}

export async function createDirectHarnessRuntime<TContext extends object | undefined = object | undefined>(
  options: DirectHarnessRuntimeOptions<TContext>,
): Promise<DirectHarnessRuntime<TContext>> {
  if (options.initialFastMode !== undefined && typeof options.initialFastMode !== 'boolean')
    throw new Error('Initial Fast mode must be a boolean.');
  const context = options.context ?? BACKGROUND_CONTEXT;
  if (options.storage === 'jsonl' || options.legacySessionPath !== undefined)
    throw new Error('Legacy JSONL direct storage is unsupported; use durable-v1 SQLite');
  if (options.session && !options.durableStorage)
    throw new Error('A durable Session injection requires its raw durableStorage');
  const storage = options.durableStorage
    ? {
        storage: options.durableStorage,
        sessionFile: options.sessionPath,
        historyLease: undefined,
        repository: undefined,
      }
    : await openSqliteSessionStorage(options, context);
  let startupHarness: Harness | undefined;
  try {
    const registry = createRegistry();
    const environment = new NodeExecutionEnv({ cwd: options.cwd });
    let disposed = false;
    let quarantined = false;
    let failure: unknown;
    let preparationFailure: unknown;
    const terminatingCalls = new Set<string>();
    let fastMode = false;
    let resources = options.resources ?? {};
    let tools = options.tools ?? [];
    let activeNames = new Set(options.activeToolNames ?? tools.map((t) => t.name));
    let settings: HarnessSettings = {
      stream: options.streamOptions,
      retry: options.retry,
      compaction: options.compaction,
      toolExecution: options.toolExecution,
      steeringMode: options.steeringMode,
      followUpMode: options.followUpMode,
    };
    const listeners = new Set<(frame: DirectHarnessFrame) => void>();
    const eventListeners = new Set<DirectHarnessEventListener>();
    const emit = (frame: DirectHarnessFrame) => {
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (error) {
          for (const other of listeners) if (other !== listener) other({ type: 'handler_error', error: String(error) });
        }
      }
    };
    const writable = async <T>(work: () => Promise<T>): Promise<T> => {
      if (disposed || quarantined) throw new Error('Direct harness writes are unavailable', { cause: failure });
      try {
        await storage.historyLease?.assertQuiescent();
        return await work();
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (
          typeof code === 'string' &&
          ['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EPERM', 'EROFS'].includes(code)
        ) {
          quarantined = true;
          failure = error;
          emit({ type: 'error', code: 'storage_quarantined', error: String(error) });
        }
        throw error;
      }
    };
    let sourceModels: Models | MutableModels;
    if (options.models) sourceModels = options.models;
    else {
      if (!options.providers?.length) throw new Error('Direct harness requires Models or a Provider');
      sourceModels = createModels(options.credentials ? { credentials: options.credentials } : undefined);
    }
    for (const provider of options.providers ?? []) {
      const mutable = sourceModels as Partial<MutableModels> & {
        registerNativeProvider?: (provider: Provider) => void;
      };
      const register = mutable.setProvider?.bind(sourceModels) ?? mutable.registerNativeProvider?.bind(sourceModels);
      if (!register) throw new Error('Models registry cannot register providers');
      register(provider);
    }
    const models = new Proxy(sourceModels, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (
          !['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred'].includes(
            String(key),
          )
        )
          return value.bind(target);
        return (...args: unknown[]) => {
          if (disposed || quarantined || preparationFailure)
            throw new Error('Model dispatch unavailable', { cause: preparationFailure });
          options.guardModelRequest?.();
          const request = args[1] as { tools?: { name: string }[] };
          if (
            !['complete', 'completeSimple'].includes(String(key)) &&
            request?.tools?.some((t) => !activeNames.has(t.name))
          )
            throw new Error('Model request contains disabled tools');
          const requestOptions = args[2] as Record<string, unknown> | undefined;
          const usePriority =
            fastMode &&
            (args[0] as Model<Api>).api === CODEX_API &&
            (args[0] as Model<Api>).provider === CODEX_PROVIDER;
          const originalOnPayload = requestOptions?.onPayload;
          args[2] = {
            ...requestOptions,
            ...(usePriority ? { serviceTier: 'priority' } : {}),
            onPayload: async (payload: unknown, model: Model<Api>) => {
              options.guardModelRequest?.();
              const original =
                typeof originalOnPayload === 'function' ? await originalOnPayload(payload, model) : undefined;
              const transformed = original === undefined ? payload : original;
              const patch = await options.beforePayload?.({ payload: transformed, model }, context);
              const finalPayload = patch === undefined ? transformed : patch.payload;
              if (!usePriority) return finalPayload;
              if (typeof finalPayload !== 'object' || finalPayload === null || Array.isArray(finalPayload))
                throw new Error('Invalid Codex request payload');
              return { ...finalPayload, service_tier: 'priority' };
            },
          };
          const dispatched: unknown = Reflect.apply(value, target, args);
          if (!['stream', 'streamSimple', 'fetchDeferred'].includes(String(key))) return dispatched;
          const source = dispatched as AssistantMessageEventStream;
          const output = createAssistantMessageEventStream();
          const requestedModel = args[0] as Model<Api>;
          const signal = (args[2] as { signal?: AbortSignal }).signal;
          let ended = false;
          let current: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: requestedModel.api,
            provider: requestedModel.provider,
            model: requestedModel.id,
            timestamp: Date.now(),
            stopReason: 'pending',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          const cancel = () => {
            if (ended) return;
            ended = true;
            const cancelled = { ...current, stopReason: 'aborted' as const, errorMessage: 'Agent request aborted' };
            output.push({ type: 'error', reason: 'aborted', error: cancelled });
            output.end();
          };
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
          void (async () => {
            try {
              for await (const event of source) {
                if (ended) break;
                if ('partial' in event) current = event.partial;
                output.push(event);
              }
              if (!ended) {
                ended = true;
                output.end(await source.result());
              }
            } catch (error) {
              if (!ended) {
                ended = true;
                const failed = { ...current, stopReason: 'error' as const, errorMessage: String(error) };
                output.push({ type: 'error', reason: 'error', error: failed });
                output.end();
              }
            } finally {
              signal?.removeEventListener('abort', cancel);
            }
          })();
          return output;
        };
      },
    }) as Models;
    const resolveToolContext = async (ctx: Context) =>
      typeof options.toolContext === 'function' ? options.toolContext(ctx) : (options.toolContext as TContext);
    const nativeTool = (tool: AgentHarnessTool<TContext>): ToolRegistration => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      constrainedSampling: tool.constrainedSampling,
      prepareArguments: tool.prepareArguments ? (args) => tool.prepareArguments!(args) : undefined,
      replay: tool.replay ?? 'unsafe',
      executionMode: tool.executionMode,
      async execute(args, api, ctx) {
        if (!activeNames.has(tool.name)) throw new Error(`Tool '${tool.name}' is no longer active`);
        const pending = tool.execute(
          api.callId,
          args,
          (partial) => {
            for (const part of partial.content) if (part.type === 'text') api.output(part.text);
            if (partial.details !== undefined)
              void api
                .details(json(partial.details), ctx)
                .catch((error) => emit({ type: 'error', error: String(error) }));
          },
          await resolveToolContext(ctx),
          {
            invocationId: String(api.taskId),
            operationId: String(api.taskId),
            turnId: String(api.taskId),
            getMemo: (name) => api.memo(name, ctx),
            setMemo: async (name, value) => {
              if (value === undefined) throw new Error('Durable invocation memos cannot be deleted');
              await api.memo(name, value, ctx);
            },
          },
          ctx,
        );
        const result = await awaitWithContext(pending, ctx);
        return {
          content: result.content,
          isError: result.isError,
          ...(result.details === undefined ? {} : { details: json(result.details) }),
        };
      },
    });
    const install = () =>
      registry.install({
        name: 'doompi.host',
        tools: tools.map(nativeTool),
        sections: [
          {
            key: 'doompi',
            tag: false,
            async render(_input, ctx) {
              preparationFailure = undefined;
              try {
                const prompt =
                  typeof options.systemPrompt === 'function'
                    ? await options.systemPrompt(await resolveToolContext(ctx), ctx)
                    : (options.systemPrompt ?? '');
                const skills =
                  options.systemPrompt === undefined ? formatSkillsForSystemPrompt(resources.skills ?? []) : '';
                return [prompt, skills].filter(Boolean).join('\n\n');
              } catch (error) {
                preparationFailure = error;
                throw error;
              }
            },
          },
        ],
        hooks: [
          hook(GenerationTask, {
            async beforeRequest(request, api, ctx) {
              try {
                const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
                const retained = await api.snapshot(LifecycleDoc, ctx);
                const queue = JSON.parse(retained?.json ?? '{"queue":[]}') as LifecycleRecord;
                if (
                  live?.run &&
                  queue.queue.some(
                    (item) =>
                      item.operationId !== undefined &&
                      item.submissionId !== undefined &&
                      live.run!.inputs.includes(item.submissionId as SubmissionId) &&
                      item.operationId !== String(live.run!.inputs[0]),
                  )
                )
                  throw new Error('Steering target changed before model admission');
                const agent = await conversation.agent(ctx);
                const model = agent.model ? models.getModel(agent.model.provider, agent.model.modelId) : undefined;
                await options.beforeModelRequest?.(
                  { phase: 'turn', model, prompt: [...request.messages], resources },
                  ctx,
                );
                const systemPrompt = getCurrentSystemPrompt(request.messages);
                const contextContributions = new Map<string, AgentMessage[]>();
                if (options.transformContext) {
                  const view = await conversation.context(ctx);
                  const customByEntry = new Map<number, AgentMessage>();
                  for (const raw of view.entries) {
                    const entry = projectDurableEntries([raw])[0];
                    if (entry?.type !== 'message' || entry.message.role !== 'custom') continue;
                    const data =
                      raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : undefined;
                    const receipt =
                      typeof data?.inputRequestId === 'string'
                        ? await storage.storage.submissionByRequest(conversation.id, data.inputRequestId, ctx)
                        : undefined;
                    const fallback =
                      receipt?.status === 'unanswered' &&
                      !('entry' in receipt && receipt.entry !== undefined) &&
                      typeof data?.inputRequestId === 'string'
                        ? await storage.storage.submissionByRequest(
                            conversation.id,
                            `${data.inputRequestId}:context`,
                            ctx,
                          )
                        : undefined;
                    const placed = fallback ?? receipt;
                    const placedEntry =
                      placed && 'entry' in placed && placed.entry !== undefined
                        ? view.entries.find((candidate) => candidate.id === placed.entry)
                        : undefined;
                    const target = placedEntry?.edits?.some((edit) => edit.target === raw.id)
                      ? raw.id
                      : (placedEntry?.id ?? raw.id);
                    const contributions =
                      view.contributions[view.entries.findIndex((candidate) => candidate.id === target)];
                    const original = placedEntry?.edits?.find(
                      (edit) => edit.target === raw.id && edit.action === 'replace',
                    );
                    const model =
                      original?.messages ?? view.entries.find((candidate) => candidate.id === target)?.model;
                    if (
                      model?.length === 1 &&
                      contributions?.length === 1 &&
                      JSON.stringify(model[0]) === JSON.stringify(contributions[0])
                    )
                      customByEntry.set(target, entry.message);
                  }
                  for (const [index, raw] of view.entries.entries()) {
                    const custom = customByEntry.get(raw.id);
                    for (const native of view.contributions[index] ?? []) {
                      const key = JSON.stringify(native);
                      const message = custom && view.contributions[index]?.length === 1 ? custom : native;
                      const contributions = contextContributions.get(key) ?? [];
                      contributions.push(message);
                      contextContributions.set(key, contributions);
                    }
                  }
                }
                // Restore metadata only for unchanged native contributions, preserving context edits and ordering.
                const contextMessages = request.messages
                  .filter((m) => m.role !== 'system')
                  .map((message) => contextContributions.get(JSON.stringify(message))?.shift() ?? message);
                const patch = await options.transformContext?.({ messages: contextMessages, systemPrompt }, ctx);
                let messages: Message[] = patch
                  ? [
                      {
                        role: 'system',
                        content: patch.systemPrompt ?? systemPrompt,
                        timestamp: Date.now(),
                        toolsAdded: getCurrentTools(request.messages),
                      },
                      ...convertToLlm(patch.messages ?? request.messages.filter((m) => m.role !== 'system')),
                    ]
                  : [...request.messages];
                if (options.toProviderMessages) messages = await options.toProviderMessages(messages, ctx);
                await options.beforeModelRequest?.({ phase: 'request', model, resources }, ctx);
                return { messages };
              } catch (error) {
                preparationFailure = error;
                throw error;
              }
            },
          }),
          hook(ToolTask, {
            async beforeTool(call, _api, ctx) {
              const patch = await options.beforeTool?.(
                { toolCallId: call.id, toolName: call.name, args: call.arguments as Record<string, JsonValue> },
                ctx,
              );
              if (patch?.block?.terminate) terminatingCalls.add(call.id);
              return patch ? { arguments: patch.args, block: patch.block?.reason } : undefined;
            },
            async afterTool(call, result, _api, ctx) {
              const patch = await options.afterTool?.(
                {
                  toolCallId: call.id,
                  toolName: call.name,
                  args: call.arguments as Record<string, JsonValue>,
                  content: result.content ?? [],
                  details: result.details,
                  isError: result.isError ?? false,
                  usage: result.usage,
                },
                ctx,
              );
              return patch
                ? {
                    ...result,
                    ...patch,
                    control:
                      patch.terminate || terminatingCalls.delete(call.id)
                        ? { ...result.control, terminate: true }
                        : result.control,
                  }
                : terminatingCalls.delete(call.id)
                  ? { ...result, control: { ...result.control, terminate: true } }
                  : undefined;
            },
          }),
          hook(CompactionTask, {
            async beforeCompact(input, _api, ctx) {
              if (!options.beforeCompaction) return;
              const entries = projectDurableEntries(input.entries);
              const patch = await options.beforeCompaction(
                {
                  reason: input.reason,
                  customInstructions: input.instructions,
                  preparation: {
                    entries,
                    messages: [...input.messages],
                    tokensBefore: 0,
                    retainedTail: [],
                    firstKeptEntryId: String(input.firstKept),
                    messagesToSummarize: [...input.messages],
                    turnPrefixMessages: [],
                    isSplitTurn: false,
                    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
                    settings: {
                      enabled: options.compaction?.enabled ?? true,
                      reserveTokens: options.compaction?.reserveTokens ?? 16384,
                      keepRecentTokens: options.compaction?.keepRecentTokens ?? 20000,
                    },
                  },
                },
                ctx,
              );
              if (patch?.decline) return { decline: true };
              if (patch?.compaction) return { summary: patch.compaction.summary };
              return undefined;
            },
          }),
        ],
      });
    install();
    const harness = await Harness.open(
      storage.storage,
      {
        models,
        registry,
        get settings() {
          return settings;
        },
        env: () => environment,
        onReport: (error) => emit({ type: 'handler_error', error: String(error) }),
      },
      context,
    );
    startupHarness = harness;
    const root = await harness.root(context, {
      agent: {
        cwd: options.cwd,
        ...((options.model ?? models.getModels()[0])
          ? {
              model: {
                provider: (options.model ?? models.getModels()[0]!).provider,
                modelId: (options.model ?? models.getModels()[0]!).id,
              },
            }
          : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      },
    });
    const activeId = await initializeDurableNavigation(harness, root.id, context);
    let conversation = (await harness.conversation(activeId, context))!;
    const storedAgent = await harness.snapshot(AgentDoc, conversation.id, context);
    const initialModel = options.model ?? models.getModels()[0];
    await conversation.configure(
      {
        ...(!storedAgent?.model && initialModel
          ? { model: { provider: initialModel.provider, modelId: initialModel.id } }
          : {}),
        ...(!storedAgent?.thinkingLevel && options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        tools: tools.filter((t) => activeNames.has(t.name)).map(nativeTool),
      },
      context,
    );
    const storedFastMode = await harness.snapshot(FastModeDoc, context);
    fastMode = storedFastMode?.enabled ?? options.initialFastMode ?? false;
    const identity = await harness.snapshot(SessionIdentityDoc, context);
    const sessionId = identity?.id || options.sessionId || randomUUID();
    await writable(() =>
      harness.commit(async (tx) => {
        const identity = await tx.doc(SessionIdentityDoc);
        if (!identity.id) {
          identity.id = sessionId;
          identity.createdAt = Date.now();
          identity.parentSessionId = options.parentSessionId ?? '';
        }
        if (!storedFastMode) {
          (await tx.doc(FastModeDoc)).enabled = fastMode;
          if (options.initialFastMode !== undefined)
            await tx.appendEntry(conversation.id, {
              kind: 'doompi.fast-mode',
              data: { version: 1, enabled: fastMode, sessionId },
            });
        }
        const metadata = await tx.doc(SessionMetadataDoc);
        metadata.workspaceRoot ||= options.cwd;
        if (options.lane !== undefined) metadata.laneName = options.lane;
        if (options.sessionName !== undefined) metadata.name = options.sessionName;
      }, context),
    );
    const laneName = options.lane ?? 'main';
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const readRecord = async (): Promise<LifecycleRecord> =>
      JSON.parse(
        (await harness.snapshot(LifecycleDoc, context))?.json ?? '{"revision":0,"paused":false,"queue":[]}',
      ) as LifecycleRecord;
    const changeRecord = async <T>(change: (record: LifecycleRecord) => T): Promise<T> =>
      writable(() =>
        harness.commit(async (tx) => {
          const doc = await tx.doc(LifecycleDoc);
          const record = JSON.parse(doc.json) as LifecycleRecord;
          const result = change(record);
          record.revision++;
          doc.json = JSON.stringify(record);
          return result;
        }, context),
      );
    let userAdmission = false;
    let userAdmissionSettled: Promise<void> = Promise.resolve();
    let releaseUserAdmission: (() => void) | undefined;
    const guardUserAdmission = () => {
      if (userAdmission) throw new Error('A user interruption is already being admitted');
    };
    let external: string | undefined;
    let externalAbort: AbortController | undefined;
    const execution = async () => {
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const inspected = await harness.inspect(context);
      const task = inspected.tasks.find((t) => t.record.conversationId === conversation.id && !t.record.background);
      return live?.run
        ? {
            id: String(live.run.inputs[0]),
            kind: 'run' as const,
            status:
              (await readRecord()).abortOperationId === String(live.run.inputs[0])
                ? ('aborting' as const)
                : ('open' as const),
          }
        : task
          ? {
              id: String(task.record.id),
              kind: 'compaction' as const,
              status: task.record.abortRequested ? ('aborting' as const) : ('open' as const),
            }
          : external
            ? { id: external, kind: 'navigation' as const, status: 'open' as const }
            : settling
              ? { id: 'settling', kind: 'run' as const, status: 'open' as const }
              : null;
    };
    const readLifecycle = async (): Promise<DirectHarnessLifecycle> => {
      const record = await readRecord();
      return {
        revision: record.revision,
        paused: record.paused,
        queue: record.queue
          .filter(
            (item): item is Retained & { disposition: DirectHarnessQueuedInput['disposition'] } =>
              item.explicitQueue === true && item.disposition !== 'consumed' && item.disposition !== 'removed',
          )
          .map(
            ({
              explicitQueue: _q,
              submissionId: _s,
              conversationId: _c,
              message: _m,
              operationId: _o,
              attempt: _a,
              ...item
            }) => item,
          ),
        operation: await execution(),
      };
    };
    const publish = async () => emit({ type: 'lifecycle_update', lifecycle: await readLifecycle() });
    let watcher: AgentEventStream;
    let eventsSettled = Promise.resolve();
    let settling = 0;
    const admittingInternal = new Set<string>();
    const reconcilingInternal = new Map<string, Promise<void>>();
    const internalDelivery = new Map<SubmissionId, { done: Promise<void>; resolve: () => void }>();
    const deliveredInputs = new Set<SubmissionId>();
    const nextTurnMessages: AgentMessage[] = [];
    let deferredInternalCount = 0;
    const flushNextTurn = async () => {
      const staged = nextTurnMessages.splice(0);
      for (let index = 0; index < staged.length; index++) {
        const message = staged[index]!;
        try {
          await writable(() =>
            conversation.submit(
              {
                type: 'write',
                requestId: randomUUID(),
                entry: {
                  kind: 'doompi.entry',
                  data: json({ type: 'message', message }),
                  model: convertToLlm([message]),
                },
              },
              context,
            ),
          );
        } catch (error) {
          nextTurnMessages.unshift(...staged.slice(index));
          throw error;
        }
      }
    };
    let logicalLoopActive = false;
    let lastAssistant: AssistantMessage | undefined;
    let partial: AssistantMessage | undefined;
    let toolResults: ToolResultMessage[] = [];
    const deliver = async (event: HarnessEvent, eventContext: Context) => {
      for (const listener of eventListeners)
        try {
          await listener(event, eventContext);
        } catch (error) {
          emit({ type: 'handler_error', error: String(error) });
        }
    };
    const attach = async () => {
      if (watcher) await watcher.stop();
      watcher = await watchEvents(harness, conversation.id, context);
      let predecessor = watcher.snapshot.entries.at(-1)?.id;
      const customSources = new Map<string, AgentMessage>();
      const generatedSources = new Map<EntryId, AgentMessage | undefined>();
      const rememberCustom = (raw: EntryRecord) => {
        const projected = projectDurableEntries([raw])[0];
        const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : undefined;
        if (
          projected?.type === 'message' &&
          projected.message.role === 'custom' &&
          typeof data?.inputRequestId === 'string'
        )
          customSources.set(data.inputRequestId, projected.message);
      };
      for (const raw of watcher.snapshot.entries) rememberCustom(raw);
      for (const requestId of customSources.keys()) {
        const receipt = await storage.storage.submissionByRequest(conversation.id, requestId, context);
        if (receipt && receipt.status !== 'queued') customSources.delete(requestId);
      }
      const generatedEntrySource = async (raw: EntryRecord, ctx: Context) => {
        if (generatedSources.has(raw.id)) return generatedSources.get(raw.id);
        let source: AgentMessage | undefined;
        if (raw.model?.[0]?.role === 'user')
          for (const [requestId, custom] of customSources) {
            const receipt = await storage.storage.submissionByRequest(conversation.id, requestId, ctx);
            if (receipt && 'entry' in receipt && receipt.entry === raw.id) {
              source = custom;
              customSources.delete(requestId);
              break;
            }
          }
        generatedSources.set(raw.id, source);
        while (generatedSources.size > 128) generatedSources.delete(generatedSources.keys().next().value!);
        return source;
      };
      lastAssistant = undefined;
      partial = undefined;
      toolResults = [];
      watcher.start(async (events, eventContext) => {
        for (const event of events) {
          let mapped: HarnessEvent | undefined;
          if (event.type === 'turn_start' || event.type === 'run_start') {
            lastAssistant = undefined;
            partial = undefined;
            toolResults = [];
          }
          if (event.type === 'message_end' || event.type === 'entry_appended') {
            rememberCustom(event.entry);
            const entry = projectDurableEntries([event.entry])[0];
            await generatedEntrySource(event.entry, eventContext);
            if (entry) {
              entry.parentId = predecessor === undefined ? null : String(predecessor);
              const added: HarnessEvent = { type: 'entry_added', entry };
              emit({ type: 'entry_appended', entry });
              eventsSettled = eventsSettled.then(() => deliver(added, eventContext));
            }
            predecessor = event.entry.id;
          }
          if (['run_start', 'run_end', 'turn_start', 'compaction_start'].includes(event.type))
            mapped = { type: event.type } as HarnessEvent;
          if (event.type === 'message_start') {
            if (event.message.role === 'assistant') partial = structuredClone(event.message);
            mapped = { type: 'message_start', message: event.message };
          }
          if (event.type === 'message_end' && event.entry.model?.[0]) {
            const projected = projectDurableEntries([event.entry])[0];
            if (projected?.type === 'custom' && projected.customType === 'doompi.internal-context') continue;
            const message =
              (await generatedEntrySource(event.entry, eventContext)) ??
              (projected?.type === 'message' && projected.message.role === 'custom'
                ? projected.message
                : event.entry.model[0]);
            if (message.role === 'assistant') lastAssistant = message;
            if (message.role === 'toolResult') toolResults.push(message);
            mapped = { type: 'message_end', message, entryId: String(event.entry.id), runId: String(conversation.id) };
          }

          if (event.type === 'tool_execution_start') mapped = { ...event, type: 'tool_start' };
          if (event.type === 'tool_execution_end') {
            const result = event.entry?.model?.find((m) => m.role === 'toolResult');
            mapped = {
              type: 'tool_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: {
                content: result?.content ?? [],
                details: result?.details === undefined ? undefined : json(result.details),
              },
              isError: result?.isError ?? true,
            };
          }
          if (event.type === 'turn_end' && lastAssistant) {
            mapped = { type: 'turn_end', message: lastAssistant, toolResults };
            toolResults = [];
            lastAssistant = undefined;
            partial = undefined;
          }
          if (event.type === 'message_update' && partial) {
            for (const change of event.changes) {
              if (change.type === 'message') {
                partial = structuredClone(change.message);
              } else if ('block' in change) {
                partial.content[change.contentIndex] = structuredClone(change.block);
              }
              const block = 'contentIndex' in change ? partial.content[change.contentIndex] : undefined;
              if (change.type === 'text_delta' && block?.type === 'text') block.text += change.delta;
              if (change.type === 'thinking_delta' && block?.type === 'thinking') block.thinking += change.delta;
              {
                const update: HarnessEvent = {
                  type: 'message_update',
                  message: structuredClone(partial),
                  event:
                    'delta' in change
                      ? {
                          type: change.type,
                          contentIndex: change.contentIndex,
                          delta: change.delta,
                          partial: structuredClone(partial),
                        }
                      : { type: 'start', partial: structuredClone(partial) },
                };
                emit({ ...update, assistantMessageEvent: update.event });
                eventsSettled = eventsSettled.then(() => deliver(update, eventContext));
              }
            }
          }
          if (event.type === 'tool_execution_update')
            mapped = {
              type: 'tool_update',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              partialResult: {
                content: [
                  {
                    type: 'text',
                    text: event.output ? ('set' in event.output ? event.output.set : (event.output.append ?? '')) : '',
                  },
                ],
                details: event.details,
              },
            };
          if (event.type === 'compaction_end') {
            const receipt = await harness.waitForTask(event.taskId as TaskId<CompactionResult>, eventContext);
            const outcome = receipt.state.outcome;
            const result = outcome.status === 'completed' ? outcome.result : undefined;
            const summary = result?.submissionId
              ? await harness.submission(result.submissionId, eventContext)
              : undefined;
            const status = await summary?.status(eventContext);
            const entryId = result?.entryId ?? (status && 'entry' in status ? status.entry : undefined);
            mapped = {
              type: 'compaction_end',
              status:
                outcome.status === 'completed'
                  ? result?.entryId !== undefined || result?.submissionId !== undefined
                    ? 'completed'
                    : 'aborted'
                  : outcome.status === 'aborted'
                    ? 'aborted'
                    : 'failed',
              reason: event.reason,
              entryId: entryId === undefined ? undefined : String(entryId),
              error:
                outcome.status !== 'completed' && outcome.status !== 'aborted'
                  ? new Error(
                      'error' in outcome ? (outcome.error?.message ?? 'Compaction failed') : 'Compaction failed',
                    )
                  : undefined,
            };
          }
          if (event.type === 'inbox_update')
            mapped = { type: 'queue_update', queues: event.items.map((item) => ({ kind: item.mode })) };
          if (event.type === 'message_end') {
            for (const message of event.entry.model ?? [])
              if (message.role === 'assistant')
                eventsSettled = eventsSettled.then(() =>
                  deliver({ type: 'usage', row: { id: String(event.entry.id), usage: message.usage } }, eventContext),
                );
          }
          if (!mapped) continue;
          const publishMapped = (event: HarnessEvent) =>
            emit({
              ...event,
              type:
                event.type === 'tool_start'
                  ? 'tool_execution_start'
                  : event.type === 'tool_update'
                    ? 'tool_execution_update'
                    : event.type === 'tool_end'
                      ? 'tool_execution_end'
                      : event.type === 'entry_added'
                        ? 'entry_appended'
                        : event.type,
            });
          if (mapped.type === 'run_end') {
            const settledEvent = {
              runId: String(event.type === 'run_end' ? event.inputs[0] : conversation.id),
              timestamp: Date.now(),
            };
            settling++;
            let released = false;
            const release = () => {
              if (!released) {
                settling--;
                released = true;
              }
            };
            eventsSettled = eventsSettled
              .then(async () => {
                await reconcile();
                try {
                  await writable(() =>
                    harness.commit(
                      (tx) =>
                        tx.appendEntry(conversation.id, {
                          kind: AGENT_SETTLED_ENTRY_TYPE,
                          data: settledEvent,
                        }),
                      eventContext,
                    ),
                  );
                } catch (error) {
                  emit({ type: 'error', code: 'agent_settled', error: String(error) });
                }
                const live = await harness.snapshot(LiveDoc, conversation.id, eventContext);
                const successorActive = !!live?.run && String(live.run.inputs[0]) !== settledEvent.runId;
                mapped = { type: 'run_end', runId: settledEvent.runId, successorActive };
                publishMapped(mapped);
                await deliver(mapped, eventContext);
                release();
                // A settlement hook can admit work after the initial successor check.
                const lifecycle = await readLifecycle();
                emit({ type: 'lifecycle_update', lifecycle });
                if (!lifecycle.operation) {
                  logicalLoopActive = false;
                  emit({ type: 'agent_end', runId: settledEvent.runId });
                  emit({ type: 'agent_settled', ...settledEvent });
                }
              })
              .catch((error) => emit({ type: 'error', code: 'settled_event', error: String(error) }))
              .finally(async () => {
                release();
                if (event.type === 'run_end')
                  for (const id of event.inputs) {
                    deliveredInputs.add(id);
                    internalDelivery.get(id)?.resolve();
                  }
                while (deliveredInputs.size > 128) deliveredInputs.delete(deliveredInputs.values().next().value!);
                try {
                  await publish();
                } catch (error) {
                  emit({ type: 'error', code: 'lifecycle_update', error: String(error) });
                }
                // Do not await drain here: drain waits for this settlement chain.
                void drain().catch((error) => emit({ type: 'error', code: 'drain', error: String(error) }));
              });
          } else {
            // Protocol publication must not wait for extension hooks on earlier events.
            publishMapped(mapped);
            if (mapped.type === 'run_start') {
              if (!logicalLoopActive) emit({ type: 'agent_start' });
              logicalLoopActive = true;
              void publish().catch((error) => emit({ type: 'error', code: 'lifecycle_update', error: String(error) }));
            }
            const delivered = mapped;
            eventsSettled = eventsSettled.then(() => deliver(delivered, eventContext));
          }
        }
      });
    };
    await attach();
    const reconcileInternal = (requestId: string, item: InternalDeliveryRecord): Promise<void> => {
      const existing = reconcilingInternal.get(requestId);
      if (existing) return existing;
      const work = (async () => {
        if (admittingInternal.has(requestId)) return;
        const target =
          item.conversationId === conversation.id
            ? conversation
            : await harness.conversation(item.conversationId as typeof conversation.id, context);
        if (!target) throw new Error('Internal delivery conversation is unavailable');
        let receipt = await storage.storage.submissionByRequest(target.id, requestId, context);
        // A failed native run can strand queued inputs. Never withdraw from a surviving run.
        if (receipt?.status === 'queued' && !(await harness.snapshot(LiveDoc, target.id, context))?.run) {
          await harness.abortSubmission(receipt.id, context);
          receipt = await storage.storage.submissionByRequest(target.id, requestId, context);
        }
        if (receipt?.status === 'queued') return;
        if (!receipt || (receipt.status === 'unanswered' && receipt.entry === undefined)) {
          if ((await harness.snapshot(LiveDoc, target.id, context))?.run) return;
          let envelope =
            item.message.role === 'custom'
              ? await storage.storage.submissionByRequest(target.id, `${requestId}:message`, context)
              : undefined;
          if (item.message.role === 'custom' && !envelope) {
            await (
              await writable(() =>
                target.submit(
                  {
                    type: 'write',
                    requestId: `${requestId}:message`,
                    entry: {
                      kind: 'doompi.entry',
                      data: json({
                        type: 'message',
                        message: item.message,
                        timestamp: item.message.timestamp,
                        inputRequestId: requestId,
                      }),
                    },
                  },
                  context,
                ),
              )
            ).wait(context);
            envelope = await storage.storage.submissionByRequest(target.id, `${requestId}:message`, context);
          }
          if (envelope?.status === 'queued') {
            // An idle passive write places surviving queued envelope writes, without admitting input.
            await (
              await writable(() =>
                target.submit(
                  {
                    type: 'write',
                    requestId: `${requestId}:message-placement`,
                    entry: { kind: 'doompi.internal-delivery' },
                  },
                  context,
                ),
              )
            ).wait(context);
            envelope = await storage.storage.submissionByRequest(target.id, `${requestId}:message`, context);
          }
          const envelopeId = envelope && 'entry' in envelope ? envelope.entry : undefined;
          const draft: Parameters<Conversation['submit']>[0] = {
            type: 'write',
            requestId: `${requestId}:context`,
            entry: {
              kind: 'doompi.entry',
              data: json(
                item.message.role === 'custom'
                  ? { type: 'custom', customType: 'doompi.internal-context', data: { inputRequestId: requestId } }
                  : { type: 'message', message: item.message },
              ),
              ...(envelopeId === undefined
                ? { model: convertToLlm([item.message]) }
                : {
                    edits: [{ target: envelopeId, action: 'replace' as const, messages: convertToLlm([item.message]) }],
                  }),
            },
          };
          let fallback;
          try {
            fallback = await writable(() => target.submit(draft, context));
          } catch (error) {
            const accepted = await storage.storage.submissionByRequest(target.id, `${requestId}:context`, context);
            fallback = accepted && (await harness.submission(accepted.id, context));
            if (!fallback) throw error;
          }
          if ((await fallback.wait(context)).status !== 'done') throw new Error('Internal context write failed');
        }
        await changeRecord((r) => {
          delete r.internalDeliveries?.[requestId];
        });
      })().finally(() => {
        reconcilingInternal.delete(requestId);
      });
      reconcilingInternal.set(requestId, work);
      return work;
    };
    const reconcile = async () => {
      const record = await readRecord();
      // Withdraw all stranded internal inputs before any passive write can flush an idle native inbox.
      for (const [requestId, item] of Object.entries(record.internalDeliveries ?? {})) {
        if (admittingInternal.has(requestId)) continue;
        if ((await harness.snapshot(LiveDoc, item.conversationId as typeof conversation.id, context))?.run) continue;
        const receipt = await storage.storage.submissionByRequest(
          item.conversationId as typeof conversation.id,
          requestId,
          context,
        );
        if (receipt?.status === 'queued') await harness.abortSubmission(receipt.id, context);
      }
      for (const [requestId, item] of Object.entries(record.internalDeliveries ?? {}))
        await reconcileInternal(requestId, item);
      for (const item of record.queue) {
        if (item.disposition !== 'handoff' && item.disposition !== 'uncertain') continue;
        const submission = item.submissionId
          ? await harness.submission(item.submissionId as SubmissionId, context)
          : undefined;
        const status = await submission?.status(context);
        if (status?.status === 'done' || status?.status === 'placed' || status?.status === 'unanswered')
          await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === item.id);
            if (!q) return;
            if (status.status === 'unanswered' && status.entry === undefined && r.paused) {
              q.disposition = 'pending';
              q.attempt = (q.attempt ?? 0) + 1;
              delete q.submissionId;
            } else {
              q.disposition = 'consumed';
              q.text = '';
              delete q.message;
              delete q.images;
            }
            const receipts = r.queue.filter((q) => q.disposition === 'consumed' || q.disposition === 'removed');
            if (receipts.length > 128) {
              const expired = new Set(receipts.slice(0, receipts.length - 128).map((q) => q.id));
              r.queue = r.queue.filter((q) => !expired.has(q.id));
            }
          });
        else if (!status && !handingOff.has(item.id) && !userClaims.has(item.id))
          await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === item.id);
            if (q) q.disposition = 'uncertain';
          });
      }
    };
    const handingOff = new Set<string>();
    const userClaims = new Set<string>();
    let drainPromise: Promise<void> | undefined;
    let drainRequested = false;
    const drain = (): Promise<void> => {
      if (drainPromise) {
        drainRequested = true;
        return drainPromise;
      }
      return (drainPromise ??= (async () => {
        await reconcile();
        while (!disposed) {
          const record = await readRecord();
          if (userAdmission || record.paused || (await execution())) break;
          const item = record.queue.find((q) => q.disposition === 'pending');
          if (!item) break;
          const submission = await handoff(item, 'reject');
          if (!submission) continue;
          await submission.wait(context);
          await eventsSettled;
          await reconcile();
          await publish();
        }
      })().finally(() => {
        drainPromise = undefined;
        if (drainRequested) {
          drainRequested = false;
          void drain().catch((error) => emit({ type: 'error', code: 'drain', error: String(error) }));
        }
      }));
    };
    const handoff = async (
      item: Retained,
      mode: NonNullable<Retained['submissionMode']>,
      recovering = false,
      allowPaused = false,
    ) => {
      if (handingOff.has(item.id)) return undefined;
      handingOff.add(item.id);
      try {
        const claimed = await changeRecord((r) => {
          const q = r.queue.find((q) => q.id === item.id);
          if (!q || (r.paused && !recovering && !allowPaused)) return undefined;
          if (recovering ? q.disposition !== 'handoff' || q.submissionId !== undefined : q.disposition !== 'pending')
            return undefined;
          q.disposition = 'handoff';
          q.conversationId = conversation.id;
          q.submissionMode = mode;
          if (item.operationId !== undefined) {
            q.delivery = item.delivery;
            q.operationId = item.operationId;
          }
          return q;
        });
        if (!claimed) return undefined;
        const content = input(claimed.message ?? claimed.text, claimed.images);
        const requestId = `${claimed.id}:${claimed.attempt ?? 0}`;
        const submit = () =>
          writable(() =>
            conversation.submit(
              mode === 'write'
                ? {
                    type: 'write',
                    requestId,
                    entry: { kind: 'doompi.message', model: [{ role: 'user', content, timestamp: Date.now() }] },
                  }
                : { type: 'input', content, whenBusy: mode, requestId },
              context,
            ),
          );
        let submission;
        try {
          submission = await submit();
        } catch (error) {
          const accepted = await storage.storage.submissionByRequest(conversation.id, requestId, context);
          if (!accepted) throw error;
          submission = await harness.submission(accepted.id, context);
          if (!submission) throw error;
        }
        await changeRecord((r) => {
          const q = r.queue.find((q) => q.id === item.id);
          if (q) q.submissionId = submission.id;
        });
        await reconcile();
        await publish();
        return submission;
      } finally {
        handingOff.delete(item.id);
      }
    };
    const input = (message: string | AgentMessage, images?: ImageContent[]) => {
      if (typeof message !== 'string') {
        if (message.role !== 'user') throw new Error('Only user messages can admit an agent run');
        return message.content;
      }
      return images?.length ? [{ type: 'text' as const, text: message }, ...images] : message;
    };
    const enqueue = async (
      message: string | AgentMessage,
      images: ImageContent[] | undefined,
      delivery: Retained['delivery'],
      scheduling: Retained['scheduling'],
      explicitQueue = false,
    ) => {
      const id = randomUUID();
      await changeRecord((r) => {
        r.queue.push({
          id,
          text: text(message),
          ...(images ? { images } : {}),
          ...(typeof message === 'string' ? {} : { message }),
          delivery,
          scheduling,
          explicitQueue,
          disposition: 'pending',
        });
      });
      await publish();
      return { id };
    };
    const queued = async (
      message: string | AgentMessage,
      images: ImageContent[] | undefined,
      delivery: 'followUp' | 'nextRun',
    ) => {
      guardUserAdmission();
      await enqueue(message, images, delivery, 'automatic');
      void drain().catch((error) => emit({ type: 'error', error: String(error) }));
    };
    const dispatchCommand = async (value: string) => options.dispatchCommand?.(value) ?? false;
    const admit = async (message: string | AgentMessage, images?: ImageContent[], mode?: 'steer' | 'followUp') => {
      guardUserAdmission();
      if (external) throw new Error('An operation is already running');
      if (typeof message === 'string' && (await dispatchCommand(message)))
        return { settled: Promise.resolve(), handledCommand: true };
      const record = await readRecord();
      await flushNextTurn();
      const { id } = await enqueue(message, images, mode ?? 'nextRun', 'automatic');
      const submission = await handoff(
        (await readRecord()).queue.find((q) => q.id === id)!,
        mode ?? 'reject',
        false,
        record.paused,
      );
      if (!submission) return { settled: Promise.resolve() };
      let resolveDelivery!: () => void;
      const delivered = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
      });
      internalDelivery.set(submission.id, { done: delivered, resolve: resolveDelivery });
      if (deliveredInputs.has(submission.id)) resolveDelivery();
      const settled = (async () => {
        try {
          const status = await submission.wait(context);
          // A durable receipt can finish before the watcher has queued run_end.
          // Wait for this input's settlement hooks, not the current event tail.
          if (status.status === 'done' || status.entry !== undefined) await delivered;
          await eventsSettled;
          await reconcile();
          await publish();
          if (status.status === 'unanswered' && status.reason !== 'aborted')
            throw new Error(`Agent submission failed: ${status.reason}`);
          await drain();
        } finally {
          internalDelivery.delete(submission.id);
        }
      })();
      void settled.catch((error) => emit({ type: 'error', error: String(error) }));
      return { settled };
    };
    const abort = async (operationId?: string) => {
      const current = await execution();
      if (!current || current.id === 'settling' || (operationId && current.id !== operationId)) return;
      if (current.id === external) {
        externalAbort?.abort();
        return;
      }
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const taskId = live?.run?.taskId ?? nativeId(current.id);
      await changeRecord((r) => {
        r.paused = true;
        r.abortOperationId = current.id;
        r.abortTaskId = taskId;
      });
      await publish();
      await writable(async () => {
        if (current.kind === 'run') await conversation.abort(context);
        else await harness.abortTask(taskId, context);
      });
      await reconcile();
    };
    const interrupt = async () => {
      await abort();
      await writable(() => conversation.abort(context));
      await eventsSettled;
    };
    // Host-owned admission uses only public Tx operations. Target validation and both
    // lifecycle/native ownership move on the same Session mutation line.
    const admitSelected = async (selection: { id: string; operationId?: string }, replay = false) =>
      writable(() =>
        harness.commit(async (tx: Tx) => {
          const doc = await tx.doc(LifecycleDoc);
          const record = JSON.parse(doc.json) as LifecycleRecord;
          const q = record.queue.find((q) => q.id === selection.id);
          if (!q || q.explicitQueue !== true) return 'not_found' as const;
          const requestId = `${q.id}:${q.attempt ?? 0}`;
          // An accepted request survives completion/replacement and a lost acknowledgement.
          const accepted = await tx.submissionByRequest(conversation.id, requestId);
          if (accepted && accepted.type !== 'input')
            throw new Error(`Request ${requestId} already identifies a submission of type ${accepted.type}`);
          if (accepted && replay) return accepted.id;
          if (q.disposition === 'removed' || q.disposition === 'consumed') return 'not_found' as const;
          if (accepted || q.disposition !== 'pending') return 'in_flight' as const;
          const live = await tx.doc(LiveDoc, conversation.id);
          const task = live.run ? await tx.task(live.run.taskId) : undefined;
          if (
            (live.run ? String(live.run.inputs[0]) : undefined) !== selection.operationId ||
            task?.abortRequested ||
            (live.run && record.abortOperationId === selection.operationId)
          )
            return 'target_changed' as const;
          if (!live.run) {
            let page = await tx.scanTasks(
              { conversationId: conversation.id, kind: CompactionTask.definition.name, background: false },
              128,
            );
            while (true) {
              if (page.items.some((task) => task.state.status !== 'terminal')) return 'target_changed' as const;
              if (!page.next) break;
              page = await tx.scanTasks(
                { conversationId: conversation.id, kind: CompactionTask.definition.name, background: false },
                128,
                page.next,
              );
            }
          }
          const content = input(q.message ?? q.text, q.images);
          const inbox = await tx.doc(InboxDoc, conversation.id);
          // Native final boundaries read the active head before any table writes.
          let head = live.run ? undefined : (await tx.latestHeadMarker(conversation.id))?.head;
          const now = Date.now();
          let id: SubmissionId;
          if (!live.run && inbox.items.length === 0) {
            const entry = await tx.appendEntry(UserEntry, conversation.id, {
              model: [{ role: 'user', content, timestamp: now }],
            });
            id = (
              await tx.createSubmission({
                conversationId: conversation.id,
                requestId,
                type: 'input',
                status: 'placed',
                entry: entry.id,
              })
            ).id;
            live.run = {
              taskId: await tx.createTask(
                GenerationTask,
                {},
                { ownership: { kind: 'conversation' }, conversationId: conversation.id },
              ),
              inputs: [id],
            };
          } else {
            id = (
              await tx.createSubmission({ conversationId: conversation.id, requestId, type: 'input', status: 'queued' })
            ).id;
            inbox.items.push({ id, mode: 'steer', content: json(content) as typeof content });
            if (!live.run) {
              // Preserve native write-first placement, stale heads, queue modes and
              // positional input order rather than restarting just the selected input.
              const writes = inbox.items.flatMap((item, index) => (item.mode === 'write' ? [index] : []));
              const pick = (mode: 'steer' | 'followUp') => {
                const indexes = inbox.items.flatMap((item, index) => (item.mode === mode ? [index] : []));
                const queueMode = mode === 'steer' ? settings.steeringMode : settings.followUpMode;
                return queueMode === 'all' ? indexes : indexes.slice(0, 1);
              };
              const users = [...pick('steer'), ...pick('followUp')].sort((a, b) => a - b);
              for (const index of writes) {
                const item = inbox.items[index]!;
                if (item.mode !== 'write') continue;
                // Public InboxDoc represents native write drafts as JsonObject.
                const draft = item.entry as unknown as Extract<
                  Parameters<Conversation['submit']>[0],
                  { type: 'write' }
                >['entry'];
                if (typeof draft.head === 'number' && head !== undefined && draft.head < head) {
                  tx.settleSubmission(item.id, { status: 'unanswered', reason: 'stale' });
                  continue;
                }
                const entry = await tx.appendEntry(conversation.id, draft);
                if (draft.head !== undefined) head = draft.head === 'self' ? entry.id : draft.head;
                tx.placeSubmission(item.id, entry.id);
              }
              const inputs: SubmissionId[] = [];
              for (const index of users) {
                const item = inbox.items[index]!;
                if (item.mode === 'write') continue;
                const entry = await tx.appendEntry(UserEntry, conversation.id, {
                  model: [{ role: 'user', content: item.content, timestamp: now }],
                });
                tx.placeSubmission(item.id, entry.id);
                inputs.push(item.id);
              }
              for (const index of [...writes, ...users].sort((a, b) => b - a)) inbox.items.splice(index, 1);
              if (inputs.length)
                live.run = {
                  taskId: await tx.createTask(
                    GenerationTask,
                    {},
                    { ownership: { kind: 'conversation' }, conversationId: conversation.id },
                  ),
                  inputs,
                };
            }
          }
          q.disposition = 'handoff';
          q.conversationId = conversation.id;
          q.submissionMode = 'steer';
          q.submissionId = id;
          record.revision++;
          doc.json = JSON.stringify(record);
          return id;
        }, context),
      );
    const submitUserPrompt = async (
      message: string | Extract<AgentMessage, { role: 'user' }>,
      images?: ImageContent[],
      selection?: { id: string; operationId?: string },
      submissionMode: 'reject' | 'steer' = 'reject',
    ): Promise<{
      settled: Promise<void>;
      handledCommand?: boolean;
      queueOutcome?: 'not_found' | 'in_flight' | 'target_changed';
    }> => {
      guardUserAdmission();
      if (external) throw new Error('An operation is already running');
      if (!selection && (typeof message === 'string' ? !message && !images?.length : !message.content.length))
        throw new Error('User input must contain text or an image');
      if (!selection && typeof message === 'string' && (await dispatchCommand(message)))
        return { settled: Promise.resolve(), handledCommand: true };
      guardUserAdmission();
      userAdmission = true;
      userAdmissionSettled = new Promise<void>((resolve) => {
        releaseUserAdmission = resolve;
      });
      let claimed: Retained | undefined;
      try {
        if (selection && submissionMode === 'steer') {
          let admitted;
          try {
            admitted = await admitSelected(selection);
          } catch (error) {
            // Re-enter the line to find an accepted request before rechecking its target.
            const accepted = await storage.storage.submissionByRequest(
              conversation.id,
              `${selection.id}:${(await readRecord()).queue.find((q) => q.id === selection.id)?.attempt ?? 0}`,
              context,
            );
            if (!accepted) throw error;
            admitted = await admitSelected(selection, true);
          }
          if (typeof admitted === 'string') return { settled: Promise.resolve(), queueOutcome: admitted };
          const submission = await harness.submission(admitted, context);
          if (!submission) throw new Error('Accepted promotion submission is missing');
          const settled = (async () => {
            const status = await submission.wait(context);
            await eventsSettled;
            await reconcile();
            await publish();
            if (status.status === 'unanswered' && status.reason !== 'aborted')
              throw new Error(`Agent submission failed: ${status.reason}`);
            await drain();
          })();
          void settled.catch((error) => emit({ type: 'error', code: 'user_prompt', error: String(error) }));
          await reconcile();
          await publish();
          return { settled };
        }
        const current = await execution();
        if (selection) {
          const outcome = await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === selection.id);
            if (!q || q.explicitQueue !== true || q.disposition === 'removed' || q.disposition === 'consumed')
              return 'not_found' as const;
            if (q.disposition !== 'pending') return 'in_flight' as const;
            if (current?.id !== selection.operationId || current?.status === 'aborting')
              return 'target_changed' as const;
            if (q.message && q.message.role !== 'user') throw new Error('Only user input can interrupt and respond');
            userClaims.add(q.id);
            if (submissionMode === 'reject') r.paused = true;
            q.disposition = 'handoff';
            q.conversationId = conversation.id;
            q.submissionMode = submissionMode;
            return { ...q };
          });
          if (typeof outcome === 'string') return { settled: Promise.resolve(), queueOutcome: outcome };
          claimed = outcome;
        }
        if (submissionMode === 'reject') {
          if (current) await abort(current.id);
          await conversation.waitForIdle(context);
          await eventsSettled;
        }
        if (!selection) await flushNextTurn();
        if (!claimed) {
          const { id } = await enqueue(
            message,
            images,
            submissionMode === 'steer' ? 'steer' : 'nextRun',
            submissionMode === 'steer' ? 'automatic' : 'held',
          );
          claimed = await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === id);
            if (!q || q.disposition !== 'pending') throw new Error('User input was removed before admission');
            q.disposition = 'handoff';
            q.conversationId = conversation.id;
            q.submissionMode = submissionMode;
            return { ...q };
          });
        }
        const submission = await handoff(claimed, submissionMode, true);
        if (!submission) throw new Error('User admission ownership changed');
        const settled = (async () => {
          const status = await submission.wait(context);
          await eventsSettled;
          await reconcile();
          await publish();
          if (status.status === 'unanswered' && status.reason !== 'aborted')
            throw new Error(`Agent submission failed: ${status.reason}`);
          await drain();
        })();
        void settled.catch((error) => emit({ type: 'error', code: 'user_prompt', error: String(error) }));
        await publish();
        return { settled };
      } finally {
        if (claimed) userClaims.delete(claimed.id);
        if (selection) userClaims.delete(selection.id);
        userAdmission = false;
        releaseUserAdmission?.();
        releaseUserAdmission = undefined;
      }
    };
    const recover = async () => {
      const r = await readRecord();
      if (r.abortOperationId) {
        const task =
          r.abortTaskId === undefined
            ? undefined
            : await harness.getTask(r.abortTaskId as Parameters<typeof harness.getTask>[0], context);
        if (task && task.state.status !== 'terminal') await conversation.abort(context);
      }
      for (const item of r.queue.filter((q) => q.disposition === 'handoff' && !q.submissionId)) {
        // requestId deduplicates the crash window between native admission and product receipt.
        if (item.conversationId !== conversation.id) {
          await changeRecord((record) => {
            const q = record.queue.find((q) => q.id === item.id);
            if (q) q.disposition = 'uncertain';
          });
          continue;
        }
        await handoff(item, item.submissionMode ?? (item.delivery === 'steer' ? 'steer' : 'followUp'), true);
      }
      await reconcile();
      await changeRecord(() => undefined);
    };
    const runExternalOperation = async <T>(work: () => Promise<T>): Promise<T> => {
      guardUserAdmission();
      if (await execution()) throw new Error('An operation is already running');
      external = randomUUID();
      externalAbort = new AbortController();
      try {
        await publish();
        return await writable(work);
      } finally {
        external = undefined;
        externalAbort = undefined;
        await publish();
        void drain().catch((error) => emit({ type: 'error', error: String(error) }));
      }
    };
    const appendEntry = async (entry: Parameters<Conversation['submit']>[0] & { type: 'write' }) => {
      const submission = await writable(() => conversation.submit(entry, context));
      const receipt = await submission.wait(context);
      if (receipt.status !== 'done') throw new Error(`Entry write failed: ${receipt.reason}`);
      return String(receipt.entry);
    };
    const readEntries = async () => {
      const entries = await projectDurableConversationEntries(conversation, context);
      return { entries, leafId: entries.at(-1)?.id ?? null };
    };
    const getSessionStats = async () => {
      const { entries } = await readEntries();
      const messages = entries.flatMap((e) => (e.type === 'message' ? [e.message] : []));
      const agent = await conversation.agent(context);
      const selected = agent.model ? models.getModel(agent.model.provider, agent.model.modelId) : undefined;
      const contextUsage = contextUsageOf(contextTokensOf(latestAssistantUsage(entries)), selected?.contextWindow);
      const usage = await harness.usage(context);
      const all = [...Object.values(usage.models), ...Object.values(usage.tools)];
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      let cost = 0;
      for (const u of all) {
        tokens.input += u.input;
        tokens.output += u.output;
        tokens.cacheRead += u.cacheRead;
        tokens.cacheWrite += u.cacheWrite;
        tokens.total += u.totalTokens;
        cost += u.cost.total;
      }
      return {
        sessionId,
        sessionFile: storage.sessionFile,
        ...(contextUsage === undefined ? {} : { contextUsage }),
        messageCount: messages.length,
        totalMessages: messages.length,
        userMessages: messages.filter((m) => m.role === 'user').length,
        assistantMessages: messages.filter((m) => m.role === 'assistant').length,
        toolCalls: messages.flatMap((m) =>
          m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall') : [],
        ).length,
        toolResults: messages.filter((m) => m.role === 'toolResult').length,
        tokens,
        cost,
        totalCost: cost,
        usage: {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cacheRead,
          cacheWrite: tokens.cacheWrite,
          totalTokens: tokens.total,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
      };
    };
    let disposePromise: Promise<void> | undefined;
    const dispose = () =>
      (disposePromise ??= (async () => {
        const failures: unknown[] = [];
        const attempt = async (cleanup: () => Promise<unknown>) => {
          try {
            await cleanup();
            return true;
          } catch (error) {
            failures.push(error);
            return false;
          }
        };
        await attempt(interrupt);
        disposed = true;
        await attempt(() => watcher.stop());
        await attempt(() => eventsSettled);
        const harnessClosed = await attempt(() => harness.close(context));
        const repositoryClosed = harnessClosed && (await attempt(async () => storage.repository?.close(context)));
        await attempt(() => environment.cleanup(context));
        if (harnessClosed && repositoryClosed) await attempt(async () => storage.historyLease?.release());
        resolveExited(failures.length ? 1 : 0);
        if (failures.length) throw new AggregateError(failures, 'Direct harness cleanup failed');
      })());
    const recordUsage: DirectHarnessRuntime<TContext>['recordUsage'] = async (usage, usageOptions) => {
      const entryId = await appendEntry({
        type: 'write',
        entry: { kind: 'doompi.usage', data: json({ usage, ...usageOptions }) },
      });
      await writable(() =>
        harness.commit(async (tx) => {
          const ledger = await tx.doc(UsageDoc, conversation.id);
          const key = 'doompi/auxiliary';
          const previous = ledger.models[key];
          ledger.models[key] = previous
            ? {
                ...usage,
                input: previous.input + usage.input,
                output: previous.output + usage.output,
                cacheRead: previous.cacheRead + usage.cacheRead,
                cacheWrite: previous.cacheWrite + usage.cacheWrite,
                totalTokens: previous.totalTokens + usage.totalTokens,
                cost: {
                  input: previous.cost.input + usage.cost.input,
                  output: previous.cost.output + usage.cost.output,
                  cacheRead: previous.cost.cacheRead + usage.cost.cacheRead,
                  cacheWrite: previous.cost.cacheWrite + usage.cost.cacheWrite,
                  total: previous.cost.total + usage.cost.total,
                },
              }
            : usage;
        }, context),
      );
      return entryId;
    };
    const removeQueued: DirectHarnessRuntime<TContext>['removeQueued'] = async (id) => {
      const item = (await readRecord()).queue.find((q) => q.id === id);
      if (!item || item.explicitQueue !== true) return 'not_found';
      if (item.disposition === 'consumed') return 'already_consumed';
      if (item.disposition === 'removed') return 'removed';
      if (item.submissionId) {
        const result = await harness.abortSubmission(item.submissionId as SubmissionId, context, conversation.id);
        if (result === 'already_placed') return 'in_flight';
        if (result === 'settled') return 'already_consumed';
      } else if (item.disposition !== 'pending') return 'in_flight';
      const result = await changeRecord((r) => {
        const q = r.queue.find((q) => q.id === id);
        if (!q || q.explicitQueue !== true) return 'not_found' as const;
        if (q.disposition === 'consumed') return 'already_consumed' as const;
        if (q.disposition === 'removed') return 'removed' as const;
        if (q.submissionId !== item.submissionId || (item.submissionId === undefined && q.disposition !== 'pending'))
          return 'in_flight' as const;
        q.disposition = 'removed';
        q.text = '';
        delete q.message;
        delete q.images;
        return 'removed' as const;
      });
      await publish();
      return result;
    };
    return {
      sessionId,
      sessionFile: storage.sessionFile,
      laneName,
      harnessId: options.harnessId ?? `${sessionId}:${laneName}`,
      session: harness,
      harness,
      get lane() {
        return conversation;
      },
      exited,
      get storageQuarantined() {
        return quarantined;
      },
      completeModel: models.complete?.bind(models),
      onPresentationFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      stop() {
        void dispose().catch((error) => emit({ type: 'error', error: String(error) }));
      },
      readEntries,
      readLifecycle,
      dispatchCommand,
      listCommands: () => [...(options.listCommands?.() ?? [])],
      async readState() {
        const lifecycle = await readLifecycle();
        const agent = await conversation.agent(context);
        const metadata = await harness.snapshot(SessionMetadataDoc, context);
        const stats = await getSessionStats();
        const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
        const retained = (await readRecord()).queue;
        const retainedSubmissions = new Set(retained.map((item) => item.submissionId));
        const nativePending =
          inbox?.items.filter((item) => item.mode !== 'write' && !retainedSubmissions.has(item.id)).length ?? 0;
        return json({
          sessionId,
          sessionFile: storage.sessionFile,
          sessionName: metadata?.name,
          model: agent.model ? { provider: agent.model.provider, id: agent.model.modelId } : undefined,
          thinkingLevel: agent.thinkingLevel,
          isStreaming: lifecycle.operation?.kind === 'run',
          isCompacting: lifecycle.operation?.kind === 'compaction',
          operationId: lifecycle.operation?.id,
          executionStatus: lifecycle.operation?.status,
          fastMode,
          queuePaused: lifecycle.paused,
          queueRevision: lifecycle.revision,
          steeringMode: settings.steeringMode ?? 'one-at-a-time',
          followUpMode: settings.followUpMode ?? 'one-at-a-time',
          autoCompactionEnabled: settings.compaction?.enabled ?? true,
          messageCount: stats.messageCount,
          pendingMessageCount:
            retained.filter((item) => item.disposition !== 'consumed' && item.disposition !== 'removed').length +
            nativePending +
            nextTurnMessages.length +
            deferredInternalCount,
        }) as Record<string, unknown>;
      },
      enqueueAutomatic: async (value, images) => {
        const result = await enqueue(value, images, 'nextRun', 'automatic', true);
        void drain().catch((error) => emit({ type: 'error', error: String(error) }));
        return result;
      },
      removeQueued,
      async promoteQueued(id, operationId) {
        const result = await submitUserPrompt('', undefined, { id, operationId }, 'steer');
        return result.queueOutcome ?? 'promoted';
      },
      async resumeQueue() {
        guardUserAdmission();
        await changeRecord((r) => {
          r.paused = false;
          delete r.abortOperationId;
          delete r.abortTaskId;
        });
        await publish();
        void drain().catch((error) => emit({ type: 'error', error: String(error) }));
      },
      recover,
      async setFastMode(enabled) {
        if (enabled) {
          const selected = (await conversation.agent(context)).model;
          const model = selected ? models.getModel(selected.provider, selected.modelId) : undefined;
          if (model?.api !== CODEX_API || model.provider !== CODEX_PROVIDER)
            throw new Error('Fast mode requires an OpenAI Codex model');
        }
        await writable(() =>
          harness.commit(async (tx) => {
            (await tx.doc(FastModeDoc)).enabled = enabled;
            await tx.appendEntry(conversation.id, {
              kind: 'doompi.fast-mode',
              data: { version: 1, enabled, sessionId },
            });
          }, context),
        );
        fastMode = enabled;
        emit({ type: 'fast_mode_changed', enabled });
      },
      async setModel(model) {
        const previous = (await conversation.agent(context)).model;
        if (!models.getModel(model.provider, model.id))
          throw new Error(`Model not found: ${model.provider}/${model.id}`);
        await writable(() =>
          conversation.configure({ model: { provider: model.provider, modelId: model.id } }, context),
        );
        await deliver(
          {
            type: 'config_update',
            property: 'model',
            value: { provider: model.provider, modelId: model.id },
            previous,
          },
          context,
        );
        emit({ type: 'model_select', model });
      },
      availableModels: () => models.getAvailable(),
      async availableThinkingLevels() {
        const agent = await conversation.agent(context);
        const model = agent.model ? models.getModel(agent.model.provider, agent.model.modelId) : undefined;
        if (!model) throw new Error('No model is selected');
        return getSupportedThinkingLevels(model);
      },
      setThinkingLevel: (level) => writable(() => conversation.configure({ thinkingLevel: level }, context)),
      async setSteeringMode(mode) {
        settings = { ...settings, steeringMode: mode };
      },
      async setFollowUpMode(mode) {
        settings = { ...settings, followUpMode: mode };
      },
      navigateTree: (targetId, navigationOptions) =>
        runExternalOperation(async () => {
          try {
            const expected = conversation.id;
            if (
              targetId !== null &&
              !(await storage.storage.entry(conversation.id, nativeId<EntryId>(targetId), context))
            )
              throw new Error('Navigation target is not in the selected conversation');
            const oldTip = (await readEntries()).leafId;
            await deliver({ type: 'navigation_start' }, context);
            emit({ type: 'navigation_start', targetId });
            let summary = navigationOptions?.summary;
            if (navigationOptions?.summarize === true && summary === undefined) {
              const selected = (await conversation.agent(context)).model;
              const model = selected ? models.getModel(selected.provider, selected.modelId) : undefined;
              if (!model) throw new Error('No model is selected for navigation summary');
              const instructions = navigationOptions.customInstructions;
              if (instructions !== undefined && typeof instructions !== 'string')
                throw new Error('Navigation instructions must be a string');
              const base =
                'Summarize this conversation for continuing work on another branch. Include decisions, progress, remaining work, and essential context. Return only the summary.';
              const messages: Message[] = [
                {
                  role: 'system',
                  content:
                    navigationOptions.replaceInstructions === true
                      ? (instructions ?? base)
                      : [base, instructions].filter(Boolean).join('\n\n'),
                  timestamp: Date.now(),
                },
                {
                  role: 'user',
                  content: JSON.stringify((await conversation.context(context)).messages),
                  timestamp: Date.now(),
                },
              ];
              await options.beforeModelRequest?.({ phase: 'request', model, prompt: messages, resources }, context);
              const summaryContext = withAbortSignal(externalAbort!.signal, context);
              let answer: AssistantMessage;
              try {
                answer = await awaitWithContext(
                  models.complete(model, { messages }, { signal: externalAbort!.signal }),
                  summaryContext,
                );
              } catch (error) {
                if (externalAbort?.signal.aborted) {
                  await deliver(
                    { type: 'navigation_end', status: 'aborted', tipId: oldTip, fromTipId: oldTip },
                    context,
                  );
                  emit({ type: 'navigation_end', status: 'aborted' });
                  return { cancelled: true, entries: (await readEntries()).entries };
                }
                throw error;
              }
              if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
                throw new Error(answer.errorMessage ?? 'Navigation summary failed');
              summary = text(answer).trim();
              await recordUsage(answer.usage, { details: { purpose: 'branch_summary' } });
            }
            if (externalAbort?.signal.aborted) {
              await deliver({ type: 'navigation_end', status: 'aborted', tipId: oldTip, fromTipId: oldTip }, context);
              emit({ type: 'navigation_end', status: 'aborted' });
              return { cancelled: true, entries: (await readEntries()).entries };
            }
            if (summary !== undefined && typeof summary !== 'string')
              throw new Error('Navigation summary must be a string');
            const id = await navigateDurableConversation(
              harness,
              expected,
              targetId === null ? null : nativeId<EntryId>(targetId),
              context,
              typeof summary === 'string'
                ? {
                    summary: {
                      kind: 'doompi.entry',
                      data: {
                        type: 'branch_summary',
                        summary,
                        fromId: targetId,
                        fromHook: navigationOptions?.summarize !== true,
                      },
                      model: [
                        {
                          role: 'user',
                          content: `<branch_summary>\n${summary}\n</branch_summary>`,
                          timestamp: Date.now(),
                        },
                      ],
                    },
                  }
                : undefined,
            );
            const agent = await conversation.agent(context);
            conversation = (await harness.conversation(id, context))!;
            if (targetId === null)
              await conversation.configure(
                {
                  model: agent.model,
                  thinkingLevel: agent.thinkingLevel,
                  cwd: agent.cwd,
                  tools: tools.filter((t) => activeNames.has(t.name)).map(nativeTool),
                  instructions: agent.instructions,
                },
                context,
              );
            await attach();
            const result = await readEntries();
            if (typeof navigationOptions?.label === 'string' && targetId !== null)
              await harness.commit(async (tx) => {
                (await tx.doc(LabelsDoc)).labels[targetId] = navigationOptions.label as string;
              }, context);
            for (const entry of result.entries)
              if (entry.type === 'branch_summary') await deliver({ type: 'entry_added', entry }, context);
            const event: HarnessEvent = {
              type: 'navigation_end',
              status: 'completed',
              tipId: result.leafId,
              fromTipId: oldTip,
            };
            await deliver(event, context);
            emit({ ...event });
            return { cancelled: false, entries: result.entries };
          } catch (error) {
            await deliver(
              {
                type: 'navigation_end',
                status: 'failed',
                tipId: null,
                fromTipId: null,
                error: error instanceof Error ? error : new Error(String(error)),
              },
              context,
            );
            emit({ type: 'navigation_end', status: 'failed', error: String(error) });
            throw error;
          }
        }),
      async clearQueue() {
        const selected = (await readRecord()).queue.filter(
          (item) => item.explicitQueue === true && item.disposition !== 'consumed' && item.disposition !== 'removed',
        );
        for (const item of selected) await removeQueued(item.id);
        await publish();
        return { steering: [], followUp: [] };
      },
      setName: (name) =>
        writable(() =>
          harness.commit(async (tx) => {
            (await tx.doc(SessionMetadataDoc)).name = name;
          }, context),
        ),
      getSessionStats,
      async replaceTools(replacement) {
        tools = replacement;
        activeNames = new Set(tools.map((t) => t.name));
        install();
        await writable(() => conversation.configure({ tools: tools.map(nativeTool) }, context));
      },
      async replaceResources(replacement) {
        resources = replacement;
        install();
      },
      async readResources() {
        return resources;
      },
      runExternalOperation,
      appendCustomEntry: async (customType, data) =>
        String(
          (
            await writable(() =>
              conversation.commit(
                (tx) =>
                  tx.appendEntry(conversation.id, {
                    kind: customType,
                    ...(data === undefined ? {} : { data: json(data) }),
                    ...(options.entryProjectors?.[customType]
                      ? {
                          model: convertToLlm(
                            options.entryProjectors[customType]({
                              type: 'custom',
                              id: '',
                              parentId: null,
                              timestamp: Date.now(),
                              seq: 0,
                              customType,
                              ...(data === undefined ? {} : { data: json(data) }),
                            }),
                          ),
                        }
                      : {}),
                  }),
                context,
              ),
            )
          ).id,
        ),
      appendMessage: (message) =>
        appendEntry({
          type: 'write',
          entry: {
            kind: 'doompi.entry',
            data: json({ type: 'message', message, timestamp: message.timestamp }),
            model: convertToLlm([message]),
          },
        }),
      setLabel: (targetId, label) =>
        writable(() =>
          harness.commit(async (tx) => {
            const labels = (await tx.doc(LabelsDoc)).labels;
            if (label === undefined) delete labels[targetId];
            else labels[targetId] = label;
          }, context),
        ),
      recordUsage,
      submitPrompt: admit,
      submitUserPrompt,
      prompt: async (value, images) => {
        await (
          await admit(value, images)
        ).settled;
      },
      admitMessage: (message) => admit(message),
      submitInternalMessage: async function submitInternalMessage(
        message,
        delivery = 'steer',
        requestId = randomUUID(),
      ) {
        if (typeof message !== 'string' && message.role !== 'user' && message.role !== 'custom')
          throw new Error('Internal input must be user or custom message content');
        if (delivery === 'nextTurn') {
          nextTurnMessages.push(
            typeof message === 'string' ? { role: 'user', content: message, timestamp: Date.now() } : message,
          );
          return { settled: Promise.resolve() };
        }
        const preserved: AgentMessage =
          typeof message === 'string' ? { role: 'user', content: message, timestamp: Date.now() } : message;
        const deliveryRecord: InternalDeliveryRecord = { message: preserved, conversationId: conversation.id };
        if (userAdmission) {
          deferredInternalCount++;
          admittingInternal.add(requestId);
          try {
            await changeRecord((r) => {
              (r.internalDeliveries ??= {})[requestId] = deliveryRecord;
            });
          } catch (error) {
            deferredInternalCount--;
            admittingInternal.delete(requestId);
            throw error;
          }
          const released = userAdmissionSettled;
          const settled = released.then(async () => {
            deferredInternalCount--;
            admittingInternal.delete(requestId);
            await (
              await submitInternalMessage(preserved, delivery, requestId)
            ).settled;
          });
          void settled.catch((error) => emit({ type: 'error', code: 'internal_message', error: String(error) }));
          return { settled };
        }
        if (external) throw new Error('An operation is already running');
        const content = typeof message === 'string' ? message : message.content;
        const submit = async (draft: Parameters<Conversation['submit']>[0] & { requestId: string }) => {
          try {
            return await writable(() => conversation.submit(draft, context));
          } catch (error) {
            const accepted = await storage.storage.submissionByRequest(conversation.id, draft.requestId, context);
            const submission = accepted && (await harness.submission(accepted.id, context));
            if (!submission) throw error;
            return submission;
          }
        };
        admittingInternal.add(requestId);
        // Preserve custom presentation metadata without adding its content twice to model context.
        let envelope: Awaited<ReturnType<Conversation['submit']>> | undefined;
        let submission: Awaited<ReturnType<Conversation['submit']>>;
        try {
          await changeRecord((r) => {
            (r.internalDeliveries ??= {})[requestId] = deliveryRecord;
          });
          envelope =
            typeof message !== 'string' && message.role === 'custom'
              ? await submit({
                  type: 'write',
                  requestId: `${requestId}:message`,
                  entry: {
                    kind: 'doompi.entry',
                    data: json({ type: 'message', message, timestamp: message.timestamp, inputRequestId: requestId }),
                  },
                })
              : undefined;
          submission = await submit({ type: 'input', content, whenBusy: delivery, requestId });
          await changeRecord((r) => {
            const item = r.internalDeliveries?.[requestId];
            if (item) item.submissionId = submission.id;
          });
        } finally {
          admittingInternal.delete(requestId);
        }
        let resolveDelivery!: () => void;
        const delivered = new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        });
        internalDelivery.set(submission.id, { done: delivered, resolve: resolveDelivery });
        if (deliveredInputs.has(submission.id)) resolveDelivery();
        const settled = (async () => {
          try {
            const status = await submission.wait(context);
            if (status.status === 'unanswered' && status.entry === undefined) {
              await conversation.waitForIdle(context);
              await reconcileInternal(requestId, deliveryRecord);
            }
            if (envelope && (await envelope.wait(context)).status !== 'done')
              throw new Error('Internal message journal write failed');
            if (status.status === 'done' || status.entry !== undefined) await delivered;
            await eventsSettled;
            await reconcileInternal(requestId, deliveryRecord);
          } finally {
            internalDelivery.delete(submission.id);
          }
        })();
        void settled.catch((error) => emit({ type: 'error', code: 'internal_message', error: String(error) }));
        return { settled };
      },
      steer: async (message, images) => {
        if (typeof message !== 'string' && message.role !== 'user')
          throw new Error('Only user messages can steer an agent run');
        await submitUserPrompt(message, images, undefined, 'steer');
      },
      followUp: (message, images) => queued(message, images, 'followUp'),
      nextRun: (message, images) => queued(message, images, 'nextRun'),
      abort,
      interrupt,
      async compact(instructions) {
        guardUserAdmission();
        if (await execution()) throw new Error('An operation is already running');
        const previous = settings;
        settings = { ...settings, compaction: { ...settings.compaction, keepRecentTokens: 0 } };
        try {
          const task = await writable(() => conversation.compact(instructions, context));
          const receipt = await harness.waitForTask(task, context);
          await eventsSettled;
          if (['failed', 'faulted', 'orphaned'].includes(receipt.state.outcome.status))
            throw new Error('Compaction failed');
        } finally {
          settings = previous;
        }
      },
      async admitResume() {
        await recover();
        const resumed = !!(await execution());
        harness.resume();
        const settled = (async () => {
          await conversation.waitForIdle(context);
          await eventsSettled;
          await drain();
        })();
        void settled.catch((error) => emit({ type: 'error', code: 'resume', error: String(error) }));
        return { resumed, settled };
      },
      async resume() {
        await recover();
        const resumed = !!(await execution());
        harness.resume();
        if (resumed) {
          await conversation.waitForIdle(context);
          await eventsSettled;
        }
        void drain().catch((error) => emit({ type: 'error', error: String(error) }));
        return resumed;
      },
      dispose,
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (startupHarness) await startupHarness.close(context);
      else await storage.storage.close(context);
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length === 1) {
      try {
        await storage.repository?.close(context);
        await storage.historyLease?.release();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Direct harness startup and cleanup failed');
    throw error;
  }
}
export type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from '../types/server/directHarnessRuntime';
