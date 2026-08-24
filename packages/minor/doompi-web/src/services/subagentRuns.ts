import { createHash } from 'node:crypto';
import type { SubagentRun, SubagentRunState } from '../types/hub.ts';

/**
 * MIRRORS @agimon-ai/doompi-team's on-disk run layout
 * (layers/team/doompi-team/src/adapters/filesystem/paths.ts and
 * runs/background/asyncExecution.ts). The team runtime writes one directory
 * per session scope under the OS temp root and one status.json per run; the
 * hub only ever reads them. The derivation is duplicated rather than imported
 * because doompi-web must not depend on the team package at runtime.
 */
const TEMP_ROOT_PREFIX = 'doom-team';
const SESSIONS_DIR_NAME = 'sessions';
const RUNS_DIR_NAME = 'runs';
const SCOPE_KEY_HASH_LENGTH = 16;
export const RUN_STATUS_FILE_NAME = 'status.json';

const TAIL_LIMIT = 12;
const TAIL_ENTRY_LIMIT = 200;
/** Terminal runs older than this leave the fleet the page sees. */
export const RUN_RETENTION_MS = 10 * 60 * 1000;

const STATE_MAP: Readonly<Record<string, SubagentRunState>> = {
  queued: 'queued',
  running: 'running',
  complete: 'done',
  completed: 'done',
  failed: 'failed',
  paused: 'stopped',
  stopped: 'stopped',
};

const TERMINAL_STATES: ReadonlySet<SubagentRunState> = new Set(['done', 'failed', 'stopped']);

export interface TeamRunsDirInput {
  /** The Pi session id, which doom-team scopes its runs by. */
  sessionId: string;
  /** os.tmpdir(), supplied by the caller. */
  tmpdir: string;
  /** process.getuid(), absent on platforms without one. */
  uid: number | undefined;
}

/** Where doom-team keeps this session's runs, or undefined when the user cannot be scoped. */
export function teamRunsDirFor(input: TeamRunsDirInput): string | undefined {
  if (input.uid === undefined) return undefined;
  const scopeKey = createHash('sha256').update(input.sessionId.trim()).digest('hex').slice(0, SCOPE_KEY_HASH_LENGTH);
  return `${input.tmpdir}/${TEMP_ROOT_PREFIX}-uid-${input.uid}/${SESSIONS_DIR_NAME}/${scopeKey}/${RUNS_DIR_NAME}`;
}

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
