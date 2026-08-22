import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeAtomicJson } from '../../atomicJson';
import { DoomTeamExpectedError } from '../../../services/support/errors';
import { currentRunsDir } from '../../filesystem/paths';

const HASH_ALGORITHM = 'sha256';
const HASH_ENCODING = 'hex';

interface OperationRecord<TResult> {
  version: 1;
  operationId: string;
  argumentHash: string;
  runIds: string[];
  state: 'pending' | 'completed';
  createdAt: number;
  result?: TResult;
}

export type OperationStart<TResult> =
  | { kind: 'new'; record: OperationRecord<TResult> }
  | { kind: 'replay'; record: OperationRecord<TResult> };

function hashArguments(args: unknown): string {
  return createHash(HASH_ALGORITHM).update(JSON.stringify(args)).digest(HASH_ENCODING);
}

function journalPath(operationId: string): string {
  const safeId = createHash(HASH_ALGORITHM).update(operationId).digest(HASH_ENCODING);
  return path.join(path.dirname(currentRunsDir()), 'operations', `${safeId}.json`);
}

function readRecord<TResult>(file: string): OperationRecord<TResult> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OperationRecord<TResult>;
}

/** Persist replay identity and run ids before any side effect is started. */
export function startOperation<TResult>(operationId: string, args: unknown, runIds: string[]): OperationStart<TResult> {
  const file = journalPath(operationId);
  const argumentHash = hashArguments(args);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: OperationRecord<TResult> = {
    version: 1,
    operationId,
    argumentHash,
    runIds,
    state: 'pending',
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return { kind: 'new', record };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = readRecord<TResult>(file);
    if (existing.argumentHash !== argumentHash) {
      throw new DoomTeamExpectedError(
        'operation_conflict',
        `Operation '${operationId}' was already used with different arguments.`,
        false,
        'Submit the operation as a new tool call.',
      );
    }
    return { kind: 'replay', record: existing };
  }
}

export function completeOperation<TResult>(
  operationId: string,
  record: OperationRecord<TResult>,
  result: TResult,
): void {
  writeAtomicJson(journalPath(operationId), { ...record, state: 'completed', result });
}
