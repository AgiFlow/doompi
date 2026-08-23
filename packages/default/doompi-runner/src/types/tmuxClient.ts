export interface TmuxResult {
  returnCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The tmux command surface this package needs.
 *
 * Narrow on purpose: it names the operations the supervisor performs rather
 * than wrapping tmux, so a fake in a test stays as small as the real client.
 */
export interface ITmuxClient {
  /** Runs one tmux command on this client's private server. */
  run(args: readonly string[]): Promise<TmuxResult>;
  /** Reads one format string against a target, or undefined when unreachable. */
  format(target: string, format: string): Promise<string | undefined>;
  /** True when the target names no live session, including when no server runs. */
  sessionMissing(target: string): Promise<boolean>;
}
