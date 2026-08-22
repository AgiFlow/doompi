import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import type { IRunnerSettingsLoader, RunnerSettings, RunnerSettingsLoad } from '../../types/runnerSettings';

/** Pi's convention is one JSON file per extension under the config directory. */
export const RUNNER_SETTINGS_FILE = 'doompi-runner.json';

const EMPTY: RunnerSettingsLoad = { settings: {}, issues: [] };
const RATIO_KEYS = ['headRatio', 'errorBudgetRatio'] as const;
const COUNT_KEYS = [
  'maxResultBytes',
  'maxResultLines',
  'successMaxResultBytes',
  'maxResultTokens',
  'successMaxResultTokens',
  'errorMaxEntries',
  'errorMaxVariantsJoined',
] as const;
const KNOWN_KEYS = new Set<string>([...RATIO_KEYS, ...COUNT_KEYS, 'errorPatterns']);
/** Ceilings so a project file cannot flood the model's context. */
const MAX_RESULT_BYTES_CEILING = 262_144;
const MAX_RESULT_LINES_CEILING = 5_000;
const MAX_RESULT_TOKENS_CEILING = 100_000;
const MAX_ERROR_ENTRIES_CEILING = 100;
const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 512;
const CEILINGS: Readonly<Record<string, number>> = {
  maxResultBytes: MAX_RESULT_BYTES_CEILING,
  successMaxResultBytes: MAX_RESULT_BYTES_CEILING,
  maxResultTokens: MAX_RESULT_TOKENS_CEILING,
  successMaxResultTokens: MAX_RESULT_TOKENS_CEILING,
  maxResultLines: MAX_RESULT_LINES_CEILING,
  errorMaxEntries: MAX_ERROR_ENTRIES_CEILING,
  errorMaxVariantsJoined: MAX_ERROR_ENTRIES_CEILING,
};

export class RunnerSettingsLoader implements IRunnerSettingsLoader {
  load(cwd: string, trusted: boolean): RunnerSettingsLoad {
    // Project-local configuration is untrusted input until the project is.
    if (!trusted) return EMPTY;

    let raw: string;
    try {
      raw = fs.readFileSync(path.join(cwd, CONFIG_DIR_NAME, RUNNER_SETTINGS_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      return { settings: {}, issues: [`${RUNNER_SETTINGS_FILE} could not be read`] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { settings: {}, issues: [`${RUNNER_SETTINGS_FILE} is not valid JSON`] };
    }
    return validate(parsed);
  }
}

function validate(parsed: unknown): RunnerSettingsLoad {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { settings: {}, issues: [`${RUNNER_SETTINGS_FILE} must contain a JSON object`] };
  }

  const source = parsed as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const issues: string[] = [];
  // A rejected key is reported rather than dropped: a silent typo reads as a
  // setting that simply does not work.
  for (const key of Object.keys(source)) if (!KNOWN_KEYS.has(key)) issues.push(`unknown key ${key}`);

  for (const key of COUNT_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      issues.push(`${key} must be a positive integer`);
      continue;
    }
    settings[key] = Math.min(value, CEILINGS[key] ?? value);
  }

  for (const key of RATIO_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      issues.push(`${key} must be a number above 0 and below 1`);
      continue;
    }
    settings[key] = value;
  }

  const patterns = source.errorPatterns;
  if (patterns !== undefined) {
    if (!Array.isArray(patterns) || patterns.some((entry) => typeof entry !== 'string')) {
      issues.push('errorPatterns must be an array of strings');
    } else {
      const accepted: string[] = [];
      for (const pattern of patterns.slice(0, MAX_PATTERNS) as string[]) {
        if (pattern.length > MAX_PATTERN_LENGTH) {
          issues.push('errorPatterns entry is too long');
          continue;
        }
        try {
          new RegExp(pattern, 'iu');
          accepted.push(pattern);
        } catch {
          issues.push(`errorPatterns entry is not a valid regular expression: ${pattern}`);
        }
      }
      if (accepted.length > 0) settings.errorPatterns = accepted;
    }
  }

  return { settings: settings as RunnerSettings, issues };
}
