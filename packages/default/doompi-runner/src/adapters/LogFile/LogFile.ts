import fs from 'node:fs';
import type { IRunnerPaths } from '../../services/RunnerPaths/types';
import { getLogMaxBytes } from '../../types/config.ts';
import type { ILogFile, LogWriter } from '../../types/logFile';

export class LogFile implements ILogFile {
  constructor(private readonly paths: IRunnerPaths) {}

  open(id: string): LogWriter {
    this.paths.ensureDirectories();
    const logPath = this.paths.logPathFor(id);
    const rotatedPath = this.paths.rotatedLogPathFor(id);
    const maxBytes = getLogMaxBytes();

    // A reused name starts clean: the previous runner's output is already
    // available to whoever wanted it, and mixing two runs in one file makes
    // both unreadable.
    let handle = fs.openSync(logPath, 'w');
    let written = 0;
    let closed = false;

    /**
     * A run that keeps producing output for hours would otherwise grow one file
     * without limit. Rotating keeps the newest window at the advertised path
     * and the window before it alongside, so on-disk cost is bounded at roughly
     * twice the ceiling, the path a result advertises stays valid, and the line
     * counts a reader reports still describe the file it actually read.
     */
    const rotate = (): void => {
      fs.closeSync(handle);
      try {
        fs.renameSync(logPath, rotatedPath);
      } catch (error) {
        // Holding the ceiling matters more than keeping the previous window,
        // so the new file is opened either way and the loss is reported.
        process.emitWarning(`Could not rotate runner log ${logPath}: ${String(error)}`);
      }
      handle = fs.openSync(logPath, 'w');
      written = 0;
    };

    return {
      path: logPath,
      append(text: string): void {
        const chunk = Buffer.from(text, 'utf8');
        // An empty file always takes the chunk, so a single write larger than
        // the ceiling is stored rather than rotated away into nothing.
        if (written > 0 && written + chunk.byteLength > maxBytes) rotate();
        fs.writeSync(handle, chunk);
        written += chunk.byteLength;
      },
      size(): number {
        return written;
      },
      close(): void {
        // Closing twice is normal: a launch that fails closes the log before
        // the exit handler does. Only a first close that fails is news.
        if (closed) return;
        closed = true;
        try {
          fs.closeSync(handle);
        } catch (error) {
          process.emitWarning(`Could not close runner log ${logPath}: ${String(error)}`);
        }
      },
    };
  }
}
