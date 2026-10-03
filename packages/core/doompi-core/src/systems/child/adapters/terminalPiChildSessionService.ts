import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models, MutableModels, Provider } from '@earendil-works/pi-ai';
import {
  getAgentDir,
  parseSessionEntries,
  sessionEntryToContextMessages,
  convertToLlm,
} from '@earendil-works/pi-coding-agent';
import { AgentDoc, type EntryId } from '@earendil-works/pi-durable';

import {
  createDoomChildSessionService,
  type DoomChildSessionIntercom,
  type DoomChildSessionHooks,
  type DoomChildSessionRuntime,
  type DoomChildSessionService,
  type DoomChildSessionServiceProvider,
  type DoomChildSessionTerminalPiForkSource,
  type DoomChildSessionRequest,
} from '../../../exports/childSession';
import type { DoomChildSessionMcpTool } from '../../../exports/childSession';
import {
  createDirectHarnessRuntime,
  promptForAssistantText,
  type DirectHarnessRuntime,
  type DirectHarnessRuntimeOptions,
} from '../../../server/directHarnessRuntime';
import { readNativeChildTranscript } from '../../../server/nativeChildTranscriptReader';
import { DurableNavigationDoc } from '../../../services/durableNavigation';
import type { HistoryOwnership } from '../../../services/historyImport';
import { createHistoryOwnership } from '../../../services/historyOwnership';
import { fromPiSessionEntry } from '../../../services/piSessionEntries';
import { openSqliteSessionStorage } from '../../../services/sqliteSessionStorage';
import type { DirectHarnessModel } from '../../../types/server/directHarnessRuntime';
import {
  composeDirectHarnessRequestOptions,
  bindChildHooks,
  bindChildMcpCatalog,
  createHeadlessChildSessionService,
  parseChildModelReference,
  resolveChildProviders,
  type HeadlessChildSessionServiceOptions,
} from './headlessChildSessionService';
import { registerNativeChild } from './nativeChildRuntimes';

export interface TerminalPiChildSessionServiceOptions {
  readonly cwd: string;
  readonly sessionsRoot?: string;
  readonly models?: Models | MutableModels;
  /**
   * Providers to merge into the model registry for every child spawn. A thunk
   * is resolved per spawn so providers registered after this service was built,
   * such as Pi extension providers, are still visible to the child.
   */
  readonly providers?: readonly Provider[] | (() => readonly Provider[]);
  readonly defaultModel?: () => DirectHarnessModel | undefined;
  /** Snapshot the parent preference once per creation, never live-sync child toggles. */
  readonly parentFastMode?: () => boolean | Promise<boolean>;
  readonly hooks?: () => DoomChildSessionHooks | undefined;
  readonly mcpTool?: () => DoomChildSessionMcpTool | undefined;
  readonly subscribeMcpTool?: (listener: () => void) => () => void;
  readonly historyOwnership?: HistoryOwnership;
  readonly now?: () => number;
  readonly runtimeFactory?: (options: DirectHarnessRuntimeOptions) => Promise<DirectHarnessRuntime>;
}

export interface TerminalPiForkSourceManager {
  getSessionId(): string;
  getLeafId(): string | null;
  getHeader(): { type: string; version?: number; [key: string]: unknown } | null;
  getBranch(fromId?: string): readonly Record<string, unknown>[];
}

function childRuntime(
  runtime: DirectHarnessRuntime,
  intercom?: DoomChildSessionIntercom,
  release?: () => void | Promise<void>,
): DoomChildSessionRuntime {
  const file = runtime.sessionFile;
  return {
    sessionId: runtime.sessionId,
    ...(typeof file === 'string' ? { sessionFile: file } : {}),
    ...(typeof file === 'string'
      ? { readTranscriptPage: (request, signal) => readNativeChildTranscript(file, request, signal) }
      : {}),
    prompt: (task) => promptForAssistantText(runtime, task),
    async steer(message) {
      await runtime.submitInternalMessage(message, 'steer');
    },
    async followUp(message) {
      await runtime.submitInternalMessage(message, 'followUp');
    },
    onUsage(listener) {
      return runtime.onEvent((event) => {
        if (event.type !== 'usage') return;
        listener({ rowId: event.row.id, cost: event.row.usage.cost.total });
      });
    },
    abort: () => runtime.abort(),
    dispose: async () => {
      try {
        await release?.();
      } finally {
        try {
          await runtime.dispose();
        } finally {
          intercom?.dispose?.();
        }
      }
    },
  };
}

