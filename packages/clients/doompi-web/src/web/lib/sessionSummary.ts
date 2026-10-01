import type { SessionPhase } from '../../types/hub';

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
  /** Recorded by the hub but not running; opening it is what starts it. */
  dormant?: boolean;
  /** A line an extension published about background work it runs for the session. */
  activity?: { label: string; since?: string };
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
  // Ranked above the phase fields because a dormant card's phase is a default,
  // not an observation: there is no runtime to have reported one.
  if (input.dormant === true) return 'stopped · open to wake';
  if (input.awaitingInput) return 'waiting for your input';
  if (input.phase !== 'idle') {
    const since = Date.parse(input.phaseSince);
    return `running · ${formatRunDuration(Number.isFinite(since) ? Math.max(0, now - since) : 0)}`;
  }
  // Background work outranks the idle copy: an agent waiting on a workflow is not "done".
  if (input.activity !== undefined) {
    const since = input.activity.since === undefined ? Number.NaN : Date.parse(input.activity.since);
    return Number.isFinite(since)
      ? `${input.activity.label} · ${formatRunDuration(Math.max(0, now - since))}`
      : input.activity.label;
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

/** Two letters standing in for a persona avatar: the first letters of two words, or one word's first two. */
export function personaInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0]?.slice(0, 2) ?? '');
  return letters.toUpperCase() || 'DP';
}

/** Shortens a home-rooted cwd the way a shell prompt would. */
export function abbreviateCwd(cwd: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/u.exec(cwd);
  if (!match) return cwd;
  return `~${cwd.slice(match[0].length)}`;
}
