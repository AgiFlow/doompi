import fs from 'node:fs';
import path from 'node:path';
import {
  AgentHarness,
  HarnessFault,
  type AgentHarnessTool,
  type AgentLane,
  type HarnessEvent,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/pi-agent-core/harness/context';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  JSONL_STORAGE_VERSION,
  JsonlSessionRepo,
  type JsonlSessionMetadata,
  type Entry,
  type Session,
} from '@earendil-works/pi-agent-core/harness/session';
import {
  createModels,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type ImageContent,
  type Model,
  type Models,
  type MutableModels,
  type Usage,
} from '@earendil-works/pi-ai';
import { protectAndImportHistory, preserveHistoryBeforeOpen } from '../serialization/historyImport.ts';
import { importV3WithPinnedUpstream } from '../serialization/jsonlSessionRepo.ts';
import type {
  DirectHarnessEventListener,
  DirectHarnessFrame,
  DirectHarnessModel,
  DirectHarnessRuntime,
  DirectHarnessRuntimeOptions,
} from '../../types/server/directHarnessRuntime.ts';
import type { HistoryOwnershipLease } from '../serialization/historyImport.ts';

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

type StorageHandle = {
  session: AnySession;
  sessionFile?: string;
  repository?: JsonlSessionRepo;
  environment?: NodeExecutionEnv;
  historyLease?: HistoryOwnershipLease;
};

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

function metadataFromFile(filePath: string): JsonlSessionMetadata {
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
    repository?: JsonlSessionRepo;
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

  const sessionPath = options.sessionPath === undefined ? undefined : path.resolve(options.sessionPath);
  const legacyPath = options.legacySessionPath === undefined ? sessionPath : path.resolve(options.legacySessionPath);
  let importedPath = sessionPath;
  if (legacyPath !== undefined && isV3File(legacyPath)) {
    const owner = options.historyOwnership;
    if (owner === undefined) throw new Error('Opening a legacy session requires explicit HistoryOwnership');
    importedPath = sessionPath !== undefined && sessionPath !== legacyPath ? sessionPath : `${legacyPath}.v4`;
    await protectAndImportHistory({
      sourcePath: legacyPath,
      destinationPath: importedPath,
      owner,
      ...(options.historyOriginalPath === undefined ? {} : { originalPath: options.historyOriginalPath }),
      ...(options.historyStatePath === undefined ? {} : { statePath: options.historyStatePath }),
      importStaging: importV3WithPinnedUpstream,
    });
  }

  const environment = new NodeExecutionEnv({ cwd: options.cwd });
  const sessionsRoot = path.resolve(
    options.sessionsRoot ??
      (importedPath === undefined ? path.join(options.cwd, DEFAULT_SESSION_ROOT) : path.dirname(importedPath)),
  );
  const repository = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot, now: () => Date.now() });
  let historyLease: HistoryOwnershipLease | undefined;
  try {
    let session: AnySession;
    if (importedPath !== undefined) {
      const owner = options.historyOwnership;
      if (owner === undefined) throw new Error('Opening an existing session requires explicit HistoryOwnership');
      historyLease = await acquireHistoryLease(owner, importedPath);
      const metadata = metadataFromFile(importedPath);
      if (options.sessionId !== undefined && options.sessionId !== metadata.id) {
        throw new Error(`Session id mismatch: expected ${options.sessionId}, found ${metadata.id}`);
      }
      await preserveHistoryBeforeOpen(metadata.path, historyLease);
      session = await repository.open(metadata, context);
    } else {
      const owner = options.historyOwnership;
      if (owner === undefined) throw new Error('Creating a writable session requires explicit HistoryOwnership');
      const created = await repository.create({ id: options.sessionId, cwd: options.cwd }, context);
      session = created;
      importedPath = created.metadata.path;
      historyLease = await acquireHistoryLease(owner, importedPath);
    }
    return { session, sessionFile: importedPath, repository, environment, historyLease };
  } catch (error) {
    await closeStorage({ repository, environment, historyLease }, context);
    throw error;
  }
}

