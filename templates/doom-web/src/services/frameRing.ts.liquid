import type { SessionFrame } from '../types/session.ts';

const DEFAULT_RING_LIMIT = 512;

/**
 * Bounded history of one session's frame stream.
 *
 * The unix-socket backlog only fills while nothing is attached, and the hub is
 * always attached, so a page that connects later would otherwise start blind.
 * The ring is what a subscribe replays; it mirrors the server backlog's
 * semantics, dropping the oldest frames past the limit and counting the loss.
 */
export interface FrameRing {
  record(frame: SessionFrame): void;
  snapshot(): { frames: SessionFrame[]; dropped: number };
}

export function createFrameRing(limit = DEFAULT_RING_LIMIT): FrameRing {
  const frames: SessionFrame[] = [];
  let dropped = 0;
  return {
    record(frame) {
      frames.push(frame);
      if (frames.length > limit) {
        frames.shift();
        dropped += 1;
      }
    },
    snapshot() {
      return { frames: [...frames], dropped };
    },
  };
}
