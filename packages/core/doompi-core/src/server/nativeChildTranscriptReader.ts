import path from 'node:path';

import type { TranscriptPage, TranscriptPageRequest } from '../exports/sessionProtocol';
import { DURABLE_BACKGROUND_CONTEXT as BACKGROUND_CONTEXT, DURABLE_DIRECTORY } from '../services/sqliteSessionStorage';
import { readSqliteTranscript } from '../services/sqliteTranscriptReader';
import { nativeChildRuntime } from '../systems/child/adapters/nativeChildRuntimes';

/** Dispatches an already-authorized child journal to its live runtime or completed read-only backend. */
export async function readNativeChildTranscript(
  file: string,
  request: Omit<TranscriptPageRequest, 'threadId'>,
  signal?: AbortSignal,
): Promise<TranscriptPage> {
  signal?.throwIfAborted();
  if (path.extname(file) !== '.sqlite' || path.basename(path.dirname(file)) !== DURABLE_DIRECTORY)
    throw new Error('Legacy child transcripts are unsupported by fresh durable storage');
  const runtime = nativeChildRuntime(file);
  const page = runtime
    ? await runtime.readTranscriptPage(request, BACKGROUND_CONTEXT)
    : await readSqliteTranscript(file, request, BACKGROUND_CONTEXT);
  signal?.throwIfAborted();
  return page;
}
