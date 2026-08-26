import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import {
  abortCommand,
  dialogCancelled,
  dialogConfirmed,
  dialogValue,
  followUpCommand,
  getAvailableModelsCommand,
  getAvailableThinkingLevelsCommand,
  getCommandsCommand,
  getSessionStatsCommand,
  getStateCommand,
  promptCommand,
  setModelCommand,
  setSessionNameCommand,
  setThinkingLevelCommand,
  steerCommand,
} from '../lib/commands.ts';
import {
  appendQueued,
  appendUserPrompt,
  clearDialog,
  initialSessionState,
  prependHistory,
  reduceSession,
  type SessionState,
  type TimelineEntry,
} from '../lib/sessionModel.ts';
import { HISTORY_REQUEST_TYPE } from '../../types/hub.ts';
import { sendFrame, sendHubFrame } from '../lib/transport.ts';
import { activeSessionId, sessionsStore } from './sessionsStore.ts';

/**
 * One store per session, created on first touch.
 *
 * The heavyweight timeline state only exists for sessions this page has
 * subscribed to; the rail runs on hub summaries alone.
 */
const stores = new Map<string, Store<SessionState>>();

/** Read-only stand-in while no session is focused, so hooks stay unconditional. */
const detachedStore = new Store<SessionState>(initialSessionState);

export function sessionStoreFor(sessionId: string | null): Store<SessionState> {
  if (sessionId === null) return detachedStore;
  const existing = stores.get(sessionId);
  if (existing) return existing;
  const created = new Store<SessionState>(initialSessionState);
  stores.set(sessionId, created);
  return created;
}

/** Reads the focused session's state; components stay on the useStore idiom. */
export function useActiveSession<T>(selector: (state: SessionState) => T): T {
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  return useStore(sessionStoreFor(activeId), selector);
}

export function applySessionFrame(sessionId: string, frame: Record<string, unknown>): void {
  // The transcript arrives over Pi's protocol; this wire carries what the
  // protocol has no shape for.
  sessionStoreFor(sessionId).setState((state) => reduceSession(state, frame, { transcriptFromProtocol: true }));
}

/** A thread has no protocol session, so its journal remains its authoritative transcript. */
export function applyThreadFrame(threadKey: string, frame: Record<string, unknown>): void {
  sessionStoreFor(threadKey).setState((state) => reduceSession(state, frame));
}

/**
 * One session's paging state: how far back the page has read, and whether a
 * request is already in flight. Kept beside the timeline rather than inside it
 * because it describes the reading, not the session.
 */
interface HistoryState {
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  /** Pages taken so far; also what keeps prepended entry ids unique. */
  pages: number;
}

const history = new Map<string, HistoryState>();
const historyStore = new Store<Record<string, HistoryState>>({});
const NO_HISTORY: HistoryState = { cursor: null, hasMore: true, loading: false, pages: 0 };

function historyFor(sessionId: string): HistoryState {
  return history.get(sessionId) ?? NO_HISTORY;
}

function setHistory(sessionId: string, next: HistoryState): void {
  history.set(sessionId, next);
  historyStore.setState((state) => ({ ...state, [sessionId]: next }));
}

/** Whether more transcript exists above what this session's page holds. */
export function useHasOlderHistory(sessionId: string | null): boolean {
  return useStore(historyStore, (state) => (sessionId === null ? false : (state[sessionId] ?? NO_HISTORY).hasMore));
}

/**
 * Asks the hub for the window above what this page holds.
 *
 * One request at a time: a reader flicking upwards would otherwise ask for the
 * same window repeatedly before the first answer lands, and every copy would
 * be prepended.
 */
export function requestOlderHistory(sessionId: string | null): void {
  if (sessionId === null) return;
  const current = historyFor(sessionId);
  if (current.loading || !current.hasMore) return;
  setHistory(sessionId, { ...current, loading: true });
  sendHubFrame({
    type: HISTORY_REQUEST_TYPE,
    sessionId,
    ...(current.cursor === null ? {} : { before: current.cursor }),
  });
}

/** Folds one answered window above the timeline and records how far back it reached. */
export function applyHistoryPage(sessionId: string, frames: Record<string, unknown>[], next: HistoryPage): void {
  const current = historyFor(sessionId);
  const pages = current.pages + 1;
  sessionStoreFor(sessionId).setState((state) => prependHistory(state, frames, pages));
  setHistory(sessionId, { cursor: next.cursor, hasMore: next.hasMore, loading: false, pages });
}

export interface HistoryPage {
  cursor: string | null;
  hasMore: boolean;
}

/** The oldest entry the page holds, which is where the next window ends. */
export function seedHistoryCursor(sessionId: string, cursor: string | null): void {
  setHistory(sessionId, { ...NO_HISTORY, cursor });
}

