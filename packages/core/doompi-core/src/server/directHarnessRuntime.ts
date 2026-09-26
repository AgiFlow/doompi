import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AgentHarness,
  HarnessFault,
  type AgentHarnessTool,
  type AgentMessage,
  type AgentLane,
  type HarnessEvent,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/pi-agent-core/harness/context';
import {
  JSONL_STORAGE_VERSION,
  JsonlSessionRepo,
  laneState,
  pendingEntry,
  setValue,
  value,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createModels,
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Api,
  type ImageContent,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
  type Usage,
} from '@earendil-works/pi-ai';

import { createHistoryCreationFileSystem } from '../services/historyCreationFileSystem';
import { preserveHistoryBeforeOpen } from '../services/historyImport';
import type { HistoryOwnershipLease } from '../services/historyImport';
import { openSqliteSessionStorage } from '../services/sqliteSessionStorage';
import type {
  DirectHarnessEventListener,
  DirectHarnessFrame,
  DirectHarnessModel,
  DirectHarnessLifecycle,
  DirectHarnessQueuedInput,
  DirectHarnessRuntime,
  DirectHarnessRuntimeOptions,
} from '../types/server/directHarnessRuntime';

const DEFAULT_LANE = 'main';
const DEFAULT_SESSION_ROOT = '.pi/sessions';
const FRAME_ERROR = 'error';
const EVENT_TYPES: readonly HarnessEvent['type'][] = [
  'run_start',
  'run_resume',
  'run_suspend',
  'operation_abort',
  'run_end',
  'fault',
  'handler_error',
  'turn_start',
  'turn_end',
  'retry_scheduled',
  'retry_start',
  'retry_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_start',
  'tool_update',
  'tool_end',
  'entry_added',
  'queue_update',
  'value_update',
  'config_update',
  'compaction_start',
  'compaction_end',
  'navigation_start',
  'navigation_end',
  'usage',
  'lane_created',
];
const STORAGE_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'EPERM', 'EROFS']);

type AnyRecord = Record<string, unknown>;
type AnySession = Session;
type AnyModels = Models | MutableModels;

type RetainedInput = Omit<DirectHarnessQueuedInput, 'disposition'> & {
  disposition: DirectHarnessQueuedInput['disposition'] | 'consumed' | 'removed';
  message?: AgentMessage;
  operationId?: string;
  nativeEntryId?: string;
  /** A handoff is reserved before the native mutation, and reconciled on reopen. */
  attemptId?: string;
};

type LifecycleRecord = {
  version: 1;
  revision: number;
  paused: boolean;
  abortOperationId?: string;
  queue: RetainedInput[];
};

const EMPTY_LIFECYCLE: LifecycleRecord = { version: 1, revision: 0, paused: false, queue: [] };
const RETAINED_RECEIPTS = 128;

function compactLifecycle(record: LifecycleRecord): LifecycleRecord {
  let receipts = 0;
  const queue = record.queue
    .toReversed()
    .filter((item) => {
      if (item.disposition !== 'consumed' && item.disposition !== 'removed') return true;
      receipts += 1;
      return receipts <= RETAINED_RECEIPTS;
    })
    .toReversed()
    .map((item): RetainedInput =>
      item.disposition === 'consumed' || item.disposition === 'removed'
        ? { id: item.id, text: '', delivery: item.delivery, scheduling: item.scheduling, disposition: item.disposition }
        : item,
    );
  return { ...record, queue };
}

type StorageHandle = {
  session: AnySession;
  sessionFile?: string;
  repository?: { close(context: Context): Promise<void> };
  environment?: NodeExecutionEnv;
  historyLease?: HistoryOwnershipLease;
};

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Run one prompt and return only the assistant text appended by that prompt. */
export async function promptForAssistantText(runtime: DirectHarnessRuntime, text: string): Promise<string | undefined> {
  const previousEntryIds = new Set((await runtime.readEntries()).entries.map((entry) => entry.id));
  await runtime.prompt(text);
  const { entries } = await runtime.readEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || previousEntryIds.has(entry.id)) continue;
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const output = entry.message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
    return output || undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Direct harness operation failed';
}

function modelReference(model: DirectHarnessModel | undefined, models: AnyModels): Model<Api> {
  if (model !== undefined && 'api' in model) return model;
  const requested = model;
  const resolved = requested === undefined ? models.getModels()[0] : models.getModel(requested.provider, requested.id);
  if (resolved === undefined) {
    const identity = requested === undefined ? 'the first configured model' : `${requested.provider}/${requested.id}`;
    throw new Error(`Direct harness could not resolve ${identity}`);
  }
  return resolved;
}

export function readDirectHarnessSessionMetadata(filePath: string): JsonlSessionMetadata {
  const absolute = fs.realpathSync(filePath);
  const firstLine = fs.readFileSync(absolute, 'utf8').split('\n', 1)[0];
  let header: AnyRecord;
  try {
    const parsed: unknown = JSON.parse(firstLine ?? '');
    if (!isRecord(parsed)) throw new Error('header is not an object');
    header = parsed;
  } catch (error) {
    throw new Error(`Invalid JSONL session header: ${absolute}`, { cause: error });
  }
  if (header.kind !== 'header' || header.v !== 4)
    throw new Error(`Session is not an upstream v4 JSONL file: ${absolute}`);
  const id = stringValue(header.id);
  const cwd = stringValue(header.cwd);
  const createdAt = header.createdAt;
  if (!id || !cwd || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new Error(`Invalid JSONL session identity: ${absolute}`);
  }
  const stat = fs.statSync(absolute);
  return {
    id,
    createdAt,
    storageVersion: typeof header.storageVersion === 'number' ? header.storageVersion : JSONL_STORAGE_VERSION,
    cwd,
    path: absolute,
    modifiedAt: stat.mtimeMs,
    ...(typeof header.parentSessionId === 'string' ? { parentSessionId: header.parentSessionId } : {}),
    ...(typeof header.legacyParentSessionPath === 'string'
      ? { legacyParentSessionPath: header.legacyParentSessionPath }
      : {}),
  };
}

function isV3File(filePath: string): boolean {
  let firstLine: string;
  try {
    firstLine = fs.readFileSync(path.resolve(filePath), 'utf8').split('\n', 1)[0] ?? '';
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const header: unknown = JSON.parse(firstLine);
    return isRecord(header) && header.type === 'session' && header.version === 3;
  } catch {
    return false;
  }
}

async function acquireHistoryLease(
  owner: NonNullable<DirectHarnessRuntimeOptions['historyOwnership']>,
  filePath: string,
): Promise<HistoryOwnershipLease> {
  const lease = await owner.acquire(filePath);
  try {
    await lease.assertQuiescent();
    return lease;
  } catch (error) {
    await Promise.resolve(lease.release()).catch(() => undefined);
    throw error;
  }
}

async function closeStorage(
  storage: {
    session?: AnySession;
    repository?: { close(context: Context): Promise<void> };
    environment?: NodeExecutionEnv;
    historyLease?: HistoryOwnershipLease;
  },
  context: Context,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await storage.session?.close(context);
  } catch (error) {
    failures.push(error);
  }
  try {
    await storage.repository?.close(context);
  } catch (error) {
    failures.push(error);
  }
  try {
    await storage.environment?.cleanup(context);
  } catch (error) {
    failures.push(error);
  }
  try {
    await storage.historyLease?.release();
  } catch (error) {
    failures.push(error);
  }
  storage.historyLease = undefined;
  if (failures.length) throw new AggregateError(failures, 'Direct harness storage cleanup failed');
}

