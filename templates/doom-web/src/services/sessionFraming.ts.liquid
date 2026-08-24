import type { SessionFrame } from '../types/session.ts';

const NEWLINE = '\n';

/**
 * Splits a byte stream into newline-delimited JSON frames.
 *
 * Stateful across chunks because a socket read can land mid-frame, which is the
 * normal case for streamed agent output rather than an edge case.
 */
export function createFrameDecoder(): (chunk: string) => SessionFrame[] {
  let buffered = '';
  return (chunk: string): SessionFrame[] => {
    buffered += chunk;
    const parts = buffered.split(NEWLINE);
    buffered = parts.pop() ?? '';
    const frames: SessionFrame[] = [];
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        frames.push(parsed as SessionFrame);
      }
    }
    return frames;
  };
}

export function encodeFrame(frame: SessionFrame): string {
  return `${JSON.stringify(frame)}${NEWLINE}`;
}
