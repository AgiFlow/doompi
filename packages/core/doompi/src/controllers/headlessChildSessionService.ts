import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { Models, MutableModels } from '@earendil-works/pi-ai';
import {
  createDoomChildSessionService,
  type DoomChildSessionIntercom,
  type DoomChildSessionRequest,
  type DoomChildSessionRuntime,
  type DoomChildSessionService,
  type DoomChildSessionServiceProvider,
} from '@agimon-ai/doompi-extension-contracts/child-session';
import { createHistoryOwnership } from '../services/historyOwnership';
import type { HistoryOwnership } from '../services/historyImport';
import { readNativeChildTranscript } from './nativeChildTranscriptReader';
import {
  createDirectHarnessRuntime,
  promptForAssistantText,
  type DirectHarnessRuntime,
  type DirectHarnessRuntimeOptions,
} from './directHarnessRuntime';
import type { DirectHarnessModel } from '../types/server/directHarnessRuntime';
import { registerNativeChild } from './nativeChildRuntimes';

export interface HeadlessChildSessionServiceOptions {
  readonly parentSessionId: string;
  readonly cwd: string;
  readonly sessionsRoot?: string;
  readonly models?: Models | MutableModels;
  readonly defaultModel?: () => DirectHarnessModel | undefined;
  readonly historyOwnership?: HistoryOwnership;
  readonly now?: () => number;
  readonly runtimeFactory?: (options: DirectHarnessRuntimeOptions) => Promise<DirectHarnessRuntime>;
}

export interface HeadlessChildSessionServiceProvider extends DoomChildSessionServiceProvider {
  close(): Promise<void>;
}

function modelReference(value: string | undefined): DirectHarnessModel | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Child model must use the provider/model form: ${value}`);
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function sessionFile(runtime: DirectHarnessRuntime): string | undefined {
  const metadata = runtime.session.metadata as unknown as { path?: unknown };
  return typeof metadata.path === 'string' ? metadata.path : undefined;
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
    ...(file === undefined ? {} : { readTranscriptPage: (request, signal) => readNativeChildTranscript(file, request, signal) }),
    prompt: (task) => promptForAssistantText(runtime, task),
    steer: (message) => runtime.steer(message),
    followUp: (message) => runtime.followUp(message),
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
  const adapted = {
    ...tool,
    parameters: tool.parameters as never,
    execute: (operationId: string, params: unknown, signal: AbortSignal, onUpdate: unknown) =>
      tool.execute(operationId, params, signal, onUpdate as never),
  } as unknown as DirectHarnessTool;
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

function adaptNativeTool(tool: NativeCodingTool): DirectHarnessTool {
  const prompt = tool as NativeCodingTool & {
    promptSnippet?: string;
    promptGuidelines?: string[];
  };
  return {
    ...prompt,
    parameters: tool.parameters as never,
    async execute(toolCallId, parameters, onUpdate, _toolContext, _invocation, context) {
      const execute = tool.execute as (
        id: string,
        params: unknown,
        signal: AbortSignal,
        update: (result: { content: unknown; details?: unknown }) => void,
      ) => Promise<{ content: unknown; details?: unknown }>;
      const result = await execute(
        toolCallId,
        parameters,
        context.abortSignal ?? new AbortController().signal,
        (partial) => onUpdate({ content: partial.content as never, details: partial.details }),
      );
      return { content: result.content as never, details: result.details };
    },
  };
}

/** Validate and project native fields before a source fork can publish a child journal. */
export function composeDirectHarnessRequestOptions(
  request: DoomChildSessionRequest,
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

  const requested = request.tools ?? Object.keys(NATIVE_TOOL_FACTORIES);
  const excluded = new Set(request.excludeTools ?? []);
  const allowed = request.capabilityCeiling?.allowedTools;
  const names = requested.filter((name) => !excluded.has(name) && (allowed === undefined || allowed.includes(name)));
  const unknown = names.filter((name) => !(name in NATIVE_TOOL_FACTORIES));
  if (unknown.length > 0)
    throw new Error(`Native child session requested unknown direct harness tools: ${unknown.join(', ')}`);
  const required = request.capabilityCeiling?.requiredTools ?? [];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0)
    throw new Error(`Native child session capability ceiling requires unavailable tools: ${missing.join(', ')}`);
  const tools = names.map((name) =>
    adaptNativeTool(NATIVE_TOOL_FACTORIES[name as keyof typeof NATIVE_TOOL_FACTORIES](request.cwd) as NativeCodingTool),
  );
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
): Promise<string> {
  const directory = path.dirname(path.resolve(sourcePath));
  const sourceRepository = new SqliteSessionRepo({
    directory,
    databasePath: sourcePath,
    databaseFactory: createNodeSqliteFactory(),
  });
  const sources = await sourceRepository.list(undefined, BACKGROUND_CONTEXT);
  await sourceRepository.close(BACKGROUND_CONTEXT);
  if (sources.length !== 1)
    throw new Error('Child source must be an existing SQLite session; import JSONL offline first.');
  const id = randomUUID();
  const destination = path.join(directory, `${id}.sqlite`);
  const lease = await ownership.acquire(destination);
  const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
  try {
    await lease.assertQuiescent();
    const fork = await repository.fork(
      sources[0]!,
      {
        scope: 'branch',
        branch,
        id,
        ...(entryId === undefined ? {} : { entryId }),
      },
      BACKGROUND_CONTEXT,
    );
    await fork.close(BACKGROUND_CONTEXT);
    return destination;
  } finally {
    try {
      await repository.close(BACKGROUND_CONTEXT);
    } finally {
      await lease.release();
    }
  }
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
      const directRequestOptions = composeDirectHarnessRequestOptions(request);

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
        );
      } else {
        sessionId = randomUUID();
      }

      const model = modelReference(request.model) ?? options.defaultModel?.();
      const runtimeOptions: DirectHarnessRuntimeOptions = {
        storage: 'sqlite',
        ...(request.source.kind === 'v4-fork' ? { lane: request.source.branch } : {}),
        cwd: request.cwd || options.cwd,
        ...(sessionId === undefined ? {} : { sessionId }),
        parentSessionId: request.parentSessionId || options.parentSessionId,
        ...(sessionPath === undefined ? {} : { sessionPath }),
        ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
        ...(options.models === undefined ? {} : { models: options.models }),
        ...(model === undefined ? {} : { model }),
        ...(request.thinking === undefined ? {} : { thinkingLevel: request.thinking as never }),
        ...directRequestOptions,
        historyOwnership: ownership,
      };

      let runtime: DirectHarnessRuntime | undefined;
      try {
        runtime = await runtimeFactory(runtimeOptions);
        await installIntercom(runtime, request.intercom, (runtimeOptions.tools ?? []) as DirectHarnessTool[]);
        const file = sessionFile(runtime);
        return childRuntime(runtime, request.intercom, file ? registerNativeChild(file, runtime) : undefined);
      } catch (error) {
        let failure: unknown = error;
        try {
          await runtime?.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], 'Headless child startup cleanup failed');
        } finally {
          request.intercom?.dispose?.();
          if (sessionPath !== undefined && request.source.kind === 'v4-fork')
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sessionPath + suffix, { force: true });
        }
        throw failure;
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

export type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from './directHarnessRuntime';
export type { DirectHarnessModel } from '../types/server/directHarnessRuntime';