async function openStorage<TContext extends object | undefined>(
  options: DirectHarnessRuntimeOptions<TContext>,
  context: Context,
): Promise<StorageHandle> {
  if (options.session !== undefined)
    return {
      session: options.session,
      ...(options.sessionPath === undefined ? {} : { sessionFile: path.resolve(options.sessionPath) }),
    };

  if (options.storage === 'sqlite') return openSqliteSessionStorage(options, context);

  const sessionPath = options.sessionPath === undefined ? undefined : path.resolve(options.sessionPath);
  const legacyPath = options.legacySessionPath === undefined ? sessionPath : path.resolve(options.legacySessionPath);
  let importedPath = sessionPath;
  if (legacyPath !== undefined && isV3File(legacyPath)) {
    throw new Error(
      'Legacy v3 history cannot be opened for writing. Stop Pi, run doompi history-import <v3-source> <v4-destination> --confirm-offline, then open the v4 destination.',
    );
  }

  const environment = new NodeExecutionEnv({ cwd: options.cwd });
  const sessionsRoot = path.resolve(
    options.sessionsRoot ??
      (importedPath === undefined ? path.join(options.cwd, DEFAULT_SESSION_ROOT) : path.dirname(importedPath)),
  );
  let metadata: JsonlSessionMetadata | undefined;
  if (importedPath === undefined && options.sessionId !== undefined) {
    const discovery = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot, now: () => Date.now() });
    try {
      metadata = (await discovery.list({ cwd: options.cwd }, context)).find(
        (candidate) => candidate.id === options.sessionId,
      );
      importedPath = metadata?.path;
    } finally {
      await discovery.close(context);
    }
  }

  let historyLease: HistoryOwnershipLease | undefined;
  let session: AnySession | undefined;
  const fileSystem =
    importedPath === undefined
      ? createHistoryCreationFileSystem(environment, async (destinationPath) => {
          const owner = options.historyOwnership;
          if (owner === undefined) throw new Error('Creating a writable session requires explicit HistoryOwnership');
          historyLease = await acquireHistoryLease(owner, destinationPath);
        })
      : environment;
  const repository = new JsonlSessionRepo({ fileSystem, sessionsRoot, now: () => Date.now() });
  try {
    if (importedPath !== undefined) {
      const owner = options.historyOwnership;
      if (owner === undefined) throw new Error('Opening an existing session requires explicit HistoryOwnership');
      historyLease = await acquireHistoryLease(owner, importedPath);
      metadata ??= readDirectHarnessSessionMetadata(importedPath);
      if (options.sessionId !== undefined && options.sessionId !== metadata.id) {
        throw new Error(`Session id mismatch: expected ${options.sessionId}, found ${metadata.id}`);
      }
      await preserveHistoryBeforeOpen(metadata.path, historyLease);
      session = await repository.open(metadata, context);
    } else {
      const owner = options.historyOwnership;
      if (owner === undefined) throw new Error('Creating a writable session requires explicit HistoryOwnership');
      const created = await repository.create(
        {
          id: options.sessionId,
          cwd: options.cwd,
          ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
        },
        context,
      );
      session = created;
      importedPath = created.metadata.path;
      if (historyLease === undefined) throw new Error('New history was not admitted before publication');
    }
    return { session, sessionFile: importedPath, repository, environment, historyLease };
  } catch (error) {
    await closeStorage({ session, repository, environment, historyLease }, context);
    throw error;
  }
}

/**
 * Merge caller-supplied providers into the registry the harness will use.
 * A pi-ai MutableModels exposes setProvider; a Pi ModelRuntime exposes
 * registerNativeProvider instead, and dropping providers for the latter would
 * silently hide every extension-registered provider from the child harness.
 */
function mergeProviders(models: AnyModels, providers: readonly Provider[]): void {
  const mutable = models as Partial<MutableModels> & {
    registerNativeProvider?: (provider: Provider) => void;
  };
  const register =
    typeof mutable.setProvider === 'function'
      ? mutable.setProvider.bind(models)
      : typeof mutable.registerNativeProvider === 'function'
        ? mutable.registerNativeProvider.bind(models)
        : undefined;
  if (register === undefined)
    throw new Error('Direct harness cannot register providers on the supplied Models registry');
  for (const provider of providers) register(provider);
}

function configureModels<TContext extends object | undefined>(
  options: DirectHarnessRuntimeOptions<TContext>,
): AnyModels {
  if (options.models !== undefined) {
    if (options.providers !== undefined && options.providers.length > 0)
      mergeProviders(options.models, options.providers);
    return options.models;
  }
  if (options.providers === undefined || options.providers.length === 0) {
    throw new Error('Direct harness requires a public Models registry or at least one Provider');
  }
  const models =
    options.credentials === undefined ? createModels() : createModels({ credentials: options.credentials });
  for (const provider of options.providers) models.setProvider(provider);
  return models;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .filter((part) => part.type === 'text')
    .map((part) => stringValue(part.text) ?? '')
    .join('');
}

function queueText(item: unknown): string | undefined {
  if (!isRecord(item) || item.type !== 'message' || !isRecord(item.message)) return undefined;
  return textContent(item.message.content);
}

function mapQueueUpdate(event: AnyRecord): DirectHarnessFrame {
  const queues = Array.isArray(event.queues) ? event.queues : [];
  const steering: string[] = [];
  const followUp: string[] = [];
  for (const item of queues) {
    if (!isRecord(item)) continue;
    const text = queueText(item);
    if (text === undefined) continue;
    if (item.kind === 'steer') steering.push(text);
    else if (item.kind === 'followUp' || item.kind === 'nextRun') followUp.push(text);
  }
  return { type: 'queue_update', queues, steering, followUp };
}

function stateModel(model: unknown): { provider: string; id: string } | undefined {
  if (!isRecord(model)) return undefined;
  const provider = stringValue(model.provider);
  const id = stringValue(model.id) ?? stringValue(model.modelId);
  return provider && id ? { provider, id } : undefined;
}

function mapHarnessEvent(event: HarnessEvent): DirectHarnessFrame[] {
  const value = event as unknown as AnyRecord;
  switch (event.type) {
    case 'run_start':
      return [{ type: 'agent_start', runId: value.runId, startedAt: value.startedAt }];
    case 'run_resume':
      return [{ type: 'agent_start', runId: value.runId, resumed: true }];
    case 'run_suspend':
      return [{ type: 'run_suspend', runId: value.runId, reason: value.reason, deferred: value.deferred }];
    case 'operation_abort':
      return [
        { type: 'operation_abort', operationId: value.operationId, steer: value.steer, followUp: value.followUp },
      ];
    case 'run_end':
      return [
        {
          type: 'agent_end',
          runId: value.runId,
          status: value.status,
          ...(value.error === undefined ? {} : { error: value.error }),
        },
        { type: 'agent_settled', runId: value.runId, timestamp: value.endedAt },
      ];
    case 'fault':
      return [{ type: FRAME_ERROR, error: value.message, code: value.code }];
    case 'handler_error':
      return [
        {
          type: 'handler_error',
          kind: value.kind,
          hook: value.hook,
          event: value.event,
          error: value.error,
          stack: value.stack,
        },
      ];
    case 'turn_start':
      return [{ type: 'turn_start', runId: value.runId, turnId: value.turnId }];
    case 'turn_end':
      return [
        {
          type: 'turn_end',
          runId: value.runId,
          turnId: value.turnId,
          message: value.message,
          toolResults: value.toolResults,
        },
      ];
    case 'retry_scheduled':
      return [
        {
          type: 'auto_retry_start',
          runId: value.runId,
          attempt: value.attempt,
          maxAttempts: value.maxAttempts,
          error: value.errorMessage,
        },
      ];
    case 'retry_start':
      return [{ type: 'auto_retry_start', runId: value.runId, attempt: value.attempt }];
    case 'retry_end':
      return [
        {
          type: 'auto_retry_end',
          runId: value.runId,
          attempt: value.attempt,
          success: value.success,
          error: value.finalError,
        },
      ];
    case 'message_start':
      return [{ type: 'message_start', runId: value.runId, message: value.message }];
    case 'message_update':
      return [
        {
          type: 'message_update',
          runId: value.runId,
          message: value.message,
          assistantMessageEvent: value.event,
          ...(value.frame === undefined ? {} : { assistantMessageFrame: value.frame }),
        },
      ];
    case 'message_end':
      return [{ type: 'message_end', runId: value.runId, message: value.message, entryId: value.entryId }];
    case 'tool_start':
      return [
        {
          type: 'tool_execution_start',
          runId: value.runId,
          turnId: value.turnId,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          args: value.args,
        },
      ];
    case 'tool_update':
      return [
        {
          type: 'tool_execution_update',
          runId: value.runId,
          turnId: value.turnId,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          partialResult: value.partialResult,
        },
      ];
    case 'tool_end':
      return [
        {
          type: 'tool_execution_end',
          runId: value.runId,
          turnId: value.turnId,
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          result: value.result,
          isError: value.isError,
          terminate: value.terminate,
        },
      ];
    case 'entry_added':
      return [{ type: 'entry_appended', entry: value.entry }];
    case 'queue_update':
      return [mapQueueUpdate(value)];
    case 'value_update':
      if (value.value === 'session_name') return [{ type: 'session_info_changed', name: value.name }];
      return [{ type: 'entry_label_changed', targetId: value.targetId, label: value.label }];
    case 'config_update':
      if (value.property === 'thinkingLevel') return [{ type: 'thinking_level_changed', level: value.value }];
      if (value.property === 'model') {
        const model = stateModel(value.value);
        return model === undefined
          ? []
          : [
              {
                type: 'response',
                command: 'get_state',
                success: true,
                data: { model },
              },
            ];
      }
      return [{ type: 'config_update', property: value.property, value: value.value, previous: value.previous }];
    case 'compaction_start':
      return [{ type: 'compaction_start', runId: value.runId, reason: value.reason }];
    case 'compaction_end':
      return [
        {
          type: 'compaction_end',
          runId: value.runId,
          reason: value.reason,
          status: value.status,
          entryId: value.entryId,
        },
      ];
    case 'navigation_start':
      return [{ type: 'navigation_start', runId: value.runId, targetId: value.targetId }];
    case 'navigation_end':
      return [{ type: 'navigation_end', runId: value.runId, status: value.status }];
    case 'usage':
      return [{ type: 'usage', lane: value.lane, row: value.row, totals: value.totals }];
    case 'lane_created':
      return [{ type: 'lane_created', at: value.at }];
  }
}

