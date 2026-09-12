/**
 * Extension configuration, read from the environment.
 *
 * Env rather than a config file: doom-pi already carries per-launch state to Pi
 * through env vars, so this keeps doom-task consistent with how the harness
 * configures the rest of the extension set.
 */

export const MAX_WIDGET_LINES_ENV = 'DOOM_TASK_MAX_WIDGET_LINES';
export const MAX_TASKS_ENV = 'DOOM_TASK_MAX_TASKS';
export const COLLAPSE_KEY_ENV = 'DOOM_TASK_COLLAPSE_KEY';
export const STORE_TTL_MS_ENV = 'DOOM_TASK_STORE_TTL_MS';
export const DELEGATION_TIMEOUT_MS_ENV = 'DOOM_TASK_DELEGATION_TIMEOUT_MS';

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const DEFAULT_MAX_TASKS = 15;
export const DEFAULT_COLLAPSE_KEY = 'ctrl+shift+t';
export const DEFAULT_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Deliberately under the subagents auto-drain ceiling (30 min) so a headless
 * session still gets the failure and a model turn before draining gives up. */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 20 * 60 * 1000;
export const COLLAPSE_KEY_OFF = 'off';

const MIN_WIDGET_LINES = 3;
const MAX_WIDGET_LINES = 60;

export interface PiTaskConfig {
  maxWidgetLines: number;
  maxTasks: number;
  storeTtlMs: number;
  collapseKey: string;
  delegationTimeoutMs: number;
}

function configRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse configuration only after the Pi host has applied its project-trust policy. */
export function parsePiTaskConfig(value: unknown): PiTaskConfig {
  const config = configRecord(value);
  const maxWidgetLines =
    typeof config.maxWidgetLines === 'number' && Number.isFinite(config.maxWidgetLines)
      ? Math.min(Math.max(config.maxWidgetLines, MIN_WIDGET_LINES), MAX_WIDGET_LINES)
      : DEFAULT_MAX_WIDGET_LINES;
  const maxTasks =
    typeof config.maxTasks === 'number' && Number.isSafeInteger(config.maxTasks) && config.maxTasks > 0
      ? config.maxTasks
      : DEFAULT_MAX_TASKS;
  const storeTtlMs =
    typeof config.storeTtlMs === 'number' && Number.isFinite(config.storeTtlMs) && config.storeTtlMs > 0
      ? config.storeTtlMs
      : DEFAULT_STORE_TTL_MS;
  const delegationTimeoutMs =
    typeof config.delegationTimeoutMs === 'number' &&
    Number.isFinite(config.delegationTimeoutMs) &&
    config.delegationTimeoutMs > 0
      ? config.delegationTimeoutMs
      : DEFAULT_DELEGATION_TIMEOUT_MS;
  const collapseKey =
    typeof config.collapseKey === 'string' && config.collapseKey.trim()
      ? config.collapseKey.trim().toLowerCase() === COLLAPSE_KEY_OFF
        ? COLLAPSE_KEY_OFF
        : config.collapseKey.trim()
      : DEFAULT_COLLAPSE_KEY;

  return { maxWidgetLines, maxTasks, storeTtlMs, collapseKey, delegationTimeoutMs };
}

/** Rows the overlay may use for content, clamped to a sane range. */
export function getMaxWidgetLines(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[MAX_WIDGET_LINES_ENV] ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_WIDGET_LINES;
  return Math.min(Math.max(raw, MIN_WIDGET_LINES), MAX_WIDGET_LINES);
}

/** Maximum number of non-deleted tasks retained on one board. */
export function getMaxTasks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[MAX_TASKS_ENV]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_TASKS;
}

/** Retention window for inactive session-tree stores. */
export function getStoreTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[STORE_TTL_MS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STORE_TTL_MS;
}

/** How long a delegated run may go without reporting a result. */
export function getDelegationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[DELEGATION_TIMEOUT_MS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DELEGATION_TIMEOUT_MS;
}

/** Collapse shortcut, or the `off` sentinel when the user disabled it. */
export function resolveCollapseKey(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[COLLAPSE_KEY_ENV]?.trim();
  if (!configured) return DEFAULT_COLLAPSE_KEY;
  return configured.toLowerCase() === COLLAPSE_KEY_OFF ? COLLAPSE_KEY_OFF : configured;
}