type DirectHarnessTool = Parameters<DirectHarnessRuntime['replaceTools']>[0][number];

async function installIntercom(
  runtime: DirectHarnessRuntime,
  intercom: DoomChildSessionIntercom | undefined,
  tools: DirectHarnessTool[],
): Promise<void> {
  if (!intercom) return;
  const tool = intercom.bindRuntime(childRuntime(runtime));
  const adapted = {
    ...tool,
    parameters: tool.parameters as never,
    execute: async (
      operationId: string,
      params: unknown,
      onUpdate: (result: { content: unknown; details?: unknown }) => void,
      _toolContext: unknown,
      _invocation: unknown,
      context: { abortSignal: AbortSignal | undefined },
    ) => tool.execute(operationId, params, context.abortSignal ?? new AbortController().signal, onUpdate as never),
  } as unknown as DirectHarnessTool;
  tools.push(adapted);
  await runtime.replaceTools(tools);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid terminal Pi snapshot ${field}`);
  return value;
}

function parseSnapshot(snapshotJsonl: string): { header: Record<string, unknown>; records: Record<string, unknown>[] } {
  if (!snapshotJsonl.endsWith('\n')) throw new Error('Terminal Pi snapshot is truncated.');
  const lines = snapshotJsonl.slice(0, -1).split('\n');
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0] ?? '');
  } catch (error) {
    throw new Error('Malformed terminal Pi snapshot header.', { cause: error });
  }
  const header = asRecord(headerValue);
  if (header?.type !== 'session' || header.version !== 3)
    throw new Error('Terminal Pi child source must be a v3 JSONL snapshot.');
  const records = lines.slice(1).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed terminal Pi snapshot record at line ${index + 2}.`, { cause: error });
    }
    const record = asRecord(value);
    if (record === undefined) throw new Error(`Invalid terminal Pi snapshot record at line ${index + 2}`);
    requireString(record.id, `record ${index + 2} id`);
    if (record.parentId !== null && typeof record.parentId !== 'string')
      throw new Error(`Invalid terminal Pi snapshot record ${index + 2} parentId`);
    return record;
  });
  return { header, records };
}

/** Capture data from Pi memory, not its writable v3 path. The JSONL string is immutable after return. */
export function captureTerminalPiForkSource(
  manager: TerminalPiForkSourceManager,
  selectedLeafId = manager.getLeafId(),
): DoomChildSessionTerminalPiForkSource | undefined {
  const sourceSessionId = manager.getSessionId();
  const sourceLeafId = selectedLeafId;
  const header = manager.getHeader();
  if (!sourceSessionId.trim() || !sourceLeafId || header?.type !== 'session' || header.version !== 3) return undefined;
  const branch = manager.getBranch(sourceLeafId);
  const lastEntry = branch.at(-1);
  if (lastEntry?.id !== sourceLeafId) return undefined;
  const snapshotJsonl = `${[header, ...branch].map((record) => JSON.stringify(record)).join('\n')}\n`;
  return Object.freeze({
    kind: 'terminal-pi-fork',
    sourceSessionId,
    sourceLeafId,
    snapshotJsonl,
  });
}

