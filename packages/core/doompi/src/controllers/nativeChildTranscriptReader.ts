import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { TranscriptPage, TranscriptPageRequest } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { readSqliteTranscript } from '../services/sqliteTranscriptReader';
import { readJsonlTranscript } from './jsonlTranscriptReader';
import { nativeChildRuntime } from './nativeChildRuntimes';

/** Dispatches an already-authorized child journal to its live runtime or completed read-only backend. */
export async function readNativeChildTranscript(
  file: string,
  request: Omit<TranscriptPageRequest, 'threadId'>,
  signal?: AbortSignal,
): Promise<TranscriptPage> {
  signal?.throwIfAborted();
  const runtime = nativeChildRuntime(file);
  const page = runtime
    ? await runtime.readTranscriptPage(request, BACKGROUND_CONTEXT)
    : path.extname(file) === '.sqlite'
      ? await readSqliteTranscript(file, request, BACKGROUND_CONTEXT)
      : path.extname(file) === '.jsonl'
        ? await readJsonlTranscript(file, request)
        : await Promise.reject(new Error('Unsupported child transcript format'));
  signal?.throwIfAborted();
  return page;
}
