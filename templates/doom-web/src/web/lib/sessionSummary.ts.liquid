import type { SessionPhase } from '../../types/hub.ts';

/** The rail's view of one session's attach state; offline means the page lost the hub. */
export type AttachPhase = 'offline' | 'connecting' | 'attached' | 'refused' | 'detached' | 'closed';

export interface StatusLineInput {
  attach: AttachPhase;
  phase: SessionPhase;
  /** ISO 8601 timestamp of the last phase change. */
  phaseSince: string;
  awaitingInput: boolean;
  everPrompted: boolean;
  /** Set once any run finished; a settled session is not "fresh" even unprompted. */
  lastSettledAt?: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function formatRunDuration(elapsedMs: number): string {
  if (elapsedMs < MINUTE_MS) return '<1m';
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  const hours = Math.floor(elapsedMs / HOUR_MS);
  const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * The one mapping from session facts to the rail's status copy.
 *
 * Priority order: a refusal outranks everything because nothing else the card
 * says can be trusted while another client holds the session; a question to
 * the user outranks "running" because the run is blocked on them.
 */
export function sessionStatusLine(input: StatusLineInput, now: number): string {
  if (input.attach === 'refused') return 'another cockpit holds this session';
  if (input.awaitingInput) return 'waiting for your input';
  if (input.phase !== 'idle') {
    const since = Date.parse(input.phaseSince);
    return `running · ${formatRunDuration(Number.isFinite(since) ? Math.max(0, now - since) : 0)}`;
  }
  if (!input.everPrompted && input.lastSettledAt === undefined) return 'fresh session · nothing sent yet';
  return 'done · waiting for you';
}

/** Sessions counted as running by the rail header and the top bar chip. */
export function runningCount(phases: Iterable<SessionPhase>): number {
  let count = 0;
  for (const phase of phases) if (phase !== 'idle') count += 1;
  return count;
}

/** Shortens a home-rooted cwd the way a shell prompt would. */
export function abbreviateCwd(cwd: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/u.exec(cwd);
  if (!match) return cwd;
  return `~${cwd.slice(match[0].length)}`;
}
