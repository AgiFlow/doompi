import type { SessionPhase } from '../types/hub.ts';
import type { SessionFrame } from '../types/session.ts';

const DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'];

/**
 * What one session's frame stream says it is doing.
 *
 * Reduced by the hub for every session it holds, attached or not focused, so
 * the rail can describe sessions nobody is looking at. The reducer returns the
 * SAME object when a frame changes nothing it reports; callers use that
 * reference equality to skip redundant summary pushes.
 */
export interface SessionPresence {
  phase: SessionPhase;
  /** ISO 8601 timestamp of the last phase change. */
  phaseSince: string;
  /** ISO 8601 timestamp of the last change to any reported fact. */
  updatedAt: string;
  pendingMessageCount: number;
  everPrompted: boolean;
  awaitingInput: boolean;
  lastSettledAt?: string;
  /** Name reported by get_state, fresher than the registry record when set. */
  sessionName?: string;
}

export function initialPresence(now: string): SessionPresence {
  return {
    phase: 'idle',
    phaseSince: now,
    updatedAt: now,
    pendingMessageCount: 0,
    everPrompted: false,
    awaitingInput: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withPhase(presence: SessionPresence, phase: SessionPhase, now: string): SessionPresence {
  if (presence.phase === phase) return presence;
  return { ...presence, phase, phaseSince: now, updatedAt: now };
}

function applyState(presence: SessionPresence, data: Record<string, unknown>, now: string): SessionPresence {
  let next = presence;
  const phase: SessionPhase = data.isCompacting === true ? 'compaction' : data.isStreaming === true ? 'turn' : 'idle';
  next = withPhase(next, phase, now);
  const pending = typeof data.pendingMessageCount === 'number' ? data.pendingMessageCount : next.pendingMessageCount;
  if (pending !== next.pendingMessageCount) next = { ...next, pendingMessageCount: pending, updatedAt: now };
  const name = typeof data.sessionName === 'string' && data.sessionName !== '' ? data.sessionName : undefined;
  if (name !== undefined && name !== next.sessionName) next = { ...next, sessionName: name, updatedAt: now };
  return next;
}

/**
 * Folds one agent frame into the presence.
 *
 * Pure and total like reduceSession: an unrecognised frame changes nothing.
 */
export function reducePresence(presence: SessionPresence, frame: SessionFrame, now: string): SessionPresence {
  switch (frame.type) {
    case 'replay':
      return isRecord(frame.frame) ? reducePresence(presence, frame.frame, now) : presence;

    case 'agent_start': {
      const started = withPhase(presence, 'turn', now);
      if (!started.awaitingInput) return started;
      return { ...started, awaitingInput: false, updatedAt: now };
    }

    case 'agent_settled': {
      const settled = withPhase(presence, 'idle', now);
      return { ...settled, awaitingInput: false, lastSettledAt: now, updatedAt: now };
    }

    case 'extension_ui_request': {
      if (typeof frame.method !== 'string' || !DIALOG_METHODS.includes(frame.method)) return presence;
      if (presence.awaitingInput) return presence;
      return { ...presence, awaitingInput: true, updatedAt: now };
    }

    case 'response':
      return frame.command === 'get_state' && isRecord(frame.data) ? applyState(presence, frame.data, now) : presence;

    default:
      return presence;
  }
}

/**
 * Folds one entry restored from the session's journal.
 *
 * A session outlives every hub that watches it, so "has this ever been
 * prompted" cannot be answered from what this process happened to see: a hub
 * that restarts, or meets a session first driven from the TUI, saw nothing. A
 * journalled user message is the proof, and without it a session carrying an
 * hour of work introduces itself in the rail as fresh.
 */
export function presenceAfterRestoredEntry(
  presence: SessionPresence,
  entry: Record<string, unknown>,
  now: string,
): SessionPresence {
  if (presence.everPrompted || entry.type !== 'message') return presence;
  const message = entry.message;
  if (typeof message !== 'object' || message === null) return presence;
  if ((message as { role?: unknown }).role !== 'user') return presence;
  return { ...presence, everPrompted: true, updatedAt: now };
}

/**
 * Folds one page command heading to the agent.
 *
 * The prompt direction carries facts the event stream does not repeat: that
 * the session has ever been prompted, and that a pending dialog was answered.
 */
export function presenceAfterCommand(presence: SessionPresence, frame: SessionFrame, now: string): SessionPresence {
  if (frame.type === 'prompt' || frame.type === 'steer' || frame.type === 'follow_up') {
    if (presence.everPrompted) return presence;
    return { ...presence, everPrompted: true, updatedAt: now };
  }
  if (frame.type === 'extension_ui_response') {
    if (!presence.awaitingInput) return presence;
    return { ...presence, awaitingInput: false, updatedAt: now };
  }
  return presence;
}
