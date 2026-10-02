import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models, MutableModels, Provider } from '@earendil-works/pi-ai';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import { createSession, AgentDoc, type Cursor, type EntryRecord, type EntryId } from '@earendil-works/pi-durable';

import {
  createDoomChildSessionService,
  type DoomChildSessionIntercom,
  type DoomChildSessionRequest,
  type DoomChildSessionRuntime,
  type DoomChildSessionService,
  type DoomChildSessionServiceProvider,
  type DoomChildSessionTool,
} from '../../../exports/childSession';
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
import {
  openReadOnlyDurableStorage,
  openSqliteSessionStorage,
  SessionMetadataDoc,
  SessionIdentityDoc,
} from '../../../services/sqliteSessionStorage';
import type { DirectHarnessModel } from '../../../types/server/directHarnessRuntime';
import { registerNativeChild } from './nativeChildRuntimes';

export interface HeadlessChildSessionServiceOptions {
  readonly parentSessionId: string;
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
  /** Resolve the current session's MCP dispatcher at spawn and invocation time. */
  readonly mcpTool?: () => DoomChildSessionTool | undefined;
  readonly historyOwnership?: HistoryOwnership;
  readonly now?: () => number;
  readonly runtimeFactory?: (options: DirectHarnessRuntimeOptions) => Promise<DirectHarnessRuntime>;
}

export interface HeadlessChildSessionServiceProvider extends DoomChildSessionServiceProvider {
  close(): Promise<void>;
}

const THINKING_SUFFIX_PATTERN = /:(off|minimal|low|medium|high|xhigh|max)$/;

export interface ParsedChildModel {
  readonly model: DirectHarnessModel;
  readonly thinking?: string;
}

/**
 * Child model specs may carry a Pi thinking suffix, for example
 * `anthropic-vertex/claude-sonnet-5:medium`. The suffix is a request option and
 * never part of the model id, so it has to be split off before model lookup.
 */
export function parseChildModelReference(value: string | undefined): ParsedChildModel | undefined {
  if (value === undefined) return undefined;
  const suffix = THINKING_SUFFIX_PATTERN.exec(value);
  const reference = suffix === null ? value : value.slice(0, value.length - suffix[0].length);
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1)
    throw new Error(`Child model must use the provider/model form: ${value}`);
  return {
    model: { provider: reference.slice(0, separator), id: reference.slice(separator + 1) },
    ...(suffix === null ? {} : { thinking: suffix[1] as string }),
  };
}

/** Resolve the provider set for one spawn, tolerating both a fixed array and a thunk. */
export function resolveChildProviders(
  providers: readonly Provider[] | (() => readonly Provider[]) | undefined,
): readonly Provider[] | undefined {
  const resolved = typeof providers === 'function' ? providers() : providers;
  return resolved === undefined || resolved.length === 0 ? undefined : resolved;
}

function sessionFile(runtime: DirectHarnessRuntime): string | undefined {
  return runtime.sessionFile;
}

