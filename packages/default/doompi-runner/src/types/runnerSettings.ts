/**
 * Project-local extension configuration, read from `<CONFIG_DIR_NAME>/doompi-runner.json`.
 *
 * Pi's convention for extension configuration is one JSON file per extension
 * under the config directory, honoured only for a trusted project. Values here
 * are the project's baseline: an environment variable still wins for a single
 * invocation, and a per-command pragma wins over both.
 */
export interface RunnerSettings {
  /** Byte ceiling for one tool result. */
  readonly maxResultBytes?: number;
  /** Line ceiling for one tool result. */
  readonly maxResultLines?: number;
  /** Byte ceiling for the result of a command that succeeded. */
  readonly successMaxResultBytes?: number;
  /** Token ceiling for one tool result. */
  readonly maxResultTokens?: number;
  /** Token ceiling for the result of a command that succeeded. */
  readonly successMaxResultTokens?: number;
  /** Share of the budget spent on the leading excerpt, between 0 and 1. */
  readonly headRatio?: number;
  /** Extra severity patterns appended to the built-in matcher. */
  readonly errorPatterns?: readonly string[];
  /** Distinct failures rescued from the elided middle. */
  readonly errorMaxEntries?: number;
  /** Variants joined inside one bracket before the rest become a count. */
  readonly errorMaxVariantsJoined?: number;
  /** Share of the budget reserved for rescued errors, between 0 and 1. */
  readonly errorBudgetRatio?: number;
}

export interface RunnerSettingsLoad {
  readonly settings: RunnerSettings;
  /** Every rejected key, so a typo is reported rather than silently ignored. */
  readonly issues: readonly string[];
}

export interface IRunnerSettingsLoader {
  /** Returns empty settings when the project is untrusted or the file is absent. */
  load(cwd: string, trusted: boolean): RunnerSettingsLoad;
}
