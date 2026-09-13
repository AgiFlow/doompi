import headless, { type Terminal } from '@xterm/headless';

import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  LIVENESS_POLL_MS,
  MEMORY_BUFFER_FACTOR,
  NEWLINE,
  SCROLLBACK,
  TERM_GRACE_MS,
} from '../../constants/ptyHost';
import { PI_SESSION_ID_ENV } from '../../constants/session';
import type { IClock } from '../../types/clock';
import type { ILogFile } from '../../types/logFile';
import type { IProcessControl } from '../../types/processControl';
import type { IPtyHost, PtyLaunchRequest, PtyRun } from '../../types/ptyHost';
import type { IPtySpawner, PtyProcess } from '../../types/ptySpawner';
import type { ExitResult } from '../../types/spawner';
import { scrubTerminalOutput } from '../ansiScrub';
import { getResultMaxBytes } from '../runnerConfig';
import { NO_TERMINAL_INPUT_ENV } from '../runnerSupervisor';

/** Enough history for the overlay to scroll without holding a whole build. */

// Use the CommonJS default export: Node cannot detect this package's named exports.
// A static import also lets server bundles include it without a live node_modules lookup.
const { Terminal: HeadlessTerminal } = headless;

export class PtyHost implements IPtyHost {
  private readonly runs = new Map<string, PtyRun>();

  constructor(
    private readonly spawner: IPtySpawner,
    private readonly logFile: ILogFile,
    private readonly processControl: IProcessControl,
    private readonly clock: IClock,
  ) {}

  async launch(request: PtyLaunchRequest): Promise<PtyRun> {
    const cols = request.cols ?? DEFAULT_COLS;
    const rows = request.rows ?? DEFAULT_ROWS;
    const writer = this.logFile.open(request.id);
    const terminal = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const memoryLimit = getResultMaxBytes() * MEMORY_BUFFER_FACTOR;

    const child = await this.spawner.spawn({
      command: request.command,
      cwd: request.cwd,
      env: { ...process.env, ...NO_TERMINAL_INPUT_ENV, [PI_SESSION_ID_ENV]: request.sessionId },
      cols,
      rows,
    });

    let buffer = '';
    let buffering = true;
    let settled = false;
    let resolveCompletion: (result: ExitResult) => void = () => undefined;
    const completion = new Promise<ExitResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const dataHandlers = new Set<(data: string) => void>();

    child.onData((data) => {
      // The terminal keeps the screen; the log keeps text worth grepping.
      terminal.write(data);
      const scrubbed = scrubTerminalOutput(data);
      writer.append(scrubbed);
      if (buffering) {
        buffer += scrubbed;
        if (buffer.length > memoryLimit) buffer = buffer.slice(-memoryLimit);
      }
      for (const handler of dataHandlers) handler(data);
    });

    child.onExit((result) => {
      if (settled) return;
      settled = true;
      this.runs.delete(request.name);
      writer.close();
      resolveCompletion({ code: result.exitCode, signal: null });
    });

    const run: PtyRun = {
      id: request.id,
      name: request.name,
      pid: child.pid,
      logPath: writer.path,
      backend: 'native',
      output: () => buffer,
      completion: () => completion,
      detach: () => {
        buffering = false;
        buffer = '';
      },
      stop: () => this.stopChild(child, request.name),
      write: (text) => child.write(text),
      screen: () => renderScreen(terminal),
      onData: (handler) => {
        dataHandlers.add(handler);
        return () => dataHandlers.delete(handler);
      },
      resize: (nextCols, nextRows) => {
        child.resize(nextCols, nextRows);
        terminal.resize(nextCols, nextRows);
      },
    };

    this.runs.set(request.name, run);
    return run;
  }

  get(name: string): PtyRun | undefined {
    return this.runs.get(name);
  }

  write(name: string, text: string): boolean {
    const run = this.runs.get(name);
    if (!run) return false;
    run.write(text.endsWith(NEWLINE) ? text : `${text}${NEWLINE}`);
    return true;
  }

  list(): PtyRun[] {
    return [...this.runs.values()];
  }

  async disposeAll(): Promise<void> {
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) await run.stop();
  }

  private async stopChild(child: PtyProcess, name: string): Promise<boolean> {
    this.runs.delete(name);
    if (!this.processControl.isAlive(child.pid)) return false;

    child.kill('SIGTERM');
    const deadline = this.clock.now() + TERM_GRACE_MS;
    while (this.clock.now() < deadline) {
      if (!this.processControl.isAlive(child.pid)) return true;
      await new Promise<void>((resolve) => {
        this.clock.after(LIVENESS_POLL_MS, resolve);
      });
    }
    child.kill('SIGKILL');
    return true;
  }
}

/** The visible rows, trimmed of trailing blanks, as plain text. */
function renderScreen(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = buffer.baseY; row < buffer.baseY + terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join(NEWLINE);
}
