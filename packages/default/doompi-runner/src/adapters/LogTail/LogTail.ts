import fs from 'node:fs';
import type { ILogTail, LogTailHandle, LogTailOptions } from '../../types/logTail.ts';

/** How often the tail restats the file; the same cadence the CLI's --follow uses. */
const POLL_MS = 250;

/**
 * Polling tail: read the delta between the last offset and the file's current
 * size, and hand back only complete lines.
 *
 * Same reliability posture as this package's runner watcher: the poll is the
 * mechanism, not an accelerator for a change notification. fs.watchFile only
 * fires when it observes a difference from a baseline it took itself, so a
 * write that lands before its first stat is a change it never reports; a
 * restat every tick has no such window.
 *
 * A write that lands mid-line is common, so the trailing fragment is held
 * until its newline arrives rather than emitted as a line that will change.
 */
export class LogTail implements ILogTail {
  follow(logPath: string, options: LogTailOptions): LogTailHandle {
    let offset = options.from;
    let pending = '';
    let closed = false;

    const drain = (size: number): void => {
      // A shrunken file was rotated or truncated; start over rather than
      // reading from an offset that now points into different content.
      if (size < offset) {
        offset = 0;
        pending = '';
      }
      if (size === offset) return;
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const descriptor = fs.openSync(logPath, 'r');
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
      } finally {
        fs.closeSync(descriptor);
      }
      offset = size;
      if (bytesRead <= 0) return;
      pending += buffer.subarray(0, bytesRead).toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.length > 0) options.onLines(lines);
    };

    const tick = (): void => {
      if (closed) return;
      try {
        drain(fs.statSync(logPath).size);
      } catch (error) {
        // The runner has not opened its log yet; the next tick settles it.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const timer = setInterval(tick, POLL_MS);
    // Following a log must never be the reason a process stays alive.
    timer.unref?.();
    return {
      close() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
      },
    };
  }
}
