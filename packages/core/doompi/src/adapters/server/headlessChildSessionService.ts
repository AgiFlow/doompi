import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { JsonlSessionRepo, type Session } from '@earendil-works/pi-agent-core/harness/session';
import type { Models, MutableModels } from '@earendil-works/pi-ai';
import {
  createDoomChildSessionService,
  type DoomChildSessionIntercom,
  type DoomChildSessionRequest,
  type DoomChildSessionRuntime,
  type DoomChildSessionService,
  type DoomChildSessionServiceProvider,
} from '@agimon-ai/doompi-extension-contracts/child-session';
import { createHistoryCreationFileSystem } from '../serialization/historyCreationFileSystem.ts';
import { createHistoryOwnership } from '../serialization/historyOwnership.ts';
import type { HistoryOwnership, HistoryOwnershipLease } from '../serialization/historyImport.ts';
import {
  createDirectHarnessRuntime,
  readDirectHarnessSessionMetadata,
  type DirectHarnessRuntime,
  type DirectHarnessRuntimeOptions,
} from './directHarnessRuntime.ts';
import type { DirectHarnessModel } from '../../types/server/directHarnessRuntime.ts';

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

function childRuntime(runtime: DirectHarnessRuntime, intercom?: DoomChildSessionIntercom): DoomChildSessionRuntime {
  const file = sessionFile(runtime);
  return {
    sessionId: runtime.sessionId,
    ...(file === undefined ? {} : { sessionFile: file }),
    prompt: (task) => runtime.prompt(task),
    steer: (message) => runtime.steer(message),
    followUp: (message) => runtime.followUp(message),
    abort: () => runtime.abort(),
    dispose: async () => {
      try {
        await runtime.dispose();
      } finally {
        intercom?.dispose?.();
      }
    },
  };
}

type DirectHarnessTool = Parameters<DirectHarnessRuntime['replaceTools']>[0][number];

async function installIntercom(
  runtime: DirectHarnessRuntime,
  intercom: DoomChildSessionIntercom | undefined,
): Promise<void> {
  if (!intercom) return;
  const tool = intercom.bindRuntime(childRuntime(runtime));
  const adapted = {
    ...tool,
    parameters: tool.parameters as never,
    execute: (operationId: string, params: unknown, signal: AbortSignal, onUpdate: unknown) =>
      tool.execute(operationId, params, signal, onUpdate as never),
  } as unknown as DirectHarnessTool;
  await runtime.replaceTools([adapted]);
}