function childRuntime(
  runtime: DirectHarnessRuntime,
  intercom?: DoomChildSessionIntercom,
  release?: () => void,
): DoomChildSessionRuntime {
  const file = sessionFile(runtime);
  return {
    sessionId: runtime.sessionId,
    ...(file === undefined ? {} : { sessionFile: file }),
    ...(file === undefined
      ? {}
      : { readTranscriptPage: (request, signal) => readNativeChildTranscript(file, request, signal) }),
    prompt: (task) => promptForAssistantText(runtime, task),
    steer: (message) => runtime.steer(message),
    followUp: (message) => runtime.followUp(message),
    onUsage(listener) {
      return runtime.onEvent((event) => {
        if (event.type !== 'usage') return;
        listener({ rowId: event.row.id, cost: event.row.usage.cost.total });
      });
    },
    abort: () => runtime.abort(),
    dispose: async () => {
      try {
        await runtime.dispose();
      } finally {
        release?.();
        intercom?.dispose?.();
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
  const adapted: DirectHarnessTool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    execute: async (operationId, params, onUpdate, _toolContext, _invocation, context) => {
      const result = await tool.execute(
        operationId,
        params,
        context.abortSignal ?? new AbortController().signal,
        (partial) => onUpdate({ content: partial.content as never, details: partial.details }),
      );
      return { content: result.content as never, details: result.details, isError: result.isError };
    },
  };
  await runtime.replaceTools([...tools, adapted]);
}

function hasConfiguredValues(value: readonly string[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

const NATIVE_TOOL_FACTORIES = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
} as const;

type NativeCodingTool = ReturnType<(typeof NATIVE_TOOL_FACTORIES)[keyof typeof NATIVE_TOOL_FACTORIES]>;

function adaptNativeTool(tool: NativeCodingTool | DoomChildSessionTool): DirectHarnessTool {
  const prompt = tool as (NativeCodingTool | DoomChildSessionTool) & {
    promptSnippet?: string;
    promptGuidelines?: string[];
    executionMode?: string;
  };
  return {
    name: prompt.name,
    description: prompt.description,
    ...(prompt.executionMode === 'parallel' || prompt.executionMode === 'sequential'
      ? { executionMode: prompt.executionMode }
      : {}),
    label: 'label' in tool ? tool.label : tool.name,
    parameters: tool.parameters as never,
    ...('prepareArguments' in tool && typeof tool.prepareArguments === 'function'
      ? { prepareArguments: (args: unknown) => tool.prepareArguments!(args) as never }
      : {}),
    async execute(toolCallId, parameters, onUpdate, _toolContext, _invocation, context) {
      const execute = tool.execute as (
        id: string,
        params: unknown,
        signal: AbortSignal,
        update: (result: { content: unknown; details?: unknown }) => void,
      ) => Promise<{ content: unknown; details?: unknown; isError?: boolean }>;
      const result = await execute(
        toolCallId,
        parameters,
        context.abortSignal ?? new AbortController().signal,
        (partial) => onUpdate({ content: partial.content as never, details: partial.details }),
      );
      if (result.isError) {
        const content = result.content as DoomChildSessionToolResultContent;
        throw new Error(
          content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n') || 'MCP tool failed.',
        );
      }
      return { content: result.content as never, details: result.details };
    },
  };
}

type DoomChildSessionToolResultContent = Awaited<ReturnType<DoomChildSessionTool['execute']>>['content'];

/** Validate and project native fields before a source fork can publish a child journal. */
export function composeDirectHarnessRequestOptions(
  request: DoomChildSessionRequest,
  resolveMcpTool?: () => DoomChildSessionTool | undefined,
): Pick<DirectHarnessRuntimeOptions, 'systemPrompt' | 'tools' | 'activeToolNames'> {
  const unsupported = [
    ...(hasConfiguredValues(request.extensions) ? ['extensions'] : []),
    ...(hasConfiguredValues(request.subagentOnlyExtensions) ? ['subagentOnlyExtensions'] : []),
    ...(hasConfiguredValues(request.mcpDirectTools) ? ['mcpDirectTools'] : []),
    ...(hasConfiguredValues(request.capabilityCeiling?.allowedExternalProfiles) ? ['allowedExternalProfiles'] : []),
  ];
  if (unsupported.length > 0) {
    throw new Error(
      `Native child session configuration is unsupported by the direct harness: ${unsupported.join(', ')}`,
    );
  }

  const requested = [...new Set(request.tools ?? Object.keys(NATIVE_TOOL_FACTORIES))];
  const excluded = new Set(request.excludeTools ?? []);
  const allowed = request.capabilityCeiling?.allowedTools;
  const isMcp = (name: string) => name === 'mcp' || name === 'mcp_use';
  const mcpDenied = request.capabilityCeiling?.allowMcpTools === false || [...excluded].some(isMcp);
  const names = requested.filter(
    (name) => !excluded.has(name) && (allowed === undefined || allowed.includes(name)) && !(isMcp(name) && mcpDenied),
  );
  const unknown = names.filter((name) => !Object.hasOwn(NATIVE_TOOL_FACTORIES, name) && !isMcp(name));
  if (unknown.length > 0)
    throw new Error(`Native child session requested unknown direct harness tools: ${unknown.join(', ')}`);
  const required = request.capabilityCeiling?.requiredTools ?? [];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0)
    throw new Error(`Native child session capability ceiling requires unavailable tools: ${missing.join(', ')}`);
  const mcpTool = names.some(isMcp) ? resolveMcpTool?.() : undefined;
  if (names.some(isMcp) && !mcpTool)
    throw new Error('Native child session MCP tools are unavailable. Enable MCP in the parent session.');
  const tools = names.map((name) => {
    if (!isMcp(name))
      return adaptNativeTool(
        NATIVE_TOOL_FACTORIES[name as keyof typeof NATIVE_TOOL_FACTORIES](request.cwd) as NativeCodingTool,
      );
    return adaptNativeTool({
      ...mcpTool!,
      name,
      execute(toolCallId, parameters, signal, onUpdate) {
        signal?.throwIfAborted();
        if (resolveMcpTool?.() !== mcpTool)
          throw new Error('The parent session MCP dispatcher is no longer available.');
        return mcpTool!.execute(toolCallId, parameters, signal, onUpdate);
      },
    } satisfies DoomChildSessionTool);
  });
  return {
    tools,
    activeToolNames: names,
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
  };
}

async function forkChildJournal(
  sourcePath: string,
  branch: string,
  entryId: string | undefined,
  ownership: HistoryOwnership,
  parentSessionId?: string,
): Promise<string> {
  const source = await openReadOnlyDurableStorage(sourcePath);
  const read = createSession(source);
  let destination: Awaited<ReturnType<typeof openSqliteSessionStorage>> | undefined;
  const failures: unknown[] = [];
  try {
    const navigation = await read.snapshot(DurableNavigationDoc, BACKGROUND_CONTEXT);
    const selected = navigation?.activeConversationId;
    if (selected === null || selected === undefined) throw new Error('Child source has no active conversation');
    const metadata = await read.snapshot(SessionMetadataDoc, BACKGROUND_CONTEXT);
    if (branch !== (metadata?.laneName ?? 'main')) throw new Error('Child source lane does not exist');
    const cutoff = entryId === undefined ? undefined : (Number(entryId) as EntryId);
    if (
      entryId !== undefined &&
      (!Number.isSafeInteger(cutoff) || !(await source.entry(selected, cutoff!, BACKGROUND_CONTEXT)))
    )
      throw new Error('Child fork entry is not visible in its source conversation');
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await source.scanEntries(
        { conversationId: selected, ...(cutoff === undefined ? {} : { maxEntryId: cutoff }) },
        256,
        cursor,
        BACKGROUND_CONTEXT,
      );
      records.push(...page.items);
      cursor = page.next;
    } while (cursor);
    records.reverse();
    const agent =
      cutoff === undefined
        ? await read.snapshot(AgentDoc, selected, BACKGROUND_CONTEXT)
        : await read.snapshotAsOf(AgentDoc, selected, cutoff, BACKGROUND_CONTEXT);
    destination = await openSqliteSessionStorage(
      {
        sessionsRoot: path.dirname(path.dirname(path.resolve(sourcePath))),
        sessionId: randomUUID(),
        parentSessionId: parentSessionId ?? (await read.snapshot(SessionIdentityDoc, BACKGROUND_CONTEXT))?.id,
        historyOwnership: ownership,
      },
      BACKGROUND_CONTEXT,
    );
    await destination.session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      if (agent) Object.assign(await tx.doc(AgentDoc, conversation.id), agent);
      (await tx.doc(SessionMetadataDoc)).laneName = branch;
      const ids = new Map<number, EntryId>();
      for (const entry of records) {
        const { id: _id, conversationId: _conversation, byTaskId: _task, head, edits, ...draft } = entry;
        const appended = await tx.appendEntry(conversation.id, {
          ...draft,
          ...(head === undefined ? {} : { head: head === entry.id ? 'self' : ids.get(head) }),
          ...(edits === undefined
            ? {}
            : {
                edits: edits.map((edit) => {
                  const target = ids.get(edit.target);
                  if (target === undefined) throw new Error('Invalid fork context edit');
                  return { ...edit, target };
                }),
              }),
        });
        ids.set(entry.id, appended.id);
      }
      (await tx.doc(DurableNavigationDoc)).activeConversationId = conversation.id;
    }, BACKGROUND_CONTEXT);
  } catch (error) {
    failures.push(error);
  }
  try {
    await read.close(BACKGROUND_CONTEXT);
  } catch (error) {
    failures.push(error);
  }
  if (destination) {
    try {
      await destination.session.close(BACKGROUND_CONTEXT);
      await destination.historyLease.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Child fork cleanup failed');
  if (!destination) throw new Error('Child fork failed');
  return destination.sessionFile;
}

export function createHeadlessChildSessionService(
  options: HeadlessChildSessionServiceOptions,
): DoomChildSessionService {
  const runtimeFactory = options.runtimeFactory ?? createDirectHarnessRuntime;
  const ownership = options.historyOwnership ?? createHistoryOwnership({ sourceFormat: 'sqlite' });

  return createDoomChildSessionService(
    async (request: DoomChildSessionRequest, signal): Promise<DoomChildSessionRuntime> => {
      signal?.throwIfAborted();
      if (request.source.kind === 'terminal-pi-fork')
        throw new Error('Headless child sessions do not support terminal Pi sources.');
      const directRequestOptions = composeDirectHarnessRequestOptions(request, options.mcpTool);
      const fastMode = await options.parentFastMode?.();
      if (fastMode !== undefined && typeof fastMode !== 'boolean')
        throw new Error('Parent Fast mode must be a boolean.');

      let sessionPath: string | undefined;
      let sessionId: string | undefined;
      if (request.source.kind === 'v4-restore') {
        sessionPath = path.resolve(request.source.sessionFile);
        if (path.extname(sessionPath) !== '.sqlite')
          throw new Error('Server child restore requires SQLite; import JSONL offline first.');
      } else if (request.source.kind === 'v4-fork') {
        sessionPath = await forkChildJournal(
          request.source.sessionFile,
          request.source.branch,
          request.source.entryId,
          ownership,
          request.parentSessionId || options.parentSessionId,
        );
      } else {
        sessionId = randomUUID();
      }

      const requestedModel = parseChildModelReference(request.model);
      const model = requestedModel?.model ?? options.defaultModel?.();
      const thinking = request.thinking ?? requestedModel?.thinking;
      const providers = resolveChildProviders(options.providers);
      const runtimeOptions: DirectHarnessRuntimeOptions = {
        storage: 'sqlite',
        ...(request.source.kind === 'v4-fork' ? { lane: request.source.branch } : {}),
        cwd: request.cwd || options.cwd,
        ...(sessionId === undefined ? {} : { sessionId }),
        parentSessionId: request.parentSessionId || options.parentSessionId,
        ...(sessionPath === undefined ? {} : { sessionPath }),
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
      try {
        runtime = await runtimeFactory(runtimeOptions);
        if (requestedModel && model) await runtime.setModel(model);
        if (thinking !== undefined) await runtime.setThinkingLevel(thinking as never);
        await installIntercom(runtime, request.intercom, (runtimeOptions.tools ?? []) as DirectHarnessTool[]);
        const file = sessionFile(runtime);
        return childRuntime(runtime, request.intercom, file ? registerNativeChild(file, runtime) : undefined);
      } catch (error) {
        const failures: unknown[] = [error];
        let closed = false;
        try {
          if (runtime) {
            await runtime.dispose();
            closed = true;
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        try {
          request.intercom?.dispose?.();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        // A rejected factory may have failed its own writer cleanup, so retain that fork.
        if (closed && sessionPath !== undefined && request.source.kind === 'v4-fork') {
          try {
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sessionPath + suffix, { force: true });
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        if (failures.length > 1) throw new AggregateError(failures, 'Headless child startup cleanup failed');
        throw error;
      }
    },
    { now: options.now ?? Date.now },
  );
}

export function createHeadlessChildSessionServiceProvider(
  options: HeadlessChildSessionServiceOptions,
): HeadlessChildSessionServiceProvider {
  const service = createHeadlessChildSessionService(options);
  return {
    get: () => service,
    close: () => service.close(),
  };
}

export type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from '../../../server/directHarnessRuntime';
export type { DirectHarnessModel } from '../../../types/server/directHarnessRuntime';
