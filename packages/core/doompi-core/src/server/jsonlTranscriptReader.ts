import type { TranscriptPage, TranscriptPageRequest } from '../exports/sessionProtocol';

/** Retained legacy entrypoint; fresh durable storage never reads JSONL journals. */
export async function readJsonlTranscript(
  _file: string,
  _request: Omit<TranscriptPageRequest, 'threadId'>,
): Promise<TranscriptPage> {
  throw new Error('Legacy JSONL transcripts are unsupported by fresh durable storage');
}
