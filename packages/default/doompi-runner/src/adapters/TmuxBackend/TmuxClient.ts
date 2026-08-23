import { execFile } from 'node:child_process';
import type { ITmuxClient, TmuxResult } from '../../types/tmuxClient';

const TMUX_BINARY = 'tmux';
const SOCKET_OPTION = '-L';
/** Long enough for a loaded server, short enough that a hung tmux is not fatal. */
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class TmuxClient implements ITmuxClient {
  constructor(
    private readonly socket: string,
    private readonly binary = TMUX_BINARY,
  ) {}

  run(args: readonly string[]): Promise<TmuxResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        [SOCKET_OPTION, this.socket, ...args],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          // A non-zero tmux exit is an answer, not a fault: `has-session`
          // reports absence that way. Only a missing or hung binary rejects.
          const code = (error as (Error & { code?: number | string }) | null)?.code;
          if (error && typeof code !== 'number') {
            reject(error);
            return;
          }
          resolve({ returnCode: typeof code === 'number' ? code : 0, stdout, stderr });
        },
      );
    });
  }

  async format(target: string, format: string): Promise<string | undefined> {
    const result = await this.run(['display-message', '-p', '-t', target, '-F', format]).catch(() => undefined);
    if (!result || result.returnCode !== 0) return undefined;
    return result.stdout.replace(/\n$/, '');
  }

  async sessionMissing(target: string): Promise<boolean> {
    const result = await this.run(['has-session', '-t', target]).catch(() => undefined);
    return !result || result.returnCode !== 0;
  }
}
