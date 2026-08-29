import type { SubagentRun, SubagentRunState } from '../types/webSubagents.ts';

/**
 * MIRRORS @agimon-ai/doompi-team's on-disk run layout
 * (layers/team/doompi-team/src/adapters/filesystem/paths.ts and
 * runs/background/asyncExecution.ts). The team runtime writes one directory
 * per session scope under the OS temp root and one status.json per run; the
 * hub only ever reads them. The derivation is duplicated rather than imported
 * because doompi-web must not depend on the team package at runtime.
 */
export const RUN_STATUS_FILE_NAME = 'status.json';
/** Process registry beside the runs directory, mirrored from runRegistry.ts. */
export const RUN_REGISTRY_FILE_NAME = 'registry.json';

const TAIL_LIMIT = 12;
const TAIL_ENTRY_LIMIT = 200;
/** Terminal runs older than this leave the fleet the page sees. */
export const RUN_RETENTION_MS = 10 * 60 * 1000;

/** A run id is a path segment under the runs dir, so only plain names may be looked up. */
export const RUN_ID_PATTERN = /^[\w.-]+$/;
const JOURNAL_EXTENSION = '.jsonl';

/**
 * The Pi session journal a run's status names, once the child's session has
 * started; undefined before then or when the status names something else.
 * Runs are uid-scoped, so an absolute path is a POSIX one.
 */
export function journalPathOf(status: { sessionFile?: unknown }): string | undefined {
  const candidate = status.sessionFile;
  if (typeof candidate !== 'string' || !candidate.startsWith('/')) return undefined;
  return candidate.endsWith(JOURNAL_EXTENSION) ? candidate : undefined;
}

const STATE_MAP: Readonly<Record<string, SubagentRunState>> = {
  queued: 'queued',
  running: 'running',
  complete: 'done',
  completed: 'done',
  failed: 'failed',
  paused: 'stopped',
  stopped: 'stopped',
  canceled: 'stopped',
  cancelled: 'stopped',
};

const TERMINAL_STATES: ReadonlySet<SubagentRunState> = new Set(['done', 'failed', 'stopped']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Recent-entry arrays are declared `unknown[]` upstream; render what reads as text. */
function entryText(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.slice(0, TAIL_ENTRY_LIMIT);
  if (isRecord(entry)) {
    const candidate = entry.text ?? entry.line ?? entry.output ?? entry.name;
    if (typeof candidate === 'string') return candidate.slice(0, TAIL_ENTRY_LIMIT);
  }
  return undefined;
}

/**
 * Validates one run status file into the wire shape.
 *
 * Returns undefined for anything unreadable, a foreign format, or a run
 * marked internal: the fleet view is for the runs the user asked about.
 */
export function parseSubagentRun(raw: string): SubagentRun | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.internal === true) return undefined;
  const runId = asOptionalString(parsed.runId);
  const agent = asOptionalString(parsed.agent);
  const rawState = asOptionalString(parsed.state);
  const startedAt = asOptionalNumber(parsed.startedAt);
  if (!runId || !agent || !rawState || startedAt === undefined) return undefined;
  const state = STATE_MAP[rawState];
  if (state === undefined) return undefined;

  const tail = Array.isArray(parsed.recentOutput)
    ? parsed.recentOutput
        .map(entryText)
        .filter((line): line is string => line !== undefined)
        .slice(-TAIL_LIMIT)
    : [];

  const endedAt = asOptionalNumber(parsed.endedAt);
  const summary = asOptionalString(parsed.summary);
  const error = asOptionalString(parsed.error);
  return {
    runId,
    agent,
    state,
    rawState,
    task: asOptionalString(parsed.task) ?? '',
    ...(asOptionalString(parsed.taskRef) === undefined ? {} : { taskRef: asOptionalString(parsed.taskRef) }),
    ...(asOptionalString(parsed.model) === undefined ? {} : { model: asOptionalString(parsed.model) }),
    cwd: asOptionalString(parsed.cwd) ?? '',
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    lastUpdate: asOptionalNumber(parsed.lastUpdate) ?? startedAt,
    ...(asOptionalString(parsed.currentTool) === undefined
      ? {}
      : { currentTool: asOptionalString(parsed.currentTool) }),
    ...(asOptionalNumber(parsed.toolCount) === undefined ? {} : { toolCount: asOptionalNumber(parsed.toolCount) }),
    ...(asOptionalNumber(parsed.tokens) === undefined ? {} : { tokens: asOptionalNumber(parsed.tokens) }),
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
    tail,
  };
}

/**
 * Reads the runtime-owned process registry into the ids whose runner process is
 * still alive. An unreadable or foreign registry returns undefined so callers
 * fail open rather than hiding work whose lifecycle cannot be proven.
 */
export function activeRunIdsFromRegistry(
  raw: string,
  isAlive: (pid: number) => boolean,
): ReadonlySet<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.runs)) return undefined;

  const records: Array<{ runId: string; pid: number }> = [];
  for (const entry of parsed.runs) {
    if (!isRecord(entry)) return undefined;
    const runId = asOptionalString(entry.runId);
    const pid = asOptionalNumber(entry.pid);
    if (!runId || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    records.push({ runId, pid });
  }
  return new Set(records.filter((record) => isAlive(record.pid)).map((record) => record.runId));
}

/** Reconciles status snapshots that outlived their authoritative runner record. */
export function reconcileRunLifecycles(
  runs: readonly SubagentRun[],
  activeRunIds: ReadonlySet<string> | undefined,
): SubagentRun[] {
  if (activeRunIds === undefined) return [...runs];
  return runs.map((run) => {
    if (TERMINAL_STATES.has(run.state) || activeRunIds.has(run.runId)) return run;
    return { ...run, state: 'stopped', endedAt: run.endedAt ?? run.lastUpdate };
  });
}

/** Active runs first, then newest first; terminal runs leave after the retention window. */
export function presentRuns(runs: readonly SubagentRun[], now: number): SubagentRun[] {
  return runs
    .filter((run) => {
      if (!TERMINAL_STATES.has(run.state)) return true;
      return now - (run.endedAt ?? run.lastUpdate) < RUN_RETENTION_MS;
    })
    .sort((left, right) => {
      const leftActive = TERMINAL_STATES.has(left.state) ? 1 : 0;
      const rightActive = TERMINAL_STATES.has(right.state) ? 1 : 0;
      if (leftActive !== rightActive) return leftActive - rightActive;
      return right.startedAt - left.startedAt;
    });
}