function hasConfiguredValues(value: readonly string[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

/** Validate native fields before a source fork can publish a child journal. */
export function composeDirectHarnessRequestOptions(
  request: DoomChildSessionRequest,
): Pick<DirectHarnessRuntimeOptions, 'systemPrompt'> {
  const unsupported = [
    ...(hasConfiguredValues(request.extensions) ? ['extensions'] : []),
    ...(hasConfiguredValues(request.subagentOnlyExtensions) ? ['subagentOnlyExtensions'] : []),
    ...(hasConfiguredValues(request.tools) ? ['tools'] : []),
    ...(hasConfiguredValues(request.excludeTools) ? ['excludeTools'] : []),
    ...(hasConfiguredValues(request.skills) ? ['skills'] : []),
    ...(hasConfiguredValues(request.mcpDirectTools) ? ['mcpDirectTools'] : []),
    ...(request.capabilityCeiling !== undefined && Object.keys(request.capabilityCeiling).length > 0
      ? ['capabilityCeiling']
      : []),
    ...(request.systemPromptMode === 'append' ? ['systemPromptMode'] : []),
  ];
  if (unsupported.length > 0) {
    throw new Error(
      `Native child session configuration is unsupported by the direct harness: ${unsupported.join(', ')}`,
    );
  }

  return request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt };
}

async function closeForkResources(
  forkSession: Session | undefined,
  repository: JsonlSessionRepo | undefined,
  environment: NodeExecutionEnv | undefined,
  leases: readonly HistoryOwnershipLease[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await forkSession?.close(BACKGROUND_CONTEXT);
  } catch (error) {
    failures.push(error);
  }
  try {
    await repository?.close(BACKGROUND_CONTEXT);
  } catch (error) {
    failures.push(error);
  }
  try {
    await environment?.cleanup(BACKGROUND_CONTEXT);
  } catch (error) {
    failures.push(error);
  }
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Headless child fork cleanup failed');
}

async function forkChildJournal(
  sourcePath: string,
  branch: string,
  entryId: string | undefined,
  ownership: HistoryOwnership,
): Promise<string> {
  const source = readDirectHarnessSessionMetadata(sourcePath);
  const sourceLease = await ownership.acquire(source.path);
  let destinationLease: HistoryOwnershipLease | undefined;
  let repository: JsonlSessionRepo | undefined;
  let environment: NodeExecutionEnv | undefined;
  let forkSession: Session | undefined;
  let destinationPath: string | undefined;
  let primaryFailure: unknown;
  try {
    await sourceLease.assertQuiescent();
    environment = new NodeExecutionEnv({ cwd: source.cwd });
    const fileSystem = createHistoryCreationFileSystem(environment, async (pathToOwn) => {
      destinationLease = await ownership.acquire(pathToOwn);
      try {
        await destinationLease.assertQuiescent();
      } catch (error) {
        await Promise.resolve(destinationLease.release()).catch(() => undefined);
        destinationLease = undefined;
        throw error;
      }
    });
    repository = new JsonlSessionRepo({
      fileSystem,
      sessionsRoot: path.dirname(path.dirname(source.path)),
      now: () => Date.now(),
    });
    forkSession = await repository.fork(
      source,
      {
        scope: 'branch',
        branch,
        ...(entryId === undefined ? {} : { entryId }),
        id: randomUUID(),
      },
      BACKGROUND_CONTEXT,
    );
    destinationPath = (forkSession.metadata as unknown as { path: string }).path;
  } catch (error) {
    primaryFailure = error;
  }

  try {
    await closeForkResources(forkSession, repository, environment, [
      sourceLease,
      ...(destinationLease === undefined ? [] : [destinationLease]),
    ]);
  } catch (error) {
    if (primaryFailure === undefined) primaryFailure = error;
    else primaryFailure = new AggregateError([primaryFailure, error], 'Headless child fork failed');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (destinationPath === undefined) throw new Error('Headless child fork did not create a destination journal');
  return destinationPath;
}

export function createHeadlessChildSessionService(
  options: HeadlessChildSessionServiceOptions,
): DoomChildSessionService {
  const runtimeFactory = options.runtimeFactory ?? createDirectHarnessRuntime;
  const ownership = options.historyOwnership ?? createHistoryOwnership();

  return createDoomChildSessionService(
    async (request: DoomChildSessionRequest, signal): Promise<DoomChildSessionRuntime> => {
      signal?.throwIfAborted();
      if (request.source.kind === 'terminal-pi-fork')
        throw new Error('Headless child sessions do not support terminal Pi sources.');
      const directRequestOptions = composeDirectHarnessRequestOptions(request);

      let sessionPath: string | undefined;
      let sessionId: string | undefined;
      if (request.source.kind === 'v4-restore') {
        sessionPath = readDirectHarnessSessionMetadata(request.source.sessionFile).path;
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
        await installIntercom(runtime, request.intercom);
        return childRuntime(runtime, request.intercom);
      } catch (error) {
        let failure: unknown = error;
        try {
          await runtime?.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], 'Headless child startup cleanup failed');
        } finally {
          request.intercom?.dispose?.();
          if (sessionPath !== undefined && request.source.kind === 'v4-fork') fs.rmSync(sessionPath, { force: true });
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

export type { DirectHarnessRuntime, DirectHarnessRuntimeOptions } from './directHarnessRuntime.ts';
export type { DirectHarnessModel } from '../../types/server/directHarnessRuntime.ts';
