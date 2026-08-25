import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import type { SessionSummary } from '../../types/hub.ts';
import type { AttachPhase } from '../lib/sessionSummary.ts';

/** One rail entry: the hub's summary plus this page's view of its connection. */
export interface SessionMeta {
  summary: SessionSummary;
  /** summary.attach adjusted for sticky refusals and a lost page socket. */
  attach: AttachPhase;
  reason: string;
  /** Frames replayed into this page's timeline on the last subscribe. */
  replayed: number;
  /** Frames the hub's bounded ring lost before this page subscribed. */
  dropped: number;
}

export interface SessionsState {
  /** Session ids sorted by creation, the rail's order and the ordinal shortcuts. */
  order: string[];
  byId: Record<string, SessionMeta>;
  activeId: string | null;
  /** False until the first snapshot; routing waits for it before redirecting. */
  hydrated: boolean;
}

const initialState: SessionsState = { order: [], byId: {}, activeId: null, hydrated: false };

export const sessionsStore = new Store<SessionsState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSummary(value: unknown): SessionSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return undefined;
  return value as unknown as SessionSummary;
}

function sortedOrder(byId: Record<string, SessionMeta>): string[] {
  return Object.keys(byId).sort((left, right) => {
    const a = byId[left].summary;
    const b = byId[right].summary;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

function mergeSummary(previous: SessionMeta | undefined, summary: SessionSummary): SessionMeta {
  // A refusal is sticky: the hub keeps retrying underneath, and reporting each
  // attempt would flicker the card between "refused" and "connecting" while
  // nothing has actually changed. Only a successful attach clears it.
  const sticky = previous?.attach === 'refused' && summary.attach === 'connecting';
  return {
    summary,
    attach: sticky ? 'refused' : summary.attach,
    reason: sticky ? previous.reason : (summary.attachReason ?? ''),
    replayed: previous?.replayed ?? 0,
    dropped: previous?.dropped ?? 0,
  };
}

export function applySessionsSnapshot(frame: Record<string, unknown>): void {
  if (!Array.isArray(frame.sessions)) return;
  const summaries = frame.sessions.map(asSummary).filter((summary): summary is SessionSummary => Boolean(summary));
  sessionsStore.setState((state) => {
    const byId: Record<string, SessionMeta> = {};
    for (const summary of summaries) byId[summary.id] = mergeSummary(state.byId[summary.id], summary);
    return { ...state, byId, order: sortedOrder(byId), hydrated: true };
  });
}

export function applySessionUpsert(frame: Record<string, unknown>): void {
  const summary = asSummary(frame.session);
  if (!summary) return;
  sessionsStore.setState((state) => {
    const byId = { ...state.byId, [summary.id]: mergeSummary(state.byId[summary.id], summary) };
    return { ...state, byId, order: sortedOrder(byId) };
  });
}

export function applySessionRemoved(frame: Record<string, unknown>): void {
  const sessionId = frame.sessionId;
  if (typeof sessionId !== 'string') return;
  sessionsStore.setState((state) => {
    if (!(sessionId in state.byId)) return state;
    const byId = { ...state.byId };
    delete byId[sessionId];
    return { ...state, byId, order: sortedOrder(byId) };
  });
}

/** Records what the hub replayed into this page when a subscription started. */
export function applySessionBacklog(sessionId: string, replayed: number, dropped: number): void {
  sessionsStore.setState((state) => {
    const meta = state.byId[sessionId];
    if (!meta) return state;
    return { ...state, byId: { ...state.byId, [sessionId]: { ...meta, replayed, dropped } } };
  });
}

/**
 * The page socket died; every session is unreachable until it comes back.
 * Self-healing: the snapshot on reconnect restores the real states.
 */
export function markSocketClosed(): void {
  sessionsStore.setState((state) => {
    const byId: Record<string, SessionMeta> = {};
    for (const [id, meta] of Object.entries(state.byId)) {
      byId[id] = { ...meta, attach: 'offline', reason: 'The cockpit lost its bridge.' };
    }
    return { ...state, byId };
  });
}

const APPEAR_TIMEOUT_MS = 15_000;

/**
 * Resolves once the session shows up in the rail, or false on timeout.
 *
 * A freshly created session exists on disk before its upsert reaches this
 * page; navigating to it too early trips the unknown-session fallback and
 * bounces the user back. Waiting here is what makes "create, then land on it"
 * one motion.
 */
export function waitForSession(sessionId: string, timeoutMs = APPEAR_TIMEOUT_MS): Promise<boolean> {
  if (sessionId in sessionsStore.state.byId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (found: boolean): void => {
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve(found);
    };
    const subscription = sessionsStore.subscribe(() => {
      if (sessionId in sessionsStore.state.byId) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/** Reads the focused session's rail entry, or null while nothing is focused. */
export function useActiveSessionMeta(): SessionMeta | null {
  return useStore(sessionsStore, (state) => (state.activeId !== null ? (state.byId[state.activeId] ?? null) : null));
}

export function setActiveSession(sessionId: string | null): void {
  sessionsStore.setState((state) => (state.activeId === sessionId ? state : { ...state, activeId: sessionId }));
}

export function activeSessionId(): string | null {
  return sessionsStore.state.activeId;
}

export function resetSessions(): void {
  sessionsStore.setState(() => initialState);
}