function isStorageFailure(error: unknown): boolean {
  if (error instanceof HarnessFault) return true;
  if (isRecord(error) && typeof error.code === 'string' && STORAGE_ERROR_CODES.has(error.code)) return true;
  return /(?:storage|session|jsonl|journal|commit|mutation).*(?:fail|error|fault|write|invariant)|(?:fail|error|fault|write|invariant).*(?:storage|session|jsonl|journal|commit|mutation)/iu.test(
    errorMessage(error),
  );
}

function resultError(value: unknown): never {
  if (isRecord(value) && value.ok === false) throw value.error;
  throw value;
}

async function entriesForLane(
  lane: AgentLane,
  context: Context,
): Promise<Awaited<ReturnType<AgentLane['findEntries']>>> {
  return lane.findEntries({ order: 'oldestFirst' }, context);
}

/**
 * Creates a same-process AgentHarness and the legacy framed compatibility
 * facade expected by doompi-server. No child process, RPC launcher, or Pi UI
 * runtime is created.
 */
export async function createDirectHarnessRuntime<TContext extends object | undefined = object | undefined>(
  options: DirectHarnessRuntimeOptions<TContext>,
): Promise<DirectHarnessRuntime<TContext>> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const laneName = options.lane ?? DEFAULT_LANE;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let storageQuarantined = false;
  let requestPreparationFailure: { error: unknown } | undefined;
  let turnPreparationFailure: { error: unknown } | undefined;
  let contextPreparationFailure: { error: unknown } | undefined;
  let payloadPreparationFailure: { error: unknown } | undefined;
  let toolsReady = true;
  let activeToolNames = new Set(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? []);
  const storage = await openStorage(options, context);
  let models: AnyModels;
  let harnessResult: Awaited<ReturnType<typeof AgentHarness.create<TContext>>>;
  try {
    const registry = configureModels(options);
    const dispatchMethods = new Set<PropertyKey>([
      'stream',
      'complete',
      'streamSimple',
      'completeSimple',
      'streamDeferred',
      'fetchDeferred',
    ]);
    models = new Proxy(registry, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (!dispatchMethods.has(key)) return value.bind(target);
        return (...args: unknown[]) => {
          try {
            if (disposed || storageQuarantined || !toolsReady)
              throw new Error('Direct harness model dispatch is blocked');
            if (key !== 'streamDeferred' && key !== 'fetchDeferred') {
              const request = args[1] as { tools?: readonly { name: string }[] };
              if (request.tools?.some((tool) => !activeToolNames.has(tool.name))) {
                throw new Error('Model request contains a tool disabled after generation preparation');
              }
            }
            if (contextPreparationFailure !== undefined) throw contextPreparationFailure.error;
            if (turnPreparationFailure !== undefined) throw turnPreparationFailure.error;
            if (requestPreparationFailure !== undefined) throw requestPreparationFailure.error;
            options.guardModelRequest?.();
          } catch {
            // Models reports admission/auth failures as responses, not throws that fault the harness.
            const model = args[0] as Model<Api>;
            const blocked: AssistantMessage = {
              role: 'assistant',
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason: 'error',
              errorMessage: 'Model request blocked: headless capability preparation is not ready.',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
            if (key === 'complete' || key === 'completeSimple' || key === 'fetchDeferred') {
              return Promise.resolve(blocked);
            }
            const stream = createAssistantMessageEventStream();
            stream.push({ type: 'error', reason: 'error', error: blocked });
            return stream;
          }
          const requestOptions = args[2];
          if (isRecord(requestOptions) && typeof requestOptions.onPayload === 'function') {
            const onPayload = requestOptions.onPayload as (payload: unknown, model: Model<Api>) => Promise<unknown>;
            args[2] = {
              ...requestOptions,
              onPayload: async (payload: unknown, requestModel: Model<Api>) => {
                payloadPreparationFailure = undefined;
                const transformed = await onPayload(payload, requestModel);
                const failure = payloadPreparationFailure as { error: unknown } | undefined;
                if (failure !== undefined) throw failure.error;
                return transformed;
              },
            };
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    harnessResult = await AgentHarness.create<TContext>(
      {
        session: storage.session,
        models,
        model: modelReference(options.model, models),
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
        ...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ...(options.resources === undefined ? {} : { resources: options.resources }),
        ...(options.toolContext === undefined ? {} : { toolContext: options.toolContext }),
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(options.streamOptions === undefined ? {} : { streamOptions: options.streamOptions }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
        ...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
        ...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
        ...(options.toolExecution === undefined ? {} : { toolExecution: options.toolExecution }),
        ...(options.toProviderMessages === undefined ? {} : { toProviderMessages: options.toProviderMessages }),
        ...(options.entryProjectors === undefined ? {} : { entryProjectors: options.entryProjectors }),
      },
      context,
    );
  } catch (error) {
    await closeStorage(storage, context);
    throw error;
  }
  const harness = harnessResult.harness;
  const sessionId = storage.session.metadata.id;
  const harnessId = options.harnessId ?? `${sessionId}:${laneName}`;
  const listeners = new Set<(frame: DirectHarnessFrame) => void>();
  const lifecycleListeners = new Set<DirectHarnessEventListener>();
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  let exitResolved = false;
  let lane: AgentLane;

  const emitFrame = (frame: DirectHarnessFrame): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(frame);
      } catch {
        // Compatibility listeners are observers. One broken client must not fault the engine.
      }
    }
  };
  const emitLifecycle = async (event: HarnessEvent, eventContext: Context): Promise<void> => {
    await Promise.all(
      [...lifecycleListeners].map(async (listener) => {
        try {
          await listener(event, eventContext);
        } catch (error) {
          emitFrame({ type: 'handler_error', kind: 'event', event: event.type, error: errorMessage(error) });
        }
      }),
    );
  };
  let settledEvents = Promise.resolve();
  let toolsThisRun = 0;
  const deliverHarnessEvent = async (event: HarnessEvent, eventContext: Context): Promise<void> => {
    if (event.type === 'run_start') toolsThisRun = 0;
    if (event.type === 'tool_start') toolsThisRun += 1;
    if (event.type === 'run_end' && options.storage === 'sqlite') {
      const record = event as unknown as AnyRecord;
      const latest = await lane.findEntry(
        { type: 'custom', customType: 'doompi.agent-settled', order: 'newestFirst' },
        eventContext,
      );
      const data = latest?.type === 'custom' && isRecord(latest.data) ? latest.data : undefined;
      if (data?.runId !== record.runId)
        await lane.appendCustomEntry(
          'doompi.agent-settled',
          { runId: String(record.runId), timestamp: Number(record.endedAt), tools: toolsThisRun },
          eventContext,
        );
    }
    await emitLifecycle(event, eventContext);
    if (event.type === 'fault') markStorageFailure(event);
    for (const frame of mapHarnessEvent(event)) emitFrame(frame);
    if (
      ['run_start', 'run_end', 'operation_abort', 'queue_update', 'compaction_start', 'compaction_end'].includes(
        event.type,
      )
    )
      void (event.type === 'queue_update' ? reconcileNativeQueue() : publishLifecycle()).catch((error: unknown) =>
        emitFrame({ type: FRAME_ERROR, code: 'lifecycle_projection', error: errorMessage(error) }),
      );
  };
  const handleHarnessEvent = async (event: HarnessEvent, eventContext: Context): Promise<void> => {
    if (event.type === 'run_end') {
      // The native drive still owns the lane while emitting run_end. Release its
      // callback before settled hooks write history, then drain before acknowledging drive.
      settledEvents = settledEvents.then(() => deliverHarnessEvent(event, eventContext));
      return;
    }
    await deliverHarnessEvent(event, eventContext);
  };
  const unsubscribe = EVENT_TYPES.map((type) => harness.events.on(type, handleHarnessEvent as never));

  const guardLive = (): void => {
    if (disposed) throw new Error('The direct harness runtime is disposed');
  };
  const guardWritable = (): void => {
    guardLive();
    if (storageQuarantined) throw new Error('Direct harness writes are quarantined after a storage failure');
  };
  const markStorageFailure = (error: unknown): void => {
    if (!isStorageFailure(error)) return;
    storageQuarantined = true;
    emitFrame({ type: FRAME_ERROR, code: 'storage_quarantined', error: errorMessage(error) });
  };
  const writable = async <T>(operation: () => Promise<T>): Promise<T> => {
    guardWritable();
    try {
      await storage.historyLease?.assertQuiescent();
      return await operation();
    } catch (error) {
      markStorageFailure(error);
      throw error;
    }
  };

  // DoomPi owns the product queue and cancellation policy. Pi's inbox is an execution
  // handoff, not a second editable copy of the product queue.
  const lifecycleAddress = value<LifecycleRecord>('doompi.server.lifecycle', laneName);
  const readRecord = async (): Promise<LifecycleRecord> => {
    const stored = await storage.session.getValue(lifecycleAddress, context);
    if (stored !== undefined && stored.value.version !== 1) throw new Error('Unknown server lifecycle format');
    return stored?.value ?? EMPTY_LIFECYCLE;
  };
  const changeRecord = async <T>(
    change: (record: LifecycleRecord) => { record: LifecycleRecord; result: T } | { result: T },
  ): Promise<T> =>
    writable(() =>
      storage.session.mutate(async (mutator) => {
        const stored = await mutator.getValue(lifecycleAddress, context);
        const current = stored?.value ?? EMPTY_LIFECYCLE;
        if (current.version !== 1) throw new Error('Unknown server lifecycle format');
        const decision = change(current);
        if ('record' in decision) {
          await mutator.commit(
            [setValue(lifecycleAddress, compactLifecycle({ ...decision.record, revision: current.revision + 1 }))],
            context,
          );
        }
        return decision.result;
      }, context),
    );
  let settlingOperationId: string | undefined;
  let abortingOperationId: string | undefined;
  const readLifecycle = async (): Promise<DirectHarnessLifecycle> => {
    const [record, execution] = await Promise.all([readRecord(), lane.inspectExecution(context)]);
    const current = execution.current;
    return {
      revision: Math.max(record.revision, publicationRevision),
      operation:
        current === null
          ? settlingOperationId === undefined
            ? null
            : {
                id: settlingOperationId,
                kind: 'run',
                status: abortingOperationId === settlingOperationId ? 'aborting' : 'open',
              }
          : {
              id: current.id,
              kind: current.kind,
              status: current.status === 'aborting' || abortingOperationId === current.id ? 'aborting' : 'open',
            },
      paused: record.paused,
      queue: record.queue
        .filter((item) => item.disposition !== 'consumed' && item.disposition !== 'removed')
        .map(({ id, text, images, delivery, scheduling, disposition }) => ({
          id,
          text,
          ...(images === undefined ? {} : { images }),
          delivery,
          scheduling,
          disposition: disposition as DirectHarnessQueuedInput['disposition'],
        })),
    };
  };
  let publishingLifecycle = Promise.resolve();
  let publicationRevision = 0;
  const publishLifecycle = (): Promise<void> => {
    const next = publishingLifecycle.then(async () => {
      if (disposed) return;
      const lifecycle = await readLifecycle();
      publicationRevision = Math.max(publicationRevision + 1, lifecycle.revision);
      emitFrame({ type: 'lifecycle_update', lifecycle: { ...lifecycle, revision: publicationRevision } });
    });
    publishingLifecycle = next.catch((error: unknown) => {
      emitFrame({ type: FRAME_ERROR, code: 'lifecycle_projection', error: errorMessage(error) });
    }); // a failed projection must not stall later updates
    return next;
  };
  const retainedMessage = (
    id: string,
    kind: 'steer' | 'followUp' | 'nextRun',
    message: AgentMessage,
  ): RetainedInput => {
    const content = message.role === 'user' ? message.content : [];
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const text =
      message.role === 'user'
        ? parts
            .map((part) => (part.type === 'text' ? part.text : ''))
            .filter(Boolean)
            .join('\n')
        : '';
    const images = message.role === 'user' ? parts.filter((part): part is ImageContent => part.type === 'image') : [];
    return {
      id,
      text,
      ...(images.length === 0 ? {} : { images }),
      message,
      delivery: kind,
      scheduling: 'held',
      disposition: 'handoff',
      nativeEntryId: id,
    };
  };
  // Native entries from older sessions and extension/voice callers are adopted by identity,
  // never copied or enqueued a second time. Pi continues to own their actual handoff.
  const adoptNativeQueue = async (): Promise<void> => {
    const changed = await writable(() =>
      storage.session.mutate(async (mutator) => {
        const native = await mutator.getValue(laneState(laneName), context);
        const original = await mutator.getValue(lifecycleAddress, context);
        const current = original?.value ?? EMPTY_LIFECYCLE;
        const adopted: RetainedInput[] = [];
        for (const item of native?.value.inbox ?? []) {
          if (item.kind !== 'steer' && item.kind !== 'followUp' && item.kind !== 'nextRun') continue;
          if (current.queue.some((entry) => entry.nativeEntryId === item.entryId || entry.id === item.entryId))
            continue;
          const pending = await mutator.getValue(pendingEntry(item.entryId), context);
          if (pending?.value.type !== 'message')
            throw new Error(`Native queued input ${item.entryId} has no message payload`);
          adopted.push(retainedMessage(item.entryId, item.kind, pending.value.payload));
        }
        if (adopted.length === 0) return false;
        await mutator.commit(
          [
            setValue(lifecycleAddress, {
              ...current,
              revision: current.revision + 1,
              queue: [...current.queue, ...adopted],
            }),
          ],
          context,
        );
        return true;
      }, context),
    );
    if (changed) await publishLifecycle();
  };
  const reconcileNativeQueue = async (): Promise<void> => {
    if (disposed) return;
    const native = await storage.session.getValue(laneState(laneName), context);
    const remaining = new Set((native?.value.inbox ?? []).map((entry) => entry.entryId));
    const record = await readRecord();
    for (const item of record.queue.filter(
      (entry) => entry.nativeEntryId !== undefined && !remaining.has(entry.nativeEntryId),
    )) {
      if (record.abortOperationId !== undefined) continue;
      const committed = await storage.session.getEntry(item.nativeEntryId!, context);
      await changeRecord((current) => ({
        record: {
          ...current,
          queue: current.queue.map((entry) =>
            entry.id === item.id && entry.nativeEntryId === item.nativeEntryId
              ? committed !== undefined
                ? { ...entry, disposition: 'consumed' }
                : current.paused
                  ? {
                      ...entry,
                      disposition: 'pending',
                      nativeEntryId: undefined,
                      delivery: entry.delivery === 'steer' ? 'followUp' : entry.delivery,
                    }
                  : { ...entry, disposition: 'uncertain' }
              : entry,
          ),
        },
        result: undefined,
      }));
    }
    await publishLifecycle();
  };
  const unsubscribeHooks: Array<() => void> = [];
  if (options.transformContext !== undefined) {
    unsubscribeHooks.push(
      harness.hooks.on('before_run', () => {
        contextPreparationFailure = undefined;
        return undefined;
      }),
    );
  }
  if (options.beforeModelRequest !== undefined) {
    unsubscribeHooks.push(
      harness.hooks.on('before_run', async (event, hookContext) => {
        turnPreparationFailure = undefined;
        requestPreparationFailure = undefined;
        try {
          await options.beforeModelRequest?.(
            { phase: 'turn', prompt: event.prompt, resources: event.resources },
            hookContext,
          );
        } catch (error) {
          turnPreparationFailure = { error };
          throw error;
        }
        return undefined;
      }),
      harness.hooks.on('before_request', async (event, hookContext) => {
        // Upstream catches hook errors. Retain the failure for the Models admission guard.
        try {
          await options.beforeModelRequest?.(
            { phase: 'request', model: event.model, resources: await harness.getResources(hookContext) },
            hookContext,
          );
          requestPreparationFailure = undefined;
        } catch (error) {
          requestPreparationFailure = { error };
          throw error;
        }
        return undefined;
      }),
    );
  }
  if (options.transformContext !== undefined) {
    unsubscribeHooks.push(
      harness.hooks.on('transform_context', async (event, hookContext) => {
        try {
          return await options.transformContext!(event, hookContext);
        } catch (error) {
          // AgentHarness reports and continues after transform errors. Retain the failure so the
          // public Models boundary blocks provider dispatch instead of admitting untransformed context.
          contextPreparationFailure = { error };
          throw error;
        }
      }),
    );
  }
  if (options.beforePayload !== undefined) {
    unsubscribeHooks.push(
      harness.hooks.on('before_payload', async (event, hookContext) => {
        try {
          return await options.beforePayload!(event, hookContext);
        } catch (error) {
          // Upstream reports and continues after hook errors. Retain the failure so the Models payload
          // callback rejects instead of sending the original, untransformed payload.
          payloadPreparationFailure = { error };
          throw error;
        }
      }),
    );
  }
  if (options.beforeTool !== undefined) {
    unsubscribeHooks.push(harness.hooks.on('before_tool', options.beforeTool));
  }
  if (options.afterTool !== undefined) {
    unsubscribeHooks.push(harness.hooks.on('after_tool', options.afterTool));
  }
  if (options.beforeCompaction !== undefined) {
    unsubscribeHooks.push(harness.hooks.on('before_compaction', options.beforeCompaction));
  }
  try {
    lane = await harness.lane(laneName, context);
    if (options.sessionName !== undefined) await writable(() => harness.setName(options.sessionName, context));
  } catch (error) {
    for (const unsubscribeHook of unsubscribeHooks) unsubscribeHook();
    for (const unsubscribeEvent of unsubscribe) unsubscribeEvent();
    await harness.close(context).catch(() => undefined);
    await closeStorage(storage, context);
    throw error;
  }
  const settleExit = (code: number): void => {
    if (exitResolved) return;
    exitResolved = true;
    resolveExited(code);
  };

  let externalOperationActive = false;
  let agentOperationsActive = 0;
  const acquireAgentOperation = (): (() => void) => {
    if (externalOperationActive) throw new Error('The session is busy with an external tool invocation');
    agentOperationsActive += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      agentOperationsActive -= 1;
    };
  };
  const runAgentOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = acquireAgentOperation();
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const runExternalOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    guardWritable();
    if (externalOperationActive) throw new Error('The session is busy with an external tool invocation');
    if (agentOperationsActive > 0) throw new Error('The session is busy with an agent operation');
    externalOperationActive = true;
    try {
      const execution = await lane.inspectExecution(context);
      if (execution.current !== null) throw new Error('The session is busy with an agent operation');
      return await operation();
    } finally {
      externalOperationActive = false;
    }
  };

  // Serialize only admission/cancellation decisions, never the turn's provider/tool work.
  // The Session mutation line alone cannot cover the native accept and DoomPi pause commits.
  let admissionLine = Promise.resolve();
  const serializeAdmission = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = admissionLine;
    let release!: () => void;
    admissionLine = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  let drainingAutomatic = false;
  let drainRequested = false;
  const drive = async (operationId: string): Promise<void> => {
    settlingOperationId = operationId;
    try {
      const result = await writable(() => lane.drive({ operationId, waitForRetry: true }, context));
      if (!result.ok) resultError(result);
      if (result.value.kind === 'waiting' && result.value.reason === 'retry') {
        throw new Error(`Direct harness returned an unexpected retry wait for ${operationId}`);
      }
    } finally {
      await settledEvents;
      if (settlingOperationId === operationId) settlingOperationId = undefined;
      if (abortingOperationId === operationId) abortingOperationId = undefined;
      if (!disposed) {
        await publishLifecycle();
        void drainAutomatic().catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
        );
      }
    }
  };
  // Only this function starts automatic follow-up turns. It never holds the Session mutation
  // line during provider/tool work; a claim is persisted before native admission.
  const drainAutomatic = async (): Promise<void> => {
    if (disposed) return;
    if (drainingAutomatic) {
      drainRequested = true;
      return;
    }
    drainingAutomatic = true;
    try {
      while (!disposed) {
        const execution = await lane.inspectExecution(context);
        if (execution.current !== null) return;
        const operationId = randomUUID();
        const claimed = await changeRecord((record) => {
          if (record.paused || record.abortOperationId !== undefined) return { result: undefined };
          const item = record.queue.find(
            (candidate) =>
              candidate.disposition === 'pending' &&
              candidate.scheduling === 'automatic' &&
              candidate.delivery !== 'steer',
          );
          if (!item) return { result: undefined };
          return {
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === item.id
                  ? { ...entry, disposition: 'handoff', operationId, attemptId: randomUUID() }
                  : entry,
              ),
            },
            result: item,
          };
        });
        if (!claimed) return;
        await publishLifecycle();
        try {
          const message: AgentMessage = claimed.message ?? {
            role: 'user',
            content: [
              ...(claimed.text ? [{ type: 'text' as const, text: claimed.text }] : []),
              ...(claimed.images ?? []),
            ],
            timestamp: Date.now(),
          };
          const admitted = await serializeAdmission(async () => {
            if ((await readRecord()).paused) return undefined;
            return writable(() => lane.accept({ kind: 'prompt', operationId, prompt: message }, context));
          });
          if (!admitted || !admitted.ok) {
            if (admitted && admitted.error._tag !== 'LaneBusy') resultError(admitted);
            await changeRecord((record) => ({
              record: {
                ...record,
                queue: record.queue.map((entry) =>
                  entry.id === claimed.id && entry.operationId === operationId
                    ? { ...entry, disposition: 'pending', operationId: undefined, attemptId: undefined }
                    : entry,
                ),
              },
              result: undefined,
            }));
            await publishLifecycle();
            return;
          }
          await changeRecord((record) => ({
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === claimed.id && entry.operationId === operationId
                  ? { ...entry, disposition: 'consumed' }
                  : entry,
              ),
            },
            result: undefined,
          }));
          await publishLifecycle();
          await drive(operationId);
        } catch (error) {
          // An uncertain handoff is not retried: native admission may have committed before
          // an I/O or acknowledgement failure. Recovery reconciles it by operation identity.
          await changeRecord((record) => ({
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === claimed.id && entry.operationId === operationId && entry.disposition === 'handoff'
                  ? { ...entry, disposition: 'uncertain' }
                  : entry,
              ),
            },
            result: undefined,
          }));
          emitFrame({ type: FRAME_ERROR, code: 'queue_handoff', error: errorMessage(error) });
          await publishLifecycle();
        }
      }
    } finally {
      drainingAutomatic = false;
      if (drainRequested && !disposed) {
        drainRequested = false;
        void drainAutomatic().catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
        );
      }
    }
  };

  const admitPrompt = async (
    text: string | AgentMessage,
    images?: ImageContent[],
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<{ settled: Promise<void> }> => {
    const execution = await lane.inspectExecution(context);
    if (execution.current !== null && streamingBehavior !== undefined) {
      const queued =
        streamingBehavior === 'steer'
          ? await writable(() => lane.steer(text, images, context))
          : await writable(() => lane.followUp(text, images, context));
      if (!queued.ok) resultError(queued);
      await adoptNativeQueue();
      return { settled: Promise.resolve() };
    }
    // `images` belongs to the text form of the request only: a composed message already
    // carries its own content, so the two shapes are separate members of the union.
    const request =
      typeof text === 'string'
        ? ({ kind: 'prompt', prompt: text, ...(images === undefined ? {} : { images }) } as const)
        : ({ kind: 'prompt', prompt: text } as const);
    const admission = await serializeAdmission(async () => {
      const lifecycle = await readRecord();
      if (lifecycle.paused) {
        // A person starting a new turn may release an empty pause left by an aborted turn.
        // Retained inputs (including uncertain handoffs) still require an explicit resume.
        if (
          execution.current !== null ||
          settlingOperationId !== undefined ||
          lifecycle.queue.some((entry) => entry.disposition !== 'consumed' && entry.disposition !== 'removed')
        )
          throw new Error('The agent queue is paused; resume before starting a turn');
        await changeRecord((record) => {
          if (record.queue.some((entry) => entry.disposition !== 'consumed' && entry.disposition !== 'removed'))
            throw new Error('The agent queue is paused; resume before starting a turn');
          return { record: { ...record, paused: false, abortOperationId: undefined }, result: undefined };
        });
        await publishLifecycle();
      }
      // Held native follow-ups never wake an idle session. Reattach them only when a
      // person starts a new turn, preserving their enqueue-only scheduling policy.
      for (const item of (await readRecord()).queue.filter(
        (entry) => entry.disposition === 'pending' && entry.scheduling === 'held',
      )) {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.id === item.id ? { ...entry, disposition: 'handoff', attemptId: randomUUID() } : entry,
            ),
          },
          result: undefined,
        }));
        try {
          const queued = await writable(() =>
            lane.followUp(item.message ?? item.text, item.message ? undefined : item.images, context),
          );
          if (!queued.ok) resultError(queued);
          await changeRecord((record) => ({
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === item.id ? { ...entry, nativeEntryId: queued.value.entryId } : entry,
              ),
            },
            result: undefined,
          }));
        } catch (error) {
          await changeRecord((record) => ({
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === item.id ? { ...entry, disposition: 'uncertain' } : entry,
              ),
            },
            result: undefined,
          }));
          await publishLifecycle();
          throw error;
        }
      }
      return writable(() => lane.accept(request, context));
    });
    if (!admission.ok) {
      // A turn can begin between inspection and admission. Preserve the requested delivery
      // kind when the lane reports that another operation won the race.
      if (streamingBehavior !== undefined && admission.error._tag === 'LaneBusy') {
        const queued = await writable(() =>
          streamingBehavior === 'steer' ? lane.steer(text, images, context) : lane.followUp(text, images, context),
        );
        if (!queued.ok) resultError(queued);
        await adoptNativeQueue();
        return { settled: Promise.resolve() };
      }
      resultError(admission);
    }
    return { settled: drive(admission.value.operationId) };
  };

  const replaceTools = (tools: AgentHarnessTool<TContext>[]): Promise<void> =>
    runAgentOperation(async () => {
      toolsReady = false;
      await writable(async () => {
        await harness.setTools(tools, context);
        await lane.setActiveTools(
          tools.map((tool) => tool.name),
          context,
        );
        activeToolNames = new Set(tools.map((tool) => tool.name));
        toolsReady = true;
      });
    });
  const replaceResources = async (resources: Parameters<typeof harness.setResources>[0]): Promise<void> => {
    await writable(() => harness.setResources(resources, context));
  };
  const readResources = async () => {
    guardLive();
    return harness.getResources(context);
  };
  const appendCustomEntry = async (customType: string, data?: unknown): Promise<string> =>
    writable(() => lane.appendCustomEntry(customType, data as never, context));
  const appendMessage = async (message: AgentMessage): Promise<string> =>
    writable(() => lane.appendMessage(message, context));
  const setLabel = async (targetId: string, label: string | undefined): Promise<void> =>
    writable(() => harness.setLabel(targetId, label, context));
  const recordUsage = async (
    usage: Usage,
    options?: { entryId?: string; details?: import('@earendil-works/pi-agent-core').JsonValue },
  ): Promise<string> => {
    const result = await writable(() => lane.recordUsage(usage, options, context));
    if (!result.ok) resultError(result);
    return result.value.usageId;
  };
  const tryDispatchCommand = async (text: string): Promise<boolean> => (await options.dispatchCommand?.(text)) ?? false;
  const dispatchCommand = (text: string): Promise<boolean> =>
    runAgentOperation(async () => {
      guardLive();
      return tryDispatchCommand(text);
    });
  const submitPrompt = async (
    text: string,
    images?: ImageContent[],
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<{ settled: Promise<void>; handledCommand?: boolean }> => {
    const release = acquireAgentOperation();
    try {
      if (await tryDispatchCommand(text)) {
        release();
        return { settled: Promise.resolve(), handledCommand: true };
      }
      const submission = await admitPrompt(text, images, streamingBehavior);
      void submission.settled.then(release, release);
      return submission;
    } catch (error) {
      release();
      throw error;
    }
  };
  const prompt = async (text: string, images?: ImageContent[]): Promise<void> => {
    const submission = await submitPrompt(text, images);
    await submission.settled;
  };
  const admitMessage = async (message: AgentMessage): Promise<{ settled: Promise<void> }> => {
    const release = acquireAgentOperation();
    try {
      const submission = await admitPrompt(message);
      void submission.settled.then(release, release);
      return submission;
    } catch (error) {
      release();
      throw error;
    }
  };
  const enqueueAutomatic = async (text: string, images?: ImageContent[]): Promise<{ id: string }> => {
    if (!text && !images?.length) throw new Error('Queued input must contain text or an image');
    const id = randomUUID();
    await changeRecord((record) => ({
      record: {
        ...record,
        queue: [
          ...record.queue,
          {
            id,
            text,
            ...(images === undefined ? {} : { images }),
            delivery: 'followUp',
            scheduling: 'automatic',
            disposition: 'pending',
          },
        ],
      },
      result: undefined,
    }));
    await publishLifecycle();
    void drainAutomatic().catch((error: unknown) =>
      emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
    );
    return { id };
  };
  const removeQueued = async (id: string): Promise<'removed' | 'in_flight' | 'already_consumed' | 'not_found'> => {
    const native = (await readRecord()).queue.find((entry) => entry.id === id);
    if (native?.disposition === 'handoff' && native.nativeEntryId !== undefined) {
      const cancelled = await writable(() => lane.cancelQueued(native.nativeEntryId!, context));
      if (!cancelled.ok) resultError(cancelled);
      if (cancelled.value.kind === 'cancelled') {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) => (entry.id === id ? { ...entry, disposition: 'removed' } : entry)),
          },
          result: undefined,
        }));
        await publishLifecycle();
        return 'removed';
      }
      await reconcileNativeQueue();
      return cancelled.value.kind === 'already_consumed' ? 'already_consumed' : 'not_found';
    }
    const result = await changeRecord((record) => {
      const item = record.queue.find((entry) => entry.id === id);
      if (!item) return { result: 'not_found' as const };
      if (item.disposition === 'consumed') return { result: 'already_consumed' as const };
      if (item.disposition === 'removed') return { result: 'removed' as const };
      if (item.disposition !== 'pending') return { result: 'in_flight' as const };
      return {
        record: {
          ...record,
          queue: record.queue.map((entry) => (entry.id === id ? { ...entry, disposition: 'removed' } : entry)),
        },
        result: 'removed' as const,
      };
    });
    if (result === 'removed') await publishLifecycle();
    return result;
  };
  const deliverPromoted = (id: string, operationId: string): Promise<void> =>
    serializeAdmission(async () => {
      const execution = await lane.inspectExecution(context);
      if (execution.current?.id !== operationId || execution.current.status === 'aborting') {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.id === id && entry.operationId === operationId
                ? { ...entry, delivery: 'followUp', disposition: 'pending', operationId: undefined }
                : entry,
            ),
          },
          result: undefined,
        }));
        await publishLifecycle();
        void drainAutomatic().catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
        );
        return;
      }
      const item = (await readRecord()).queue.find((entry) => entry.id === id && entry.operationId === operationId);
      if (!item || item.disposition !== 'pending') return;
      const message: AgentMessage = item.message ?? {
        role: 'user',
        content: [...(item.text ? [{ type: 'text' as const, text: item.text }] : []), ...(item.images ?? [])],
        timestamp: Date.now(),
      };
      // Reserve the item before crossing the native handoff boundary. Promotion/removal
      // can no longer claim it once the native mutation may have started.
      const reserved = await changeRecord((record) => {
        const current = record.queue.find((entry) => entry.id === id && entry.operationId === operationId);
        if (!current || current.disposition !== 'pending' || record.paused) return { result: false };
        return {
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.id === id ? { ...entry, disposition: 'handoff', attemptId: randomUUID() } : entry,
            ),
          },
          result: true,
        };
      });
      if (!reserved) return;
      await publishLifecycle();
      try {
        const queued = await writable(() => lane.steer(message, undefined, context));
        if (!queued.ok) resultError(queued);
        const after = await lane.inspectExecution(context);
        if (after.current?.id !== operationId || after.current.status === 'aborting') {
          const cancelled = await writable(() => lane.cancelQueued(queued.value.entryId, context));
          if (!cancelled.ok) resultError(cancelled);
          await changeRecord((record) => ({
            record: {
              ...record,
              queue: record.queue.map((entry) =>
                entry.id === id
                  ? cancelled.value.kind === 'cancelled'
                    ? {
                        ...entry,
                        delivery: 'followUp',
                        disposition: 'pending',
                        operationId: undefined,
                        attemptId: undefined,
                      }
                    : {
                        ...entry,
                        disposition: cancelled.value.kind === 'already_consumed' ? 'consumed' : 'uncertain',
                        nativeEntryId: queued.value.entryId,
                      }
                  : entry,
              ),
            },
            result: undefined,
          }));
          await publishLifecycle();
          if (cancelled.value.kind === 'cancelled')
            void drainAutomatic().catch((error: unknown) =>
              emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
            );
          return;
        }
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.id === id ? { ...entry, nativeEntryId: queued.value.entryId } : entry,
            ),
          },
          result: undefined,
        }));
        await reconcileNativeQueue();
      } catch (error) {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.id === id && entry.disposition === 'handoff' ? { ...entry, disposition: 'uncertain' } : entry,
            ),
          },
          result: undefined,
        }));
        await publishLifecycle();
        emitFrame({ type: FRAME_ERROR, code: 'steer_handoff', error: errorMessage(error) });
      }
    });
  const promoteQueued = async (
    id: string,
    operationId: string,
  ): Promise<'promoted' | 'in_flight' | 'target_changed' | 'not_found'> => {
    const execution = await lane.inspectExecution(context);
    const result = await changeRecord((record) => {
      const item = record.queue.find((entry) => entry.id === id);
      if (!item || item.disposition === 'removed' || item.disposition === 'consumed')
        return { result: 'not_found' as const };
      if (item.disposition !== 'pending') return { result: 'in_flight' as const };
      if (record.paused || execution.current?.id !== operationId || execution.current.status === 'aborting')
        return { result: 'target_changed' as const };
      return {
        record: {
          ...record,
          queue: record.queue.map((entry) => (entry.id === id ? { ...entry, delivery: 'steer', operationId } : entry)),
        },
        result: 'promoted' as const,
      };
    });
    if (result === 'promoted') {
      await publishLifecycle();
      void deliverPromoted(id, operationId).catch((error: unknown) =>
        emitFrame({ type: FRAME_ERROR, code: 'steer_handoff', error: errorMessage(error) }),
      );
    }
    return result;
  };
  const resumeQueue = async (): Promise<void> => {
    const execution = await lane.inspectExecution(context);
    if (execution.current !== null) throw new Error('Wait for the active turn to settle before resuming the queue');
    await changeRecord((record) => ({
      record: {
        ...record,
        paused: false,
        abortOperationId: undefined,
        queue: record.queue.map((entry) =>
          entry.disposition === 'pending' && entry.delivery === 'steer'
            ? { ...entry, delivery: 'followUp', operationId: undefined, scheduling: 'automatic' }
            : entry,
        ),
      },
      result: undefined,
    }));
    await publishLifecycle();
    void drainAutomatic().catch((error: unknown) =>
      emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
    );
  };
  const steer = (message: string | AgentMessage, images?: ImageContent[], targetOperationId?: string): Promise<void> =>
    runAgentOperation(async () => {
      const execution = await lane.inspectExecution(context);
      const id = randomUUID();
      const retained =
        typeof message === 'string'
          ? { id, text: message, ...(images === undefined ? {} : { images }) }
          : { ...retainedMessage(id, 'steer', message), id };
      const target = targetOperationId ?? execution.current?.id;
      const active =
        target !== undefined && execution.current?.id === target && execution.current.status !== 'aborting';
      await changeRecord((record) => ({
        record: {
          ...record,
          queue: [
            ...record.queue,
            {
              ...retained,
              delivery: active ? 'steer' : 'followUp',
              scheduling: 'automatic',
              disposition: 'pending',
              nativeEntryId: undefined,
              ...(active ? { operationId: target } : {}),
            },
          ],
        },
        result: undefined,
      }));
      await publishLifecycle();
      if (active)
        void deliverPromoted(id, target).catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'steer_handoff', error: errorMessage(error) }),
        );
      else
        void drainAutomatic().catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
        );
    });
  const followUp = (message: string | AgentMessage, images?: ImageContent[]): Promise<void> =>
    runAgentOperation(async () => {
      const result = await writable(() => lane.followUp(message, images, context));
      if (!result.ok) resultError(result);
      await adoptNativeQueue();
    });
  const nextRun = (message: string | AgentMessage, images?: ImageContent[]): Promise<void> =>
    runAgentOperation(async () => {
      const result = await writable(() => lane.nextRun(message, images, context));
      if (!result.ok) resultError(result);
      await adoptNativeQueue();
    });
  const abort = (targetOperationId?: string): Promise<void> =>
    runAgentOperation(async () => {
      const execution = await lane.inspectExecution(context);
      const currentId = execution.current?.id;
      if (!currentId || (targetOperationId !== undefined && targetOperationId !== currentId)) return;
      // Serialize handoff and pause. A promoted steer can neither enter the native inbox
      // between this snapshot and cancellation nor acknowledge without a retained mapping.
      const paused = await serializeAdmission(async () => {
        if ((await lane.inspectExecution(context)).current?.id !== currentId) return false;
        // Commit pause and a complete inbox snapshot before native cancellation deletes payloads.
        const captured = await writable(() =>
          storage.session.mutate(async (mutator) => {
            const stored = await mutator.getValue(lifecycleAddress, context);
            const record = stored?.value ?? EMPTY_LIFECYCLE;
            const native = await mutator.getValue(laneState(laneName), context);
            if (native?.value.currentOperationId !== currentId) return false;
            const adopted: RetainedInput[] = [];
            for (const pending of native.value.inbox) {
              if (pending.kind !== 'steer' && pending.kind !== 'followUp') continue;
              if (record.queue.some((item) => item.id === pending.entryId || item.nativeEntryId === pending.entryId))
                continue;
              const payload = await mutator.getValue(pendingEntry(pending.entryId), context);
              if (payload?.value.type !== 'message')
                throw new Error(`Native queued input ${pending.entryId} has no message payload`);
              adopted.push(retainedMessage(pending.entryId, pending.kind, payload.value.payload));
            }
            await mutator.commit(
              [
                setValue(lifecycleAddress, {
                  ...record,
                  revision: record.revision + 1,
                  paused: true,
                  abortOperationId: currentId,
                  queue: [
                    ...record.queue.map((entry) =>
                      entry.disposition === 'pending' && entry.delivery === 'steer'
                        ? { ...entry, delivery: 'followUp' as const, operationId: undefined }
                        : entry,
                    ),
                    ...adopted,
                  ],
                }),
              ],
              context,
            );
            return true;
          }, context),
        );
        if (!captured) return false;
        abortingOperationId = currentId;
        await publishLifecycle();
        return true;
      });
      if (!paused) return;
      const result = await writable(() => lane.requestAbort(currentId, context));
      if (!result.ok) {
        if (result.error._tag === 'OperationMismatch') return;
        resultError(result);
      }
      const returned = [
        ...result.value.steer.map((message) => ({ kind: 'steer' as const, message })),
        ...result.value.followUp.map((message) => ({ kind: 'followUp' as const, message })),
      ];
      const latest = await readRecord();
      const native = await storage.session.getValue(laneState(laneName), context);
      const remaining = new Set((native?.value.inbox ?? []).map((item) => item.entryId));
      const consumed = await Promise.all(
        latest.queue
          .filter((item) => item.nativeEntryId !== undefined)
          .map(async (item) => [item.id, await storage.session.getEntry(item.nativeEntryId!, context)] as const),
      );
      const committed = new Set(consumed.filter(([, entry]) => entry !== undefined).map(([id]) => id));
      const removedUnconsumed = latest.queue.filter(
        (item) => item.nativeEntryId !== undefined && !remaining.has(item.nativeEntryId) && !committed.has(item.id),
      );
      // The native result omits IDs. Match it to the already-retained native inbox by
      // cardinality and kind, never by text: two identical messages are distinct inputs.
      const unmatched = {
        steer: removedUnconsumed.filter((item) => item.delivery === 'steer').length,
        followUp: removedUnconsumed.filter((item) => item.delivery === 'followUp').length,
      };
      const ambiguous =
        returned.filter(({ kind }) => kind === 'steer').length !== unmatched.steer ||
        returned.filter(({ kind }) => kind === 'followUp').length !== unmatched.followUp;
      const extras = returned
        .filter(({ kind }) => {
          if (!ambiguous && unmatched[kind] > 0) {
            unmatched[kind] -= 1;
            return false;
          }
          return true;
        })
        .map(({ kind, message }) => ({
          ...retainedMessage(randomUUID(), kind, message),
          delivery: kind === 'steer' ? ('followUp' as const) : kind,
          scheduling: 'held' as const,
          disposition: 'pending' as const,
          nativeEntryId: undefined,
        }));
      await changeRecord((current) => ({
        record: {
          ...current,
          queue: [
            ...current.queue.map((item) => {
              if (item.nativeEntryId === undefined || remaining.has(item.nativeEntryId)) return item;
              if (committed.has(item.id)) return { ...item, disposition: 'consumed' };
              return ambiguous
                ? { ...item, disposition: 'uncertain' }
                : {
                    ...item,
                    disposition: 'pending',
                    nativeEntryId: undefined,
                    delivery: item.delivery === 'steer' ? 'followUp' : item.delivery,
                    scheduling: item.delivery === 'steer' ? 'automatic' : item.scheduling,
                  };
            }),
            ...extras,
          ],
        },
        result: undefined,
      }));
      await publishLifecycle();
    });
  const compact = (customInstructions?: string): Promise<void> =>
    runAgentOperation(async () => {
      const result = await writable(() =>
        lane.compact(customInstructions === undefined ? undefined : { customInstructions }, context),
      );
      if (!result.ok) resultError(result);
    });
  const recover = async (): Promise<void> => {
    await adoptNativeQueue();
    const record = await readRecord();
    if (record.abortOperationId !== undefined) {
      const execution = await lane.inspectExecution(context);
      if (execution.current?.id === record.abortOperationId) {
        await abort(record.abortOperationId);
        const afterAbort = await lane.inspectExecution(context);
        if (afterAbort.current?.id === record.abortOperationId && afterAbort.current.status !== 'aborting')
          throw new Error('Cannot resume a turn before its persisted abort intent reaches native cancellation');
        // An interrupted native drive has no process-local owner. Resume only its
        // already-cancelled control path to reach terminal cleanup; never regenerate.
        if (afterAbort.current?.id === record.abortOperationId) {
          const resumed = await writable(() => lane.resume(context));
          if (!resumed.ok && resumed.error._tag !== 'NothingToResume') resultError(resumed);
        }
      }
      await changeRecord((current) => ({
        record: { ...current, abortOperationId: undefined, paused: true },
        result: undefined,
      }));
    }
    for (const item of (await readRecord()).queue.filter(
      (entry) =>
        entry.disposition === 'handoff' &&
        entry.attemptId !== undefined &&
        entry.operationId === undefined &&
        entry.nativeEntryId === undefined,
    )) {
      await changeRecord((record) => ({
        record: {
          ...record,
          queue: record.queue.map((entry) => (entry.id === item.id ? { ...entry, disposition: 'uncertain' } : entry)),
        },
        result: undefined,
      }));
    }
    const current = await readRecord();
    for (const item of current.queue.filter(
      (entry) => entry.disposition === 'handoff' && entry.operationId !== undefined,
    )) {
      const execution = await lane.inspectExecution(context);
      const result = await lane.getResult(item.operationId!, context);
      if (item.delivery !== 'steer' && (execution.current?.id === item.operationId || result !== undefined)) {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) => (entry.id === item.id ? { ...entry, disposition: 'consumed' } : entry)),
          },
          result: undefined,
        }));
      } else {
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) => (entry.id === item.id ? { ...entry, disposition: 'uncertain' } : entry)),
          },
          result: undefined,
        }));
      }
    }
    await reconcileNativeQueue();
    await publishLifecycle();
  };
  const resume = (): Promise<boolean> =>
    runAgentOperation(async () => {
      await recover();
      if ((await readRecord()).paused) return false;
      const result = await writable(() => lane.resume(context));
      // A lane with no persisted operation has nothing to continue. That is the
      // ordinary state of a session reopened while idle, not a failure, so it is
      // reported rather than thrown: only the caller knows whether it expected one.
      if (!result.ok && result.error._tag === 'NothingToResume') {
        void drainAutomatic().catch((error: unknown) =>
          emitFrame({ type: FRAME_ERROR, code: 'queue_drain', error: errorMessage(error) }),
        );
        return false;
      }
      if (!result.ok) resultError(result);
      return true;
    });
  const readState = async (): Promise<Record<string, unknown>> => {
    const [lifecycle, retained, persisted, stats, thinking] = await Promise.all([
      readLifecycle(),
      readRecord(),
      storage.session.getValue(laneState(laneName), context),
      storage.session.getStats(context),
      lane.getThinkingLevel(context),
    ]);
    const configuredModel = await lane.getModel(context);
    const name = await harness.getName(context);
    return {
      model: configuredModel === undefined ? undefined : { provider: configuredModel.provider, id: configuredModel.id },
      thinkingLevel: thinking,
      isStreaming: lifecycle.operation?.kind === 'run',
      isCompacting: lifecycle.operation?.kind === 'compaction',
      ...(lifecycle.operation === null
        ? {}
        : { operationId: lifecycle.operation.id, executionStatus: lifecycle.operation.status }),
      queuePaused: lifecycle.paused,
      queueRevision: lifecycle.revision,
      steeringMode: await harness.getSteeringMode(context),
      followUpMode: await harness.getFollowUpMode(context),
      sessionFile: storage.sessionFile,
      sessionId,
      ...(name === undefined ? {} : { sessionName: name }),
      autoCompactionEnabled: (await harness.getCompactionSettings(context)).enabled,
      messageCount: stats.messageCount,
      pendingMessageCount:
        lifecycle.queue.length +
        (persisted?.value.inbox.filter(
          (entry) =>
            entry.kind !== 'write' &&
            !retained.queue.some((item) => item.id === entry.entryId || item.nativeEntryId === entry.entryId),
        ).length ?? 0),
    };
  };
  const readEntries = async () => ({
    entries: await entriesForLane(lane, context),
    leafId: await lane.getTipId(context),
  });
  const listCommands = () => [...(options.listCommands?.() ?? [])];
  const setModel = async (model: { provider: string; id: string }): Promise<void> => {
    if (models.getModel(model.provider, model.id) === undefined)
      throw new Error(`Model not found: ${model.provider}/${model.id}`);
    await writable(() => lane.setModel({ provider: model.provider, modelId: model.id }, context));
  };
  const availableModels = () => models.getAvailable();
  const availableThinkingLevels = async () => {
    const model = await lane.getModel(context);
    if (!model) throw new Error('No model is selected');
    return getSupportedThinkingLevels(model);
  };
  const setThinkingLevel = (level: Parameters<typeof lane.setThinkingLevel>[0]) =>
    writable(() => lane.setThinkingLevel(level, context));
  const setSteeringMode = (mode: Parameters<typeof harness.setSteeringMode>[0]) =>
    writable(() => harness.setSteeringMode(mode, context));
  const setFollowUpMode = (mode: Parameters<typeof harness.setFollowUpMode>[0]) =>
    writable(() => harness.setFollowUpMode(mode, context));
  const navigateTree = (targetId: string | null, navigationOptions?: Record<string, unknown>) =>
    runAgentOperation(async () => {
      const result = await writable(() => lane.navigateTree(targetId, navigationOptions as never, context));
      if (!result.ok) resultError(result);
      return {
        cancelled: result.value.navigation.status !== 'completed',
        entries: await entriesForLane(lane, context),
      };
    });
  const clearQueue = async () => {
    await changeRecord((record) => ({
      record: {
        ...record,
        queue: record.queue.map((entry) =>
          entry.disposition === 'pending' ? { ...entry, disposition: 'removed' } : entry,
        ),
      },
      result: undefined,
    }));
    const queued = (await storage.session.getValue(laneState(laneName), context))?.value.inbox ?? [];
    for (const item of queued) {
      if (item.kind === 'write') continue;
      const result = await writable(() => lane.cancelQueued(item.entryId, context));
      if (!result.ok) resultError(result);
      if (result.value.kind === 'cancelled')
        await changeRecord((record) => ({
          record: {
            ...record,
            queue: record.queue.map((entry) =>
              entry.nativeEntryId === item.entryId ? { ...entry, disposition: 'removed' } : entry,
            ),
          },
          result: undefined,
        }));
    }
    await publishLifecycle();
    return { steering: [] as never[], followUp: [] as never[] };
  };
  const setName = (name: string) => writable(() => harness.setName(name, context));
  const getSessionStats = () => storage.session.getStats(context);
  const dispose = (): Promise<void> => {
    // Preserve the facade's idempotent second-dispose contract even if the first
    // close reported a failure, while still waiting for a concurrent close to finish.
    if (disposed)
      return (
        disposePromise?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve()
      );
    disposePromise ??= (async () => {
      let failure: unknown;
      try {
        const execution = await lane.inspectExecution(context);
        if (execution.current !== null) await abort(execution.current.id);
      } catch (error) {
        failure = error;
        markStorageFailure(error);
      }
      disposed = true;
      for (const unsubscribeEvent of unsubscribe) unsubscribeEvent();
      for (const unsubscribeHook of unsubscribeHooks) unsubscribeHook();
      try {
        await harness.close(context);
      } catch (error) {
        failure ??= error;
        markStorageFailure(error);
      }
      try {
        await closeStorage(storage, context);
      } catch (error) {
        failure ??= error;
        markStorageFailure(error);
      }
      settleExit(failure === undefined ? 0 : 1);
      if (failure !== undefined) throw failure;
    })();
    return disposePromise;
  };

  // The owning host explicitly resumes only after its facets and selection gates are ready.

  return {
    sessionId,
    laneName,
    harnessId,
    completeModel: models.complete?.bind(models),
    session: storage.session,
    harness,
    lane,
    exited,
    get storageQuarantined() {
      return storageQuarantined;
    },
    onPresentationFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onEvent(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    stop() {
      void abort()
        .catch(() => undefined)
        .finally(() => dispose().catch(() => undefined));
    },
    readState,
    readLifecycle,
    enqueueAutomatic,
    removeQueued,
    promoteQueued,
    resumeQueue,
    recover,
    readEntries,
    listCommands,
    dispatchCommand,
    setModel,
    availableModels,
    availableThinkingLevels,
    setThinkingLevel,
    setSteeringMode,
    setFollowUpMode,
    navigateTree,
    clearQueue,
    setName,
    getSessionStats,
    replaceTools,
    replaceResources,
    readResources,
    runExternalOperation,
    appendCustomEntry,
    appendMessage,
    setLabel,
    recordUsage,
    submitPrompt,
    prompt,
    admitMessage,
    steer,
    followUp,
    nextRun,
    abort,
    compact,
    resume,
    dispose,
  };
}

export type {
  DirectHarnessRuntimeOptions,
  DirectHarnessRuntime,
  DirectHarnessFrame,
} from '../types/server/directHarnessRuntime';
