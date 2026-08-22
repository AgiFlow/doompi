import fs from 'node:fs';
import type { IRunnerPaths } from '../../services/RunnerPaths/types';
import type { ILogFile, LogWriter } from '../../types/logFile';

export class LogFile implements ILogFile {
  constructor(private readonly paths: IRunnerPaths) {}

  open(id: string): LogWriter {
    this.paths.ensureDirectories();
    const logPath = this.paths.logPathFor(id);

    // A reused name starts clean: the previous runner's output is already
    // available to whoever wanted it, and mixing two runs in one file makes
    // both unreadable.
    const handle = fs.openSync(logPath, 'w');
    let written = 0;

    return {
      path: logPath,
      append(text: string): void {
        const chunk = Buffer.from(text, 'utf8');
        fs.writeSync(handle, chunk);
        written += chunk.byteLength;
      },
      size(): number {
        return written;
      },
      close(): void {
        try {
          fs.closeSync(handle);
        } catch {
          // Closing twice is not worth reporting: the log is already flushed.
        }
      },
    };
  }
}
