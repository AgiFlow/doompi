import { ansiSpans } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import { fetchRunnerLog, followRunnerLog, type RunnerLogFollow } from './logApi.ts';

/**
 * The newest line a running runner has written, for a row that has one line to
 * spend.
 *
 * The dock answers "what is happening", and a command that has not changed
 * since it started answers "what was asked". The last line of the log is the
 * closest thing to progress the cockpit can show without opening the log, so a
 * row that is still running trades its command for it.
 *
 * The line comes from the same two calls the log panel makes: read the tail,
 * then follow the stream from exactly where that read ended. Nothing new goes
 * on the wire, and a runner nobody is looking at is not followed, because the
 * stream lives and dies with the row.
 */

/** Enough lines that a trailing blank, or a final progress redraw, is not the whole answer. */
const TAIL_REQUEST_LINES = 5;

/**
 * The last line worth showing, as plain text.
 *
 * Blank lines are skipped, because a log that ends with a newline would
 * otherwise report nothing at all. Colour is dropped rather than rendered: the
 * row is nine pixels of faint text beside a name and a stop control, and a
 * green tick from someone else's palette in the middle of it reads as damage.
 */
export function plainTailLine(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = ansiSpans(lines[index] ?? '')
      .map((span) => span.text)
      .join('')
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * The newest log line of a running runner, or undefined for a runner that is
 * finished, unreachable, or has not written anything yet. The caller decides
 * what to show instead; this hook never invents a placeholder.
 */
export function useRunnerTail(sessionId: string | null, runId: string, running: boolean): string | undefined {
  // Kept with the run it belongs to, so a row that is reused for another
  // runner shows nothing rather than the previous runner's output.
  const [tail, setTail] = useState<{ runId: string; text: string } | undefined>(undefined);

  useEffect(() => {
    if (!running || sessionId === null) return;
    let live = true;
    let follow: RunnerLogFollow | undefined;
    const controller = new AbortController();
    void fetchRunnerLog(sessionId, runId, { lines: TAIL_REQUEST_LINES }, controller.signal).then((result) => {
      // A log the hub cannot serve leaves the row on its command, which is
      // still true; the log tab is where an unreachable runner is diagnosed.
      if (!live || 'error' in result) return;
      const initial = plainTailLine(result.slice.text.split('\n'));
      if (initial !== undefined) setTail({ runId, text: initial });
      if (!result.slice.running) return;
      follow = followRunnerLog(sessionId, runId, result.slice.fileSize, {
        onEvent: (event) => {
          const next = plainTailLine(event.lines);
          if (live && next !== undefined) setTail({ runId, text: next });
        },
        // A dropped stream freezes the line at the last one that arrived. The
        // row is a glance, and reconnecting it would cost more than it says.
        onError: () => undefined,
      });
    });
    return () => {
      live = false;
      controller.abort();
      follow?.close();
    };
  }, [sessionId, runId, running]);

  return running && tail?.runId === runId ? tail.text : undefined;
}
