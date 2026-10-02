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
  AgentDoc,
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
  attempt?: number;
  submissionMode?: 'steer' | 'followUp' | 'reject' | 'write';
} & { submissionId?: number; conversationId?: number; message?: AgentMessage; operationId?: string };
type LifecycleRecord = {
  revision: number;
  paused: boolean;
  abortOperationId?: string;
  abortTaskId?: number;
  queue: Retained[];
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
  await runtime.prompt(prompt);
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
                const patch = await options.transformContext?.(
                  { messages: request.messages.filter((m) => m.role !== 'system'), systemPrompt },
                  ctx,
                );
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
              item.disposition !== 'consumed' && item.disposition !== 'removed',
          )
          .map(({ submissionId: _s, conversationId: _c, message: _m, operationId: _o, attempt: _a, ...item }) => item),
        operation: await execution(),
      };
    };
    const publish = async () => emit({ type: 'lifecycle_update', lifecycle: await readLifecycle() });
    let watcher: AgentEventStream;
    let eventsSettled = Promise.resolve();
    let settling = 0;
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
      watcher.start(async (events, eventContext) => {
        for (const event of events) {
          let mapped: HarnessEvent | undefined;
          if (['run_start', 'run_end', 'turn_start', 'compaction_start'].includes(event.type))
            mapped = { type: event.type } as HarnessEvent;
          if (event.type === 'message_start') {
            if (event.message.role === 'assistant') partial = structuredClone(event.message);
            mapped = { type: 'message_start', message: event.message };
          }
          if (event.type === 'message_end' && event.entry.model?.[0]) {
            const message = event.entry.model[0];
            if (message.role === 'assistant') lastAssistant = message;
            if (message.role === 'toolResult') toolResults.push(message);
            mapped = { type: 'message_end', message, entryId: String(event.entry.id), runId: String(conversation.id) };
          }
          if (event.type === 'entry_appended')
            mapped = { type: 'entry_added', entry: projectDurableEntries([event.entry])[0] };
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
          }
          if (event.type === 'message_update' && partial) {
            for (const change of event.changes) {
              if (change.type === 'message') {
                partial = structuredClone(change.message);
                continue;
              }
              if ('block' in change) {
                partial.content[change.contentIndex] = structuredClone(change.block);
                continue;
              }
              const block = partial.content[change.contentIndex];
              if (change.type === 'text_delta' && block?.type === 'text') block.text += change.delta;
              if (change.type === 'thinking_delta' && block?.type === 'thinking') block.thinking += change.delta;
              if (
                change.type === 'text_delta' ||
                change.type === 'thinking_delta' ||
                change.type === 'toolcall_delta'
              ) {
                const update: HarnessEvent = {
                  type: 'message_update',
                  message: structuredClone(partial),
                  event: {
                    type: change.type,
                    contentIndex: change.contentIndex,
                    delta: change.delta,
                    partial: structuredClone(partial),
                  },
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
          if (event.type === 'compaction_end')
            mapped = {
              type: 'compaction_end',
              status: 'completed',
              reason: event.reason,
              entryId: (await readEntries()).entries.findLast((e) => e.type === 'compaction')?.id ?? '',
              error: new Error('Compaction failed'),
            };
          if (event.type === 'inbox_update')
            mapped = { type: 'queue_update', queues: event.items.map((item) => ({ kind: item.mode })) };
          if (event.type === 'entry_appended') {
            for (const message of event.entry.model ?? [])
              if (message.role === 'assistant')
                eventsSettled = eventsSettled.then(() =>
                  deliver({ type: 'usage', row: { id: String(event.entry.id), usage: message.usage } }, eventContext),
                );
          }
          if (!mapped) continue;
          emit({
            ...mapped,
            type:
              mapped.type === 'tool_start'
                ? 'tool_execution_start'
                : mapped.type === 'tool_update'
                  ? 'tool_execution_update'
                  : mapped.type === 'tool_end'
                    ? 'tool_execution_end'
                    : mapped.type === 'entry_added'
                      ? 'entry_appended'
                      : mapped.type,
          });
          if (mapped.type === 'run_start') emit({ type: 'agent_start' });
          if (mapped.type === 'run_end') {
            settling++;
            eventsSettled = eventsSettled
              .then(async () => {
                await reconcile();
                try {
                  await writable(() =>
                    harness.commit(
                      (tx) =>
                        tx.appendEntry(conversation.id, {
                          kind: AGENT_SETTLED_ENTRY_TYPE,
                          data: {
                            timestamp: Date.now(),
                            runId: String(event.type === 'run_end' ? event.inputs[0] : conversation.id),
                          },
                        }),
                      eventContext,
                    ),
                  );
                } catch (error) {
                  emit({ type: 'error', code: 'agent_settled', error: String(error) });
                }
                await deliver(mapped!, eventContext);
                emit({ type: 'agent_end' });
                emit({ type: 'agent_settled', timestamp: Date.now() });
              })
              .catch((error) => emit({ type: 'error', code: 'settled_event', error: String(error) }))
              .finally(() => {
                settling--;
              });
          } else eventsSettled = eventsSettled.then(() => deliver(mapped!, eventContext));
        }
      });
    };
    await attach();
    const reconcile = async () => {
      const record = await readRecord();
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
    const drain = (): Promise<void> =>
      (drainPromise ??= (async () => {
        await reconcile();
        while (!disposed) {
          const record = await readRecord();
          if (userAdmission || record.paused || (await execution())) break;
          const item = record.queue.find((q) => q.disposition === 'pending' && q.scheduling === 'automatic');
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
      }));
    const handoff = async (item: Retained, mode: NonNullable<Retained['submissionMode']>, recovering = false) => {
      if (handingOff.has(item.id)) return undefined;
      handingOff.add(item.id);
      try {
        const claimed = await changeRecord((r) => {
          const q = r.queue.find((q) => q.id === item.id);
          if (!q || (r.paused && !recovering)) return undefined;
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
          disposition: 'pending',
        });
      });
      await publish();
      return { id };
    };
    const queued = async (
      message: string | AgentMessage,
      images: ImageContent[] | undefined,
      delivery: 'steer' | 'followUp' | 'nextRun',
    ) => {
      guardUserAdmission();
      const { id } = await enqueue(message, images, delivery, delivery === 'steer' ? 'automatic' : 'held');
      if (delivery !== 'nextRun' && (await execution()))
        await handoff(
          (await readRecord()).queue.find((q) => q.id === id)!,
          delivery,
        );
      else if (delivery === 'steer') void drain().catch((error) => emit({ type: 'error', error: String(error) }));
    };
    const dispatchCommand = async (value: string) => options.dispatchCommand?.(value) ?? false;
    const admit = async (message: string | AgentMessage, images?: ImageContent[], mode?: 'steer' | 'followUp') => {
      guardUserAdmission();
      if (external) throw new Error('An operation is already running');
      if (typeof message === 'string' && (await dispatchCommand(message)))
        return { settled: Promise.resolve(), handledCommand: true };
      const record = await readRecord();
      if (record.paused) {
        if (record.queue.some((q) => q.disposition !== 'consumed' && q.disposition !== 'removed'))
          throw new Error('The queue is paused');
        await changeRecord((r) => {
          r.paused = false;
          delete r.abortOperationId;
          delete r.abortTaskId;
        });
      }
      if (!(await execution()))
        for (const held of (await readRecord()).queue.filter(
          (q) => q.disposition === 'pending' && q.scheduling === 'held',
        )) {
          await handoff(held, 'write');
        }
      const { id } = await enqueue(message, images, mode ?? 'nextRun', 'automatic');
      const submission = await handoff(
        (await readRecord()).queue.find((q) => q.id === id)!,
        mode ?? 'reject',
      );
      if (!submission) return { settled: Promise.resolve() };
      const settled = (async () => {
        const status = await submission.wait(context);
        await eventsSettled;
        await reconcile();
        await publish();
        if (status.status === 'unanswered' && !['aborted', 'withdrawn'].includes(status.reason))
          throw new Error(`Agent submission failed: ${status.reason}`);
        await drain();
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
    const submitUserPrompt = async (
      message: string | Extract<AgentMessage, { role: 'user' }>,
      images?: ImageContent[],
      selection?: { id: string; operationId?: string },
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
      let claimed: Retained | undefined;
      try {
        const current = await execution();
        if (selection) {
          const outcome = await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === selection.id);
            if (!q || q.disposition === 'removed' || q.disposition === 'consumed') return 'not_found' as const;
            if (q.disposition !== 'pending') return 'in_flight' as const;
            if (current?.id !== selection.operationId || current?.status === 'aborting')
              return 'target_changed' as const;
            if (q.message && q.message.role !== 'user') throw new Error('Only user input can interrupt and respond');
            userClaims.add(q.id);
            r.paused = true;
            q.disposition = 'handoff';
            q.conversationId = conversation.id;
            q.submissionMode = 'reject';
            return { ...q };
          });
          if (typeof outcome === 'string') return { settled: Promise.resolve(), queueOutcome: outcome };
          claimed = outcome;
        }
        if (current) await abort(current.id);
        await conversation.waitForIdle(context);
        await eventsSettled;
        if (!claimed) {
          const { id } = await enqueue(message, images, 'nextRun', 'held');
          claimed = await changeRecord((r) => {
            const q = r.queue.find((q) => q.id === id);
            if (!q || q.disposition !== 'pending') throw new Error('User input was removed before admission');
            q.disposition = 'handoff';
            q.conversationId = conversation.id;
            q.submissionMode = 'reject';
            return { ...q };
          });
        }
        const submission = await handoff(claimed, 'reject', true);
        if (!submission) throw new Error('User admission ownership changed');
        const settled = (async () => {
          const status = await submission.wait(context);
          await eventsSettled;
          await reconcile();
          await publish();
          if (status.status === 'unanswered' && !['aborted', 'withdrawn'].includes(status.reason))
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
        await interrupt();
        disposed = true;
        await watcher.stop();
        await eventsSettled;
        try {
          await harness.close(context);
          await storage.repository?.close(context);
          await environment.cleanup(context);
          await storage.historyLease?.release();
          resolveExited(0);
        } catch (error) {
          resolveExited(1);
          throw error;
        }
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
          pendingMessageCount: lifecycle.queue.length,
        }) as Record<string, unknown>;
      },
      enqueueAutomatic: async (value, images) => {
        const result = await enqueue(value, images, 'nextRun', 'automatic');
        void drain().catch((error) => emit({ type: 'error', error: String(error) }));
        return result;
      },
      async removeQueued(id) {
        const item = (await readRecord()).queue.find((q) => q.id === id);
        if (!item) return 'not_found';
        if (item.disposition === 'consumed') return 'already_consumed';
        if (item.disposition === 'removed') return 'removed';
        if (item.submissionId) {
          const result = await harness.abortSubmission(item.submissionId as SubmissionId, context, conversation.id);
          if (result === 'already_placed') return 'in_flight';
          if (result === 'settled') return 'already_consumed';
        } else if (item.disposition !== 'pending') return 'in_flight';
        const result = await changeRecord((r) => {
          const q = r.queue.find((q) => q.id === id);
          if (!q) return 'not_found' as const;
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
      },
      async promoteQueued(id, operationId) {
        const result = await submitUserPrompt('', undefined, { id, operationId });
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
        for (const item of (await readRecord()).queue)
          if (item.submissionId) await harness.abortSubmission(item.submissionId as SubmissionId, context);
        await changeRecord((r) => {
          r.queue = [];
        });
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
      steer: (message, images) => queued(message, images, 'steer'),
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
    try {
      await storage.repository?.close(context);
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await storage.historyLease?.release();
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Direct harness startup and cleanup failed');
    throw error;
  }
}
export type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from '../types/server/directHarnessRuntime';
