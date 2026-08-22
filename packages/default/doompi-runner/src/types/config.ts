/**
 * Extension configuration, read from the environment.
 *
 * Env rather than a config file, matching doom-task: doom-pi already carries
 * per-launch state to Pi through env vars.
 */

export const BG_THRESHOLD_MS_ENV = 'DOOM_RUNNER_BG_THRESHOLD_MS';
export const RESULT_MAX_BYTES_ENV = 'DOOM_RUNNER_RESULT_MAX_BYTES';
export const SUCCESS_RESULT_MAX_BYTES_ENV = 'DOOM_RUNNER_SUCCESS_RESULT_MAX_BYTES';
export const RESULT_MAX_TOKENS_ENV = 'DOOM_RUNNER_RESULT_MAX_TOKENS';
export const SUCCESS_RESULT_MAX_TOKENS_ENV = 'DOOM_RUNNER_SUCCESS_RESULT_MAX_TOKENS';
export const LOG_MAX_BYTES_ENV = 'DOOM_RUNNER_LOG_MAX_BYTES';
export const LOG_TTL_MS_ENV = 'DOOM_RUNNER_LOG_TTL_MS';
/** Unscoped override for the runner log directory. */
export const LOG_DIR_ENV = 'DOOM_RUNNER_LOG_DIR';

import type { RunnerSettings } from './runnerSettings';

/** A bash call still running at this point is promoted to a named runner. */
export const DEFAULT_BG_THRESHOLD_MS = 60_000;
/** Tool results past this size are excerpted and spilled to the log file. */
export const DEFAULT_RESULT_MAX_BYTES = 8_192;
/** Line ceiling for a single tool result, applied alongside the byte ceiling. */
export const DEFAULT_RESULT_MAX_LINES = 120;
/**
 * A successful command gets a much smaller budget than a failing one. Exiting 0
 * has already reported the outcome, so its output buys far less than a failure's.
 */
export const DEFAULT_SUCCESS_RESULT_MAX_BYTES = 2_048;
/**
 * Token ceilings sit alongside the byte ones because bytes do not track context
 * cost: 8 KiB of prose is roughly 2k tokens, while 8 KiB of base64 or CJK is
 * several times that. Whichever ceiling binds first wins.
 */
export const DEFAULT_RESULT_MAX_TOKENS = 2_048;
export const DEFAULT_SUCCESS_RESULT_MAX_TOKENS = 512;
/** Share of the budget spent on the leading excerpt; the remainder goes to the tail. */
export const DEFAULT_HEAD_RATIO = 0.2;
/** Share reserved for errors rescued from the elided middle, when any exist. */
export const DEFAULT_ERROR_BUDGET_RATIO = 0.2;
/** Distinct failures rescued from the elided middle. */
export const DEFAULT_ERROR_MAX_ENTRIES = 10;
/** Variants joined inside one bracket before the rest become a count. */
export const DEFAULT_ERROR_MAX_VARIANTS_JOINED = 6;
/** Legacy rotation value retained so existing configuration imports remain compatible. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Retention window for logs with no live registry record. */
export const DEFAULT_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Age at which a bash call becomes a background runner. */
export function getBackgroundThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[BG_THRESHOLD_MS_ENV], DEFAULT_BG_THRESHOLD_MS);
}

/** Byte ceiling for a single tool result before tail truncation kicks in. */
export function getResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[RESULT_MAX_BYTES_ENV], activeSettings.maxResultBytes ?? DEFAULT_RESULT_MAX_BYTES);
}

/** Legacy rotation setting retained for public API compatibility. */
export function getLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[LOG_MAX_BYTES_ENV], DEFAULT_LOG_MAX_BYTES);
}

/** Retention window for orphaned runner logs. */
export function getLogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[LOG_TTL_MS_ENV], DEFAULT_LOG_TTL_MS);
}

/**
 * Project settings sit below the environment on purpose: a checked-in file is
 * the project's baseline, while an environment variable is set for one run.
 */
let activeSettings: RunnerSettings = {};

export function setRunnerSettings(settings: RunnerSettings): void {
  activeSettings = settings;
}

export function getRunnerSettings(): RunnerSettings {
  return activeSettings;
}

/** Byte ceiling for the result of a command that succeeded. */
export function getSuccessResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(
    env[SUCCESS_RESULT_MAX_BYTES_ENV],
    activeSettings.successMaxResultBytes ?? DEFAULT_SUCCESS_RESULT_MAX_BYTES,
  );
}

/** Token ceiling for a single tool result. */
export function getResultMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[RESULT_MAX_TOKENS_ENV], activeSettings.maxResultTokens ?? DEFAULT_RESULT_MAX_TOKENS);
}

/** Token ceiling for the result of a command that succeeded. */
export function getSuccessResultMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(
    env[SUCCESS_RESULT_MAX_TOKENS_ENV],
    activeSettings.successMaxResultTokens ?? DEFAULT_SUCCESS_RESULT_MAX_TOKENS,
  );
}

/** Line ceiling for a single tool result. */
export function getResultMaxLines(): number {
  return activeSettings.maxResultLines ?? DEFAULT_RESULT_MAX_LINES;
}

export function getHeadRatio(): number {
  return activeSettings.headRatio ?? DEFAULT_HEAD_RATIO;
}

export function getErrorBudgetRatio(): number {
  return activeSettings.errorBudgetRatio ?? DEFAULT_ERROR_BUDGET_RATIO;
}

export function getErrorMaxEntries(): number {
  return activeSettings.errorMaxEntries ?? DEFAULT_ERROR_MAX_ENTRIES;
}

export function getErrorMaxVariantsJoined(): number {
  return activeSettings.errorMaxVariantsJoined ?? DEFAULT_ERROR_MAX_VARIANTS_JOINED;
}

/** Extra severity patterns appended to the built-in matcher. */
export function getErrorPatterns(): readonly string[] {
  return activeSettings.errorPatterns ?? [];
}