async function createChildJournal(
  request: DoomChildSessionRequest,
  source: DoomChildSessionTerminalPiForkSource,
  options: TerminalPiChildSessionServiceOptions,
  ownership: HistoryOwnership,
): Promise<string> {
  const parsed = parseSnapshot(source.snapshotJsonl);
  if (requireString(parsed.header.id, 'header id') !== source.sourceSessionId)
    throw new Error('Terminal Pi snapshot session identity does not match its sourceSessionId.');
  if (parsed.records.at(-1)?.id !== source.sourceLeafId)
    throw new Error('Terminal Pi snapshot leaf does not match its sourceLeafId.');

  const records = parseSessionEntries(source.snapshotJsonl).filter((entry) => entry.type !== 'session');
  if (records.length !== parsed.records.length) throw new Error('Terminal Pi snapshot contains invalid entries');
  const ids = new Set<string>();
  let parent: string | null = null;
  for (const record of records) {
    if (record.parentId !== parent || ids.has(record.id))
      throw new Error('Terminal Pi snapshot is not a selected branch');
    ids.add(record.id);
    parent = record.id;
  }
  const destination = await openSqliteSessionStorage(
    {
      sessionsRoot: path.resolve(options.sessionsRoot ?? path.join(getAgentDir(), 'server', 'sessions')),
      sessionId: randomUUID(),
      parentSessionId: request.parentSessionId || source.sourceSessionId,
      historyOwnership: ownership,
    },
    BACKGROUND_CONTEXT,
  );
  try {
    await destination.session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      const mapped = new Map<string, EntryId>();
      for (const [index, record] of records.entries()) {
        const tail =
          record.type === 'compaction'
            ? records
                .slice(
                  records.findIndex((entry) => entry.id === record.firstKeptEntryId),
                  index,
                )
                .flatMap((entry) => sessionEntryToContextMessages(entry))
            : [];
        const model = convertToLlm([...sessionEntryToContextMessages(record), ...tail]);
        const head = record.type === 'compaction' ? mapped.get(record.firstKeptEntryId) : undefined;
        if (record.type === 'compaction' && head === undefined)
          throw new Error('Terminal Pi snapshot compaction boundary is absent');
        const projected =
          record.type === 'message'
            ? { type: 'message', message: record.message, timestamp: Date.parse(record.timestamp) }
            : record.type === 'compaction'
              ? {
                  type: 'compaction',
                  summary: record.summary,
                  tokensBefore: record.tokensBefore,
                  retainedTail: tail,
                  fromHook: record.fromHook ?? false,
                }
              : record.type === 'branch_summary'
                ? {
                    type: 'branch_summary',
                    summary: record.summary,
                    fromId: record.fromId,
                    fromHook: record.fromHook ?? false,
                  }
                : { type: 'custom', ...fromPiSessionEntry(record) };
        const draft = {
          kind: 'doompi.entry',
          data: JSON.parse(JSON.stringify(projected)) as JsonValue,
          ...(model.length ? { model } : {}),
          ...(record.type === 'compaction' ? { head: 'self' as const } : {}),
        };
        const entry = await tx.appendEntry(conversation.id, draft);
        mapped.set(record.id, entry.id);
        if (record.type === 'model_change')
          (await tx.doc(AgentDoc, conversation.id)).model = { provider: record.provider, modelId: record.modelId };
        if (record.type === 'thinking_level_change') {
          if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(record.thinkingLevel))
            throw new Error('Invalid terminal Pi thinking level');
          (await tx.doc(AgentDoc, conversation.id)).thinkingLevel = record.thinkingLevel as NonNullable<
            Awaited<ReturnType<DirectHarnessRuntime['lane']['agent']>>['thinkingLevel']
          >;
        }
      }
      (await tx.doc(DurableNavigationDoc)).activeConversationId = conversation.id;
    }, BACKGROUND_CONTEXT);
    return destination.sessionFile;
  } catch (error) {
    fs.rmSync(destination.sessionFile, { force: true });
    throw error;
  } finally {
    await destination.session.close(BACKGROUND_CONTEXT);
    await destination.repository.close(BACKGROUND_CONTEXT);
    await destination.historyLease.release();
  }
}

