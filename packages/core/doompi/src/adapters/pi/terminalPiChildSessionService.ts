import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Models, MutableModels, Provider } from '@earendil-works/pi-ai';
import {
  createDoomChildSessionService,
  type DoomChildSessionIntercom,
  type DoomChildSessionRuntime,
  type DoomChildSessionService,
  type DoomChildSessionServiceProvider,
  type DoomChildSessionTerminalPiForkSource,
  type DoomChildSessionRequest,
} from '@agimon-ai/doompi-extension-contracts/child-session';
import { importV3WithPinnedUpstream } from '../serialization/jsonlSessionRepo.ts';
import type { HistoryOwnership, HistoryOwnershipLease } from '../serialization/historyImport.ts';
import { createHistoryOwnership } from '../serialization/historyOwnership.ts';
import {
  createDirectHarnessRuntime,
  type DirectHarnessRuntime,
  type DirectHarnessRuntimeOptions,
} from '../server/directHarnessRuntime.ts';
import {
  composeDirectHarnessRequestOptions,
  createHeadlessChildSessionService,
  type HeadlessChildSessionServiceOptions,
} from '../server/headlessChildSessionService.ts';
import type { DirectHarnessModel } from '../../types/server/directHarnessRuntime.ts';

export interface TerminalPiChildSessionServiceOptions {
  readonly cwd: string;
  readonly sessionsRoot?: string;
  readonly models?: Models | MutableModels;
  readonly providers?: readonly Provider[];
  readonly defaultModel?: () => DirectHarnessModel | undefined;
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

function childRuntime(runtime: DirectHarnessRuntime, intercom?: DoomChildSessionIntercom): DoomChildSessionRuntime {
  const file = (runtime.session.metadata as unknown as { path?: unknown }).path;
  return {
    sessionId: runtime.sessionId,
    ...(typeof file === 'string' ? { sessionFile: file } : {}),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid terminal Pi snapshot ${field}`);
  return value;
}

function modelReference(value: string | undefined): DirectHarnessModel | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`Child model must use the provider/model form: ${value}`);
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
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

function sourceIdentity(filePath: string): {
  path: string;
  realPath: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  sha256: string;
} {
  const content = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    realPath: fs.realpathSync(filePath),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function rewriteImportedHeader(filePath: string, request: DoomChildSessionRequest, sourceSessionId: string): void {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const header = asRecord(JSON.parse(lines[0] ?? ''));
  if (header?.kind !== 'header' || header.v !== 4)
    throw new Error('Terminal Pi child journal import did not produce a v4 JSONL file.');
  header.id = randomUUID();
  header.cwd = request.cwd;
  header.parentSessionId = request.parentSessionId || sourceSessionId;
  delete header.legacyParentSessionPath;
  lines[0] = JSON.stringify(header);
  fs.writeFileSync(filePath, lines.join('\n'));
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-terminal-pi-fork-'));
  const sourcePath = path.join(root, 'snapshot.jsonl');
  fs.writeFileSync(sourcePath, source.snapshotJsonl, { mode: 0o600 });
  const sessionsRoot = path.resolve(options.sessionsRoot ?? path.join(getAgentDir(), 'sessions'));
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const destinationPath = path.join(sessionsRoot, `${Date.now()}-${randomUUID()}.jsonl`);
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);

  let destinationLease: HistoryOwnershipLease | undefined;
  let primaryFailure: unknown;
  try {
    destinationLease = await ownership.acquire(destinationPath);
    await destinationLease.assertQuiescent();
    await importV3WithPinnedUpstream({
      sourcePath,
      stagingPath: destinationPath,
      originalPath: sourcePath,
      sourceIdentity: sourceIdentity(sourcePath),
    });
    rewriteImportedHeader(destinationPath, request, source.sourceSessionId);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await destinationLease?.release();
  } catch (error) {
    primaryFailure = primaryFailure === undefined ? error : new AggregateError([primaryFailure, error]);
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (primaryFailure !== undefined) {
    fs.rmSync(destinationPath, { force: true });
    throw primaryFailure;
  }
  return destinationPath;
}

export function createTerminalPiChildSessionService(
  options: TerminalPiChildSessionServiceOptions,
): DoomChildSessionService {
  const runtimeFactory = options.runtimeFactory ?? createDirectHarnessRuntime;
  const ownership = options.historyOwnership ?? createHistoryOwnership();
  const headlessOptions: HeadlessChildSessionServiceOptions = {
    parentSessionId: '',
    cwd: options.cwd,
    ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
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
      const directRequestOptions = composeDirectHarnessRequestOptions(request);
      const model = modelReference(request.model) ?? options.defaultModel?.();
      const sessionPath = await createChildJournal(request, request.source, options, ownership);
      const runtimeOptions: DirectHarnessRuntimeOptions = {
        cwd: request.cwd || options.cwd,
        parentSessionId: request.parentSessionId,
        sessionPath,
        ...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
        ...(options.models === undefined ? {} : { models: options.models }),
        ...(options.providers === undefined ? {} : { providers: options.providers }),
        ...(model === undefined ? {} : { model }),
        ...(request.thinking === undefined ? {} : { thinkingLevel: request.thinking as never }),
        ...directRequestOptions,
        historyOwnership: ownership,
      };
      let runtime: DirectHarnessRuntime | undefined;
      try {
        runtime = await runtimeFactory(runtimeOptions);
        await installIntercom(runtime, request.intercom, (runtimeOptions.tools ?? []) as DirectHarnessTool[]);
        return childRuntime(runtime, request.intercom);
      } catch (error) {
        let failure: unknown = error;
        try {
          await runtime?.dispose();
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], 'Terminal Pi child startup cleanup failed');
        } finally {
          request.intercom?.dispose?.();
          fs.rmSync(sessionPath, { force: true });
        }
        throw failure;
      }
    },
    { now: options.now ?? Date.now },
  );
  const service: DoomChildSessionService = {
    start: (request, signal) =>
      request.source.kind === 'terminal-pi-fork' ? terminal.start(request, signal) : headless.start(request, signal),
    get: (runId) => terminal.get(runId) ?? headless.get(runId),
    close: async () => {
      const failures = await Promise.allSettled([terminal.close(), headless.close()]);
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
