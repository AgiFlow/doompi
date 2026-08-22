/**
 * The contract the parent writes and an external-CLI child reads back.
 *
 * Separate from `cliRunnerEntry.ts` so the spawner can build one without
 * importing the child entry point, which is resolved by raw filesystem path
 * rather than by `import` and must stay independently loadable.
 */

export interface CliLaunchConfig {
  runId: string;
  operationId?: string;
  agent: string;
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
  /** Where the child signals that it started; the parent's spawn blocks on this. */
  handshakePath: string;
  /** Where the terminal result lands, in this run's own session scope. */
  resultPath: string;
}