function configureModels<TContext extends object | undefined>(
  options: DirectHarnessRuntimeOptions<TContext>,
): AnyModels {
  if (options.models !== undefined) {
    if (options.providers !== undefined && 'setProvider' in options.models) {
      for (const provider of options.providers) options.models.setProvider(provider);
    }
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
        { type: 'agent_settled' },
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

function successFrame(id: unknown, command: string, data?: unknown): DirectHarnessFrame {
  return {
    ...(typeof id === 'string' ? { id } : {}),
    type: 'response',
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  };
}

function failureFrame(id: unknown, command: string, error: unknown): DirectHarnessFrame {
  return {
    ...(typeof id === 'string' ? { id } : {}),
    type: 'response',
    command,
    success: false,
    error: errorMessage(error),
  };
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
  let storageQuarantined = false;
  let requestPreparationFailure: { error: unknown } | undefined;
  let turnPreparationFailure: { error: unknown } | undefined;
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
  const handleHarnessEvent = async (event: HarnessEvent, eventContext: Context): Promise<void> => {
    await emitLifecycle(event, eventContext);
    if (event.type === 'fault') markStorageFailure(event);
    for (const frame of mapHarnessEvent(event)) emitFrame(frame);
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

  const unsubscribeHooks: Array<() => void> = [];
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

  const drive = async (operationId: string): Promise<void> => {
    const result = await writable(() => lane.drive({ operationId, waitForRetry: true }, context));
    if (!result.ok) resultError(result);
    if (result.value.kind === 'waiting' && result.value.reason === 'retry') {
      throw new Error(`Direct harness returned an unexpected retry wait for ${operationId}`);
    }
  };

  const startPrompt = async (
    text: string,
    images?: ImageContent[],
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<void> => {
    const execution = await lane.inspectExecution(context);
    if (execution.current !== null && streamingBehavior !== undefined) {
      const queued =
        streamingBehavior === 'steer'
          ? await writable(() => lane.steer(text, images, context))
          : await writable(() => lane.followUp(text, images, context));
      if (!queued.ok) resultError(queued);
      return;
    }
    const admission = await writable(() =>
      lane.accept(
        {
          kind: 'prompt',
          prompt: text,
          ...(images === undefined ? {} : { images }),
        },
        context,
      ),
    );
    if (!admission.ok) resultError(admission);
    await drive(admission.value.operationId);
  };

  const command = async (frame: DirectHarnessFrame): Promise<void> => {
    const type = stringValue(frame.type);
    const id = frame.id;
    if (type === undefined) {
      emitFrame(failureFrame(id, 'unknown', new Error('Command frame has no type')));
      return;
    }
    switch (type) {
      case 'prompt': {
        const message = stringValue(frame.message);
        if (message === undefined) {
          emitFrame(failureFrame(id, type, new Error('Prompt message must be a string')));
          return;
        }
        try {
          await startPrompt(
            message,
            Array.isArray(frame.images) ? (frame.images as ImageContent[]) : undefined,
            frame.streamingBehavior === 'steer' || frame.streamingBehavior === 'followUp'
              ? frame.streamingBehavior
              : undefined,
          );
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
          emitFrame({ type: 'agent_settled' });
        }
        return;
      }
      case 'steer':
      case 'follow_up': {
        const message = stringValue(frame.message);
        if (message === undefined) {
          emitFrame(failureFrame(id, type, new Error('Queued message must be a string')));
          return;
        }
        try {
          const queued =
            type === 'steer'
              ? await writable(() =>
                  lane.steer(
                    message,
                    Array.isArray(frame.images) ? (frame.images as ImageContent[]) : undefined,
                    context,
                  ),
                )
              : await writable(() =>
                  lane.followUp(
                    message,
                    Array.isArray(frame.images) ? (frame.images as ImageContent[]) : undefined,
                    context,
                  ),
                );
          if (!queued.ok) resultError(queued);
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'abort': {
        try {
          const result = await writable(() => lane.abort(context));
          if (!result.ok) resultError(result);
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'get_state': {
        try {
          const snapshot = await lane.watch(context);
          const execution = snapshot.snapshot;
          snapshot.unsubscribe();
          const configuredModel = await lane.getModel(context);
          const name = await harness.getName(context);
          const data = {
            model: configuredModel,
            thinkingLevel: execution.configuration.thinkingLevel,
            isStreaming: execution.operation?.kind === 'run',
            isCompacting: execution.operation?.kind === 'compaction',
            steeringMode: await harness.getSteeringMode(context),
            followUpMode: await harness.getFollowUpMode(context),
            sessionFile: storage.sessionFile,
            sessionId,
            ...(name === undefined ? {} : { sessionName: name }),
            autoCompactionEnabled: (await harness.getCompactionSettings(context)).enabled,
            messageCount: execution.stats.messageCount,
            pendingMessageCount: execution.queues.filter((entry) => entry.type === 'message').length,
          };
          emitFrame(successFrame(id, type, data));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'set_model': {
        const provider = stringValue(frame.provider);
        const modelId = stringValue(frame.modelId);
        try {
          if (!provider || !modelId) throw new Error('Model provider and modelId are required');
          const next = models.getModel(provider, modelId);
          if (next === undefined) throw new Error(`Model not found: ${provider}/${modelId}`);
          await writable(() => lane.setModel({ provider, modelId }, context));
          emitFrame(successFrame(id, type, next));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'get_available_models': {
        try {
          emitFrame(successFrame(id, type, { models: await models.getAvailable() }));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'set_thinking_level': {
        try {
          const level = stringValue(frame.level);
          if (level === undefined) throw new Error('Thinking level is required');
          await writable(() => lane.setThinkingLevel(level as never, context));
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'set_steering_mode':
      case 'set_follow_up_mode': {
        try {
          const mode = stringValue(frame.mode);
          if (mode !== 'all' && mode !== 'one-at-a-time') throw new Error('Queue mode must be all or one-at-a-time');
          if (type === 'set_steering_mode') await writable(() => harness.setSteeringMode(mode, context));
          else await writable(() => harness.setFollowUpMode(mode, context));
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'compact': {
        try {
          const result = await writable(() =>
            lane.compact(
              frame.customInstructions === undefined
                ? undefined
                : { customInstructions: stringValue(frame.customInstructions) ?? '' },
              context,
            ),
          );
          if (!result.ok) resultError(result);
          emitFrame(successFrame(id, type, result.value));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'navigate_tree': {
        try {
          const rawTargetId = frame.targetId;
          if (rawTargetId !== null && typeof rawTargetId !== 'string')
            throw new Error('Navigation targetId must be a string or null');
          const targetId: string | null = rawTargetId ?? null;
          const result = await writable(() =>
            lane.navigateTree(targetId, isRecord(frame.options) ? (frame.options as never) : undefined, context),
          );
          if (!result.ok) resultError(result);
          const entries = await entriesForLane(lane, context);
          emitFrame(successFrame(id, type, { cancelled: result.value.navigation.status !== 'completed', entries }));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'get_entries': {
        try {
          let entries = await entriesForLane(lane, context);
          const since = stringValue(frame.since);
          if (since !== undefined) {
            const index = entries.findIndex((entry) => isRecord(entry) && entry.id === since);
            if (index < 0) throw new Error(`Entry not found: ${since}`);
            entries = entries.slice(index + 1);
          }
          emitFrame(successFrame(id, type, { entries, leafId: await lane.getTipId(context) }));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'get_messages': {
        try {
          const entries = await entriesForLane(lane, context);
          emitFrame(
            successFrame(id, type, {
              messages: entries
                .filter((entry): entry is Extract<Entry, { type: 'message' }> => entry.type === 'message')
                .map((entry) => entry.message),
            }),
          );
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'set_session_name': {
        try {
          const name = stringValue(frame.name)?.trim();
          if (!name) throw new Error('Session name cannot be empty');
          await writable(() => harness.setName(name, context));
          emitFrame(successFrame(id, type));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'get_session_stats': {
        try {
          emitFrame(successFrame(id, type, await storage.session.getStats(context)));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'record_usage': {
        try {
          if (!isRecord(frame.usage)) throw new Error('Usage is required');
          const result = await writable(() =>
            lane.recordUsage(
              frame.usage as Usage,
              isRecord(frame.options) ? (frame.options as never) : undefined,
              context,
            ),
          );
          if (!result.ok) resultError(result);
          emitFrame(successFrame(id, type, result.value));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'append_custom_entry': {
        try {
          const customType = stringValue(frame.customType);
          if (!customType) throw new Error('customType is required');
          const entryId = await writable(() => lane.appendCustomEntry(customType, frame.data as never, context));
          emitFrame(successFrame(id, type, { entryId }));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'resume': {
        try {
          const result = await writable(() => lane.resume(context));
          if (!result.ok) resultError(result);
          emitFrame(successFrame(id, type, result.value));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      case 'clear_queue': {
        try {
          const snapshot = await lane.watch(context);
          const queued = snapshot.snapshot.queues;
          snapshot.unsubscribe();
          for (const item of queued)
            await writable(() => lane.cancelQueued(item.entryId, context)).then((result) => {
              if (!result.ok) resultError(result);
            });
          emitFrame(successFrame(id, type, { steering: [], followUp: [] }));
        } catch (error) {
          emitFrame(failureFrame(id, type, error));
        }
        return;
      }
      default:
        emitFrame(failureFrame(id, type, new Error(`Unknown command: ${type}`)));
    }
  };

  const replaceTools = async (tools: AgentHarnessTool<TContext>[]): Promise<void> => {
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
  };
  const replaceResources = async (resources: Parameters<typeof harness.setResources>[0]): Promise<void> => {
    await writable(() => harness.setResources(resources, context));
  };
  const readResources = async () => {
    guardLive();
    return harness.getResources(context);
  };
  const appendCustomEntry = async (customType: string, data?: unknown): Promise<string> =>
    writable(() => lane.appendCustomEntry(customType, data as never, context));
  const recordUsage = async (
    usage: Usage,
    options?: { entryId?: string; details?: import('@earendil-works/pi-agent-core').JsonValue },
  ): Promise<string> => {
    const result = await writable(() => lane.recordUsage(usage, options, context));
    if (!result.ok) resultError(result);
    return result.value.usageId;
  };
  const prompt = async (text: string, images?: ImageContent[]): Promise<void> => startPrompt(text, images);
  const steer = async (text: string, images?: ImageContent[]): Promise<void> => {
    const result = await writable(() => lane.steer(text, images, context));
    if (!result.ok) resultError(result);
  };
  const followUp = async (text: string, images?: ImageContent[]): Promise<void> => {
    const result = await writable(() => lane.followUp(text, images, context));
    if (!result.ok) resultError(result);
  };
  const abort = async (): Promise<void> => {
    const result = await writable(() => lane.abort(context));
    if (!result.ok) resultError(result);
  };
  const compact = async (customInstructions?: string): Promise<void> => {
    const result = await writable(() =>
      lane.compact(customInstructions === undefined ? undefined : { customInstructions }, context),
    );
    if (!result.ok) resultError(result);
  };
  const resume = async (): Promise<void> => {
    const result = await writable(() => lane.resume(context));
    if (!result.ok) resultError(result);
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribeEvent of unsubscribe) unsubscribeEvent();
    for (const unsubscribeHook of unsubscribeHooks) unsubscribeHook();
    let failure: unknown;
    try {
      await harness.close(context);
    } catch (error) {
      failure = error;
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
  };

  // The owning host explicitly resumes only after its facets and selection gates are ready.

  return {
    sessionId,
    laneName,
    harnessId,
    session: storage.session,
    harness,
    lane,
    exited,
    get storageQuarantined() {
      return storageQuarantined;
    },
    send(frame) {
      void command(frame).catch((error) => {
        emitFrame(failureFrame(frame.id, stringValue(frame.type) ?? 'unknown', error));
      });
    },
    onFrame(listener) {
      listeners.add(listener);
    },
    onEvent(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    endInput() {
      void dispose().catch(() => undefined);
    },
    stop() {
      void abort()
        .catch(() => undefined)
        .finally(() => dispose().catch(() => undefined));
    },
    replaceTools,
    replaceResources,
    readResources,
    appendCustomEntry,
    recordUsage,
    prompt,
    steer,
    followUp,
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
} from '../../types/server/directHarnessRuntime.ts';
