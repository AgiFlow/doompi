import {
  BG_THRESHOLD_MS_ENV,
  DEFAULT_BG_THRESHOLD_MS,
  DEFAULT_ERROR_BUDGET_RATIO,
  DEFAULT_ERROR_MAX_ENTRIES,
  DEFAULT_ERROR_MAX_VARIANTS_JOINED,
  DEFAULT_HEAD_RATIO,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_TTL_MS,
  DEFAULT_MAX_COMPLETED_RUNNERS,
  DEFAULT_RESULT_MAX_BYTES,
  DEFAULT_RESULT_MAX_LINES,
  DEFAULT_RESULT_MAX_TOKENS,
  DEFAULT_SUCCESS_RESULT_MAX_BYTES,
  DEFAULT_SUCCESS_RESULT_MAX_TOKENS,
  LOG_MAX_BYTES_ENV,
  LOG_TTL_MS_ENV,
  MAX_COMPLETED_RUNNERS_ENV,
  RESULT_MAX_BYTES_ENV,
  RESULT_MAX_TOKENS_ENV,
  SUCCESS_RESULT_MAX_BYTES_ENV,
  SUCCESS_RESULT_MAX_TOKENS_ENV,
} from '../../constants/runnerConfig';
/**
 * Extension configuration, read from the environment.
 *
 * Env rather than a config file, matching doom-task: doom-pi already carries
 * per-launch state to Pi through env vars.
 */

/** Unscoped override for the runner log directory. */

import type { RunnerSettings } from '../../types/runnerSettings';

/** A bash call still running at this point is promoted to a named runner. */
/** Tool results past this size are excerpted and spilled to the log file. */
/** Line ceiling for a single tool result, applied alongside the byte ceiling. */
/**
 * A successful command gets a much smaller budget than a failing one. Exiting 0
 * has already reported the outcome, so its output buys far less than a failure's.
 */
/**
 * Token ceilings sit alongside the byte ones because bytes do not track context
 * cost: 8 KiB of prose is roughly 2k tokens, while 8 KiB of base64 or CJK is
 * several times that. Whichever ceiling binds first wins.
 */
/** Share of the budget spent on the leading excerpt; the remainder goes to the tail. */
/** Share reserved for errors rescued from the elided middle, when any exist. */
/** Distinct failures rescued from the elided middle. */
/** Variants joined inside one bracket before the rest become a count. */
/** Legacy rotation value retained so existing configuration imports remain compatible. */
/** Retention window for logs with no live registry record. */
/**
 * Completed runners a single session keeps on disk.
 *
 * A count bound, not just an age one, because a session that stays open for a
 * working day never ages its own records past the TTL: they would accumulate
 * for as long as the session lives.
 */

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
  return positiveNumber(
    env[RESULT_MAX_BYTES_ENV],
    runnerSettingsState.value.maxResultBytes ?? DEFAULT_RESULT_MAX_BYTES,
  );
}

/** Legacy rotation setting retained for public API compatibility. */
export function getLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[LOG_MAX_BYTES_ENV], DEFAULT_LOG_MAX_BYTES);
}

/** Retention window for orphaned runner logs. */
export function getLogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[LOG_TTL_MS_ENV], DEFAULT_LOG_TTL_MS);
}

/** Completed runners one session retains before the oldest are swept. */
export function getMaxCompletedRunners(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(env[MAX_COMPLETED_RUNNERS_ENV], DEFAULT_MAX_COMPLETED_RUNNERS);
}

/**
 * Project settings sit below the environment on purpose: a checked-in file is
 * the project's baseline, while an environment variable is set for one run.
 */
import { runnerSettingsState } from '../../models/runnerSettings';

export function setRunnerSettings(settings: RunnerSettings): void {
  runnerSettingsState.value = settings;
}

export function getRunnerSettings(): RunnerSettings {
  return runnerSettingsState.value;
}

/** Byte ceiling for the result of a command that succeeded. */
export function getSuccessResultMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(
    env[SUCCESS_RESULT_MAX_BYTES_ENV],
    runnerSettingsState.value.successMaxResultBytes ?? DEFAULT_SUCCESS_RESULT_MAX_BYTES,
  );
}

/** Token ceiling for a single tool result. */
export function getResultMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(
    env[RESULT_MAX_TOKENS_ENV],
    runnerSettingsState.value.maxResultTokens ?? DEFAULT_RESULT_MAX_TOKENS,
  );
}

/** Token ceiling for the result of a command that succeeded. */
export function getSuccessResultMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(
    env[SUCCESS_RESULT_MAX_TOKENS_ENV],
    runnerSettingsState.value.successMaxResultTokens ?? DEFAULT_SUCCESS_RESULT_MAX_TOKENS,
  );
}

/** Line ceiling for a single tool result. */
export function getResultMaxLines(): number {
  return runnerSettingsState.value.maxResultLines ?? DEFAULT_RESULT_MAX_LINES;
}

export function getHeadRatio(): number {
  return runnerSettingsState.value.headRatio ?? DEFAULT_HEAD_RATIO;
}

export function getErrorBudgetRatio(): number {
  return runnerSettingsState.value.errorBudgetRatio ?? DEFAULT_ERROR_BUDGET_RATIO;
}

export function getErrorMaxEntries(): number {
  return runnerSettingsState.value.errorMaxEntries ?? DEFAULT_ERROR_MAX_ENTRIES;
}

export function getErrorMaxVariantsJoined(): number {
  return runnerSettingsState.value.errorMaxVariantsJoined ?? DEFAULT_ERROR_MAX_VARIANTS_JOINED;
}

/** Extra severity patterns appended to the built-in matcher. */
export function getErrorPatterns(): readonly string[] {
  return runnerSettingsState.value.errorPatterns ?? [];
}
