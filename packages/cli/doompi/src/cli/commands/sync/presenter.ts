/**
 * Step-by-step progress for `doompi sync`.
 *
 * Sync spends almost all of its wall clock in three places a user cannot see:
 * the registry check, the mode build, and the runtime precompile. A terminal
 * gets a live line that the finished step overwrites, so the transcript stays
 * as short as the existing summary. Anything else (a pipe, CI, the embedded
 * dpi runner) gets one line per completed step and no escape sequences.
 */

const LABEL_WIDTH = 10;
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const CLEAR_LINE = `${ANSI_ESCAPE}[2K\r`;
const MILLISECONDS_PER_SECOND = 1000;

export interface SyncProgressOutput {
  write: NodeJS.WritableStream['write'];
  isTTY?: boolean;
}

/** Closes the step a `start` call opened, recording how long it took. */
export type SyncStepDone = (summary: string) => void;

export function formatProgressLine(label: string, message: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${message}`;
}

function formatElapsed(milliseconds: number): string {
  return `${(milliseconds / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
}

/** Reports sync phases as they run rather than only after everything is done. */
export class SyncProgress {
  private readonly output: SyncProgressOutput;
  private readonly now: () => number;
  private live = false;

  constructor(output: SyncProgressOutput, now: () => number = Date.now) {
    this.output = output;
    this.now = now;
  }

  /** Opens a timed step and returns the call that closes it. */
  start(label: string, message: string): SyncStepDone {
    const startedAt = this.now();
    this.drawLive(formatProgressLine(label, `${message}...`));
    return (summary) => {
      this.clearLive();
      this.output.write(`${formatProgressLine(label, `${summary} (${formatElapsed(this.now() - startedAt)})`)}\n`);
    };
  }

  /** Writes a standalone line, such as one package moving to a new version. */
  line(label: string, message: string): void {
    this.clearLive();
    this.output.write(`${formatProgressLine(label, message)}\n`);
  }

  private drawLive(text: string): void {
    if (!this.output.isTTY) return;
    this.output.write(`${CLEAR_LINE}${text}`);
    this.live = true;
  }

  private clearLive(): void {
    if (!this.live) return;
    this.output.write(CLEAR_LINE);
    this.live = false;
  }
}
