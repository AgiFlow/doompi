import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AsyncRunStatus } from './runs/background/asyncExecution';
import { STATUS_FILE_NAME } from './runs/background/statusWriter';
import { currentRunsDir } from './filesystem/paths';

export type StatusReadFailure =
  | { kind: 'missing'; path: string }
  | { kind: 'malformed'; path: string; message: string }
  | { kind: 'incompatible'; path: string; version: unknown }
  | { kind: 'io_error'; path: string; message: string };

export type StatusReadResult = { kind: 'ok'; path: string; status: AsyncRunStatus } | StatusReadFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAsyncRunStatus(raw: string, statusPath = '<memory>'): StatusReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'malformed', path: statusPath, message: error instanceof Error ? error.message : String(error) };
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.runId !== 'string' ||
    typeof parsed.agent !== 'string' ||
    typeof parsed.state !== 'string'
  ) {
    return { kind: 'malformed', path: statusPath, message: 'Expected runId, agent and state fields.' };
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    return { kind: 'incompatible', path: statusPath, version: parsed.version };
  }

  // Read-only compatibility for statuses created before the canonical state
  // name was adopted. New writers emit only `completed`.
  if (parsed.state === 'complete') parsed.state = 'completed';
  if (typeof parsed.reason === 'string' && parsed.attentionReason === undefined) {
    parsed.attentionReason = parsed.reason;
  }
  return { kind: 'ok', path: statusPath, status: parsed as unknown as AsyncRunStatus };
}

/** Canonical status reader. It preserves the reason a status could not be read. */
export function readAsyncRunStatusResultAt(statusPath: string): StatusReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(statusPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { kind: 'missing', path: statusPath };
    return { kind: 'io_error', path: statusPath, message: error instanceof Error ? error.message : String(error) };
  }
  return parseAsyncRunStatus(raw, statusPath);
}

export async function readAsyncRunStatusResultAtAsync(statusPath: string): Promise<StatusReadResult> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(statusPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', path: statusPath };
    }
    return { kind: 'io_error', path: statusPath, message: error instanceof Error ? error.message : String(error) };
  }
  return parseAsyncRunStatus(raw, statusPath);
}

export function readAsyncRunStatusResult(runId: string): StatusReadResult {
  return readAsyncRunStatusResultAt(path.join(currentRunsDir(), runId, STATUS_FILE_NAME));
}

export function readAsyncRunStatusResultAsync(runId: string): Promise<StatusReadResult> {
  return readAsyncRunStatusResultAtAsync(path.join(currentRunsDir(), runId, STATUS_FILE_NAME));
}

/** Compatibility convenience for callers that intentionally treat all read failures as absence. */
export function readAsyncRunStatus(runId: string): AsyncRunStatus | undefined {
  const result = readAsyncRunStatusResult(runId);
  return result.kind === 'ok' ? result.status : undefined;
}

export function readAsyncRunStatusAt(statusPath: string): AsyncRunStatus | undefined {
  const result = readAsyncRunStatusResultAt(statusPath);
  return result.kind === 'ok' ? result.status : undefined;
}

export async function readAsyncRunStatusAtAsync(statusPath: string): Promise<AsyncRunStatus | undefined> {
  const result = await readAsyncRunStatusResultAtAsync(statusPath);
  return result.kind === 'ok' ? result.status : undefined;
}
