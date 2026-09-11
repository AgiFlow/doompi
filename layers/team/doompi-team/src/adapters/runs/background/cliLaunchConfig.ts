/**
 * The bounded launch contract the parent sends to an external CLI child over
 * Node process IPC. It stays separate from the child entry point so the parent
 * can validate and send it without importing executable module side effects.
 */

export interface CliLaunchConfig {
  runId: string;
  operationId?: string;
  agent: string;
  task: string;
  sensitiveTask?: boolean;
  /** Which configured runtime this is, for the result record and error text. */
  runtime: string;
  command: string;
  args: string[];
  cwd: string;
  /** Extra environment for the child. The trusted profile supplies an allowlist, not inherited process.env. */
  env: Record<string, string>;
  /** Trusted profile identifier. Generic runtimes omit this field. */
  profile?: string;
  /** Private prompt file for a profile that requires stdin delivery. */
  stdinPath?: string;
  /** Private paths removed by the generic runner on every terminal path. */
  cleanupPaths?: string[];
  /** Ephemeral private result consumed and deleted only by the same-process Fable broker. */
  profileResultPath?: string;
  /** Suppress generic completion chat for bridge-owned runs. */
  internal?: boolean;
  /** Where the terminal result lands, in this run's own session scope. */
  resultPath: string;
}