/** Keeps DoomPi-only timeline entries beside the protocol items that preceded them. */
function mergeProtocolEntries(previous: TimelineEntry[], protocol: TimelineEntry[]): TimelineEntry[] {
  const protocolKinds = new Set(['user', 'assistant', 'tool']);
  const localByAnchor = new Map<string | null, TimelineEntry[]>();
  let anchor: string | null = null;
  for (const entry of previous) {
    if (protocolKinds.has(entry.kind)) {
      anchor = entry.id;
      continue;
    }
    const local = localByAnchor.get(anchor) ?? [];
    local.push(entry);
    localByAnchor.set(anchor, local);
  }

  const merged = [...(localByAnchor.get(null) ?? [])];
  const used = new Set<string | null>([null]);
  for (const entry of protocol) {
    merged.push(entry, ...(localByAnchor.get(entry.id) ?? []));
    used.add(entry.id);
  }
  for (const [entryAnchor, local] of localByAnchor) {
    if (!used.has(entryAnchor)) merged.push(...local);
  }
  return merged;
}

/**
 * Replaces protocol-owned transcript items with the authoritative snapshot.
 *
 * Local echoes disappear when the protocol publishes them. DoomPi-only entries,
 * such as notices, queued messages, and run dividers, retain their place beside
 * the protocol item that preceded them.
 */
export function applyProtocolTranscript(sessionId: string, entries: TimelineEntry[], streaming: boolean): void {
  sessionStoreFor(sessionId).setState((state) => ({
    ...state,
    entries: mergeProtocolEntries(state.entries, entries),
    streaming,
    settled: !streaming,
    pendingUserId: null,
    pendingUserText: '',
  }));
}

export function resetSessionStore(sessionId: string): void {
  sessionStoreFor(sessionId).setState(() => initialSessionState);
  history.delete(sessionId);
  historyStore.setState((state) => {
    const { [sessionId]: _dropped, ...rest } = state;
    return rest;
  });
}

export function dropSessionStore(sessionId: string): void {
  stores.delete(sessionId);
}

export function resetSessionStores(): void {
  stores.clear();
  detachedStore.setState(() => initialSessionState);
}

/** Asks for the facts the cockpit shows but Pi only reports on request. */
export function refreshSessionFacts(sessionId: string): void {
  sendFrame(sessionId, getStateCommand());
  sendFrame(sessionId, getSessionStatsCommand());
  sendFrame(sessionId, getCommandsCommand());
}

/** Asks what the model picker lists; Pi's answer depends on the current model. */
export function loadModelChoices(sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, getAvailableModelsCommand());
  sendFrame(sessionId, getAvailableThinkingLevelsCommand());
}

/**
 * Switches the model, then re-reads the facts Pi adjusts alongside it: the
 * thinking level gets clamped to what the new model accepts, and the level
 * list changes with it.
 */
export function selectModel(provider: string, modelId: string, sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, setModelCommand(provider, modelId));
  sendFrame(sessionId, getStateCommand());
  sendFrame(sessionId, getAvailableThinkingLevelsCommand());
}

/** The set reply carries nothing back, so get_state is what updates the chip. */
export function selectThinkingLevel(level: string, sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, setThinkingLevelCommand(level));
  sendFrame(sessionId, getStateCommand());
}

/**
 * Sends a prompt, or steers the run when one is already in flight.
 *
 * Pi rejects a prompt while the agent is working, so the composer picks the
 * verb from the run state rather than making the reader remember which is
 * legal. Every action defaults to the focused session and is a no-op when
 * nothing is focused.
 */
export function submitMessage(text: string, sessionId: string | null = activeSessionId()): void {
  const trimmed = text.trim();
  if (!trimmed || sessionId === null) return;
  const store = sessionStoreFor(sessionId);
  const streaming = store.state.streaming;
  store.setState((state) => appendUserPrompt(state, trimmed));
  sendFrame(sessionId, streaming ? steerCommand(trimmed) : promptCommand(trimmed));
}

export function queueFollowUp(text: string, sessionId: string | null = activeSessionId()): void {
  const trimmed = text.trim();
  if (!trimmed || sessionId === null) return;
  sessionStoreFor(sessionId).setState((state) => appendQueued(state, trimmed));
  sendFrame(sessionId, followUpCommand(trimmed));
}

/**
 * Renames the session where the name actually lives: in the agent. Pi keeps
 * it in the session file and reports it back through get_state, which is
 * what the hub folds into every page's rail card.
 */
export function renameSession(name: string, sessionId: string | null = activeSessionId()): void {
  const trimmed = name.trim();
  if (!trimmed || sessionId === null) return;
  sendFrame(sessionId, setSessionNameCommand(trimmed));
  sendFrame(sessionId, getStateCommand());
}

export function abortRun(sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, abortCommand());
}

export function runCommand(name: string, sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  const slashed = name.startsWith('/') ? name : `/${name}`;
  sessionStoreFor(sessionId).setState((state) => appendUserPrompt(state, slashed));
  sendFrame(sessionId, promptCommand(slashed));
}

export function answerDialogValue(id: string, value: string, sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, dialogValue(id, value));
  sessionStoreFor(sessionId).setState(clearDialog);
}

export function answerDialogConfirm(
  id: string,
  confirmed: boolean,
  sessionId: string | null = activeSessionId(),
): void {
  if (sessionId === null) return;
  sendFrame(sessionId, dialogConfirmed(id, confirmed));
  sessionStoreFor(sessionId).setState(clearDialog);
}

export function cancelDialog(id: string, sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sendFrame(sessionId, dialogCancelled(id));
  sessionStoreFor(sessionId).setState(clearDialog);
}