export function createTerminalPiChildSessionService(
  options: TerminalPiChildSessionServiceOptions,
): DoomChildSessionService {
  const runtimeFactory = options.runtimeFactory ?? createDirectHarnessRuntime;
  const ownership = options.historyOwnership ?? createHistoryOwnership({ sourceFormat: 'sqlite' });
  const headlessOptions: HeadlessChildSessionServiceOptions = {
    parentSessionId: '',
    cwd: options.cwd,
    ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    ...(options.parentFastMode === undefined ? {} : { parentFastMode: options.parentFastMode }),
    ...(options.mcpTool === undefined ? {} : { mcpTool: options.mcpTool }),
    ...(options.subscribeMcpTool === undefined ? {} : { subscribeMcpTool: options.subscribeMcpTool }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    historyOwnership: ownership,
    ...(options.now === undefined ? {} : { now: options.now }),
    runtimeFactory,
  };
  const headless = createHeadlessChildSessionService(headlessOptions);
  const terminal = createDoomChildSessionService(
    async (request: DoomChildSessionRequest, signal): Promise<DoomChildSessionRuntime> => {
      signal?.throwIfAborted();
      if (request.source.kind !== 'terminal-pi-fork')
        throw new Error('Terminal Pi child sessions require terminal Pi fork sources.');
      const directRequestOptions = composeDirectHarnessRequestOptions(request, options.mcpTool);
      const fastMode = await options.parentFastMode?.();
      if (fastMode !== undefined && typeof fastMode !== 'boolean')
        throw new Error('Parent Fast mode must be a boolean.');
      const requestedModel = parseChildModelReference(request.model);
      const model = requestedModel?.model ?? options.defaultModel?.();
      const thinking = request.thinking ?? requestedModel?.thinking;
      const providers = resolveChildProviders(options.providers);
      const sessionPath = await createChildJournal(request, request.source, options, ownership);
      const runtimeOptions: DirectHarnessRuntimeOptions = {
        cwd: request.cwd || options.cwd,
        parentSessionId: request.parentSessionId,
        sessionPath,
        ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
        ...(options.models === undefined ? {} : { models: options.models }),
        ...(providers === undefined ? {} : { providers }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinkingLevel: thinking as never }),
        ...directRequestOptions,
        ...(fastMode === undefined ? {} : { initialFastMode: fastMode }),
        historyOwnership: ownership,
      };
      let runtime: DirectHarnessRuntime | undefined;
      let hooks: ReturnType<typeof bindChildHooks> | undefined;
      try {
        hooks = bindChildHooks(request, options.hooks?.(), () => runtime, signal);
        if (hooks.binding) {
          runtimeOptions.beforeTool = hooks.binding.beforeTool;
          runtimeOptions.afterTool = hooks.binding.afterTool;
        }
        runtime = await runtimeFactory(runtimeOptions);
        if (requestedModel && model) await runtime.setModel(model);
        if (thinking !== undefined) await runtime.setThinkingLevel(thinking as never);
        await installIntercom(runtime, request.intercom, (runtimeOptions.tools ?? []) as DirectHarnessTool[]);
        const releaseMcp = bindChildMcpCatalog(runtime, request, options, runtimeOptions.tools ?? []);
        const file = runtime.sessionFile;
        const releaseNative = typeof file === 'string' ? registerNativeChild(file, runtime) : undefined;
        return childRuntime(runtime, request.intercom, async () => {
          try {
            releaseMcp();
          } finally {
            try {
              releaseNative?.();
            } finally {
              await hooks?.dispose();
            }
          }
        });
      } catch (error) {
        let failure: unknown = error;
        try {
          await hooks?.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([failure, cleanupError], 'Terminal Pi child hook cleanup failed');
        }
        try {
          await runtime?.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([failure, cleanupError], 'Terminal Pi child startup cleanup failed');
        } finally {
          request.intercom?.dispose?.();
          fs.rmSync(sessionPath, { force: true });
        }
        throw failure;
      }
    },
    { now: options.now ?? Date.now },
  );
  const owners = new Map<string, DoomChildSessionService>();
  const service: DoomChildSessionService = {
    async start(request, signal) {
      const owner = request.source.kind === 'terminal-pi-fork' ? terminal : headless;
      const handle = await owner.start(request, signal);
      owners.set(request.runId, owner);
      return handle;
    },
    get: (runId) => owners.get(runId)?.get(runId) ?? terminal.get(runId) ?? headless.get(runId),
    readTranscriptPage(runId, request, signal) {
      const owner = owners.get(runId);
      if (!owner?.readTranscriptPage)
        return Promise.reject(new Error(`Child run '${runId}' has no readable transcript.`));
      return owner.readTranscriptPage(runId, request, signal);
    },
    close: async () => {
      const failures = await Promise.allSettled([terminal.close(), headless.close()]);
      owners.clear();
      const rejected = failures.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (rejected.length) throw new AggregateError(rejected, 'Terminal Pi child-session shutdown failed.');
    },
  };
  return service;
}

export interface TerminalPiChildSessionServiceProvider extends DoomChildSessionServiceProvider {
  close(): Promise<void>;
}

export function createTerminalPiChildSessionServiceProvider(
  options: TerminalPiChildSessionServiceOptions,
): TerminalPiChildSessionServiceProvider {
  const service = createTerminalPiChildSessionService(options);
  return { get: () => service, close: () => service.close() };
}
