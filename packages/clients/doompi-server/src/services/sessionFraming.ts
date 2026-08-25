import type { SessionFrame } from '../types/session.ts';

const NEWLINE = '\n';

/**
 * Splits a byte stream into newline-delimited JSON frames.
 *
 * Stateful across chunks because a socket read can land mid-frame, which is
 * the normal case for streamed agent output rather than an edge case.
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

/**
 * Holds frames emitted while no client is attached.
 *
 * Bounded on purpose: an unattended session must not grow memory without
 * limit. Dropping the oldest frames keeps the newest state, and the count of
 * what was lost travels with the replay so a client can say so.
 */
export interface DetachedBacklog {
  record(frame: SessionFrame): void;
  drain(): { frames: SessionFrame[]; dropped: number };
  /** How many frames are waiting for the next client. */
  readonly held: number;
}

export function createDetachedBacklog(limit: number): DetachedBacklog {
  let frames: SessionFrame[] = [];
  let dropped = 0;
  return {
    get held() {
      return frames.length;
    },
    record(frame) {
      frames.push(frame);
      if (frames.length > limit) {
        frames = frames.slice(frames.length - limit);
        dropped += 1;
      }
    },
    drain() {
      const drained = { frames, dropped };
      frames = [];
      dropped = 0;
      return drained;
    },
  };
}
