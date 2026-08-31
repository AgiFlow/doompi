import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';
import {
  abortCommand,
  builtinCommandFrame,
  clearQueueCommand,
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
  type RpcImage,
  setModelCommand,
  setSessionNameCommand,
  setThinkingLevelCommand,
  steerCommand,
} from '../lib/commands.ts';
import {
  appendQueued,
  appendUserPrompt,
  clearDialog,
  clearQueuedEntries,
  isSupportedImageMimeType,
  initialSessionState,
  prependHistory,
  reduceSession,
  replaceQueuedEntries,
  removeQueuedEntry,
  type QueuedEntry,
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
/** Sessions whose visible transcript is currently supplied by Pi's protocol. */
const protocolTranscripts = new Set<string>();
const PROTOCOL_ENTRY_KINDS = new Set<TimelineEntry['kind']>(['user', 'assistant', 'tool']);
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
  // The legacy wire is the realtime and recovery fallback until Pi's protocol
  // publishes a snapshot. Once it does, only DoomPi-specific frames reduce here.
  const transcriptFromProtocol = protocolTranscripts.has(sessionId);
  sessionStoreFor(sessionId).setState((state) => reduceSession(state, frame, { transcriptFromProtocol }));
}

/** Lets the legacy stream resume transcript ownership after a protocol failure. */
export function releaseProtocolTranscript(sessionId: string): void {
  protocolTranscripts.delete(sessionId);
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

/** Keeps DoomPi-only and optimistic entries beside the protocol items that preceded them. */
function mergeProtocolEntries(
  previous: TimelineEntry[],
  protocol: TimelineEntry[],
  pendingUserIds: ReadonlySet<string>,
  reconciledUserIds: ReadonlySet<string>,
): TimelineEntry[] {
  const localByAnchor = new Map<string | null, TimelineEntry[]>();
  let anchor: string | null = null;
  for (const entry of previous) {
    const protocolOwned =
      (PROTOCOL_ENTRY_KINDS.has(entry.kind) || reconciledUserIds.has(entry.id)) && !pendingUserIds.has(entry.id);
    if (protocolOwned) {
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
  protocolTranscripts.add(sessionId);
  sessionStoreFor(sessionId).setState((state) => {
    const pendingUserEntries = [...state.pendingUserEntries];
    const pendingUserIdsBeforeReconciliation = new Set(pendingUserEntries.map((pending) => pending.id));
    const knownProtocolIds = new Set(
      state.entries
        .filter((entry) => PROTOCOL_ENTRY_KINDS.has(entry.kind) && !pendingUserIdsBeforeReconciliation.has(entry.id))
        .map((entry) => entry.id),
    );
    const protocolUserEntryIds = { ...state.protocolUserEntryIds };
    const normalizedEntries = [...entries];
    // Claimed prompts are remembered rather than dropped: the journal reports
    // the same message on its own channel, and that copy has to fold into this
    // entry instead of arriving as a new one.
    const reconciledUserEntries = [...state.reconciledUserEntries];

    // Work backwards so repeated text binds to the newest matching prompt. The
    // local id keeps React from mounting the same message again when Pi publishes
    // its authoritative transcript copy at the end of a run.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind !== 'user') continue;
      const localId = protocolUserEntryIds[entry.id];
      if (localId !== undefined) {
        normalizedEntries[index] = { ...entry, id: localId };
        continue;
      }
      if (knownProtocolIds.has(entry.id)) continue;
      const pendingIndex = pendingUserEntries.findLastIndex((pending) => pending.text === entry.text);
      if (pendingIndex === -1) continue;
      const [pending] = pendingUserEntries.splice(pendingIndex, 1);
      if (pending === undefined) continue;
      protocolUserEntryIds[entry.id] = pending.id;
      reconciledUserEntries.push(pending);
      normalizedEntries[index] = { ...entry, id: pending.id };
    }

    const pendingUserIds = new Set(pendingUserEntries.map((pending) => pending.id));
    const reconciledUserIds = new Set(Object.values(protocolUserEntryIds));
    return {
      ...state,
      entries: mergeProtocolEntries(state.entries, normalizedEntries, pendingUserIds, reconciledUserIds),
      streaming,
      settled: !streaming,
      pendingUserEntries,
      reconciledUserEntries,
      protocolUserEntryIds,
    };
  });
}

function protocolQueueMatches(state: SessionState, queue: readonly QueuedEntry[]): boolean {
  const current = state.entries.filter((entry): entry is QueuedEntry => entry.kind === 'queued');
  return (
    current.length === queue.length &&
    current.every((entry, index) => {
      const next = queue[index];
      if (next === undefined || entry.text !== next.text) return false;
      const images = entry.images ?? [];
      const nextImages = next.images ?? [];
      return (
        images.length === nextImages.length &&
        images.every((image, imageIndex) => {
          const nextImage = nextImages[imageIndex];
          return nextImage !== undefined && image.data === nextImage.data && image.mimeType === nextImage.mimeType;
        })
      );
    })
  );
}

/** Replaces composer queue rows with the protocol server's authoritative queue. */
export function applyProtocolQueue(sessionId: string, queue: readonly QueuedEntry[]): void {
  sessionStoreFor(sessionId).setState((state) =>
    protocolQueueMatches(state, queue) ? state : replaceQueuedEntries(state, queue),
  );
}
export function resetSessionStore(sessionId: string): void {
  sessionStoreFor(sessionId).setState((state) => {
    if (!protocolTranscripts.has(sessionId)) return initialSessionState;
    // A legacy socket reconnect replays its backlog. Keep the protocol snapshot
    // visible while that replay rebuilds DoomPi-only state around it.
    const entries = state.entries.filter((entry) => PROTOCOL_ENTRY_KINDS.has(entry.kind));
    return {
      ...initialSessionState,
      entries,
      streaming: state.streaming,
      settled: state.settled,
      pendingUserEntries: state.pendingUserEntries,
      reconciledUserEntries: state.reconciledUserEntries,
      protocolUserEntryIds: state.protocolUserEntryIds,
    };
  });
  history.delete(sessionId);
  historyStore.setState((state) => {
    const { [sessionId]: _dropped, ...rest } = state;
    return rest;
  });
}

export function dropSessionStore(sessionId: string): void {
  stores.delete(sessionId);
  protocolTranscripts.delete(sessionId);
}

export function resetSessionStores(): void {
  stores.clear();
  protocolTranscripts.clear();
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
export function submitMessage(
  text: string,
  images: RpcImage[] = [],
  sessionId: string | null = activeSessionId(),
): void {
  const trimmed = text.trim();
  if (!trimmed || sessionId === null) return;
  const store = sessionStoreFor(sessionId);
  // A built-in is an action, not something to say: steering the run with the
  // text, or prompting with it, would reach the model as literal characters.
  const builtin = builtinCommandFrame(trimmed);
  if (builtin) {
    store.setState((state) => appendUserPrompt(state, trimmed));
    sendFrame(sessionId, builtin);
    return;
  }
  const streaming = store.state.streaming;
  const userImages = images
    .filter((image) => isSupportedImageMimeType(image.mimeType))
    .map(({ data, mimeType }) => ({ data, mimeType }));
  store.setState((state) => appendUserPrompt(state, trimmed, userImages));
  sendFrame(sessionId, streaming ? steerCommand(trimmed, images) : promptCommand(trimmed, images));
}

export function queueFollowUp(
  text: string,
  images: RpcImage[] = [],
  sessionId: string | null = activeSessionId(),
): void {
  const trimmed = text.trim();
  if (!trimmed || sessionId === null) return;
  const userImages = images
    .filter((image) => isSupportedImageMimeType(image.mimeType))
    .map(({ data, mimeType }) => ({ data, mimeType }));
  sessionStoreFor(sessionId).setState((state) => appendQueued(state, trimmed, userImages));
  sendFrame(sessionId, followUpCommand(trimmed, images));
}

export function clearQueuedMessages(sessionId: string | null = activeSessionId()): void {
  if (sessionId === null) return;
  sessionStoreFor(sessionId).setState(clearQueuedEntries);
  sendFrame(sessionId, clearQueueCommand());
}

/**
 * Deletes one queued message through Pi's clear-only RPC queue contract.
 *
 * Clearing and replaying is safe only with a complete browser snapshot. The UI
 * passes the authoritative count and disables this action while any rows are
 * unlisted, so an unseen message is never lost during reconstruction.
 */
export function deleteQueuedMessage(
  id: string,
  knownQueueCount: number,
  sessionId: string | null = activeSessionId(),
): void {
  if (sessionId === null) return;
  const store = sessionStoreFor(sessionId);
  const queued = store.state.entries.filter((entry): entry is QueuedEntry => entry.kind === 'queued');
  if (queued.length !== knownQueueCount || !queued.some((entry) => entry.id === id)) return;
  const remaining = queued.filter((entry) => entry.id !== id);
  store.setState((state) => removeQueuedEntry(state, id));
  sendFrame(sessionId, clearQueueCommand());
  for (const entry of remaining) {
    const images: RpcImage[] = (entry.images ?? []).map((image) => ({ type: 'image', ...image }));
    sendFrame(
      sessionId,
      entry.delivery === 'steer' ? steerCommand(entry.text, images) : followUpCommand(entry.text, images),
    );
  }
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
  sendFrame(sessionId, builtinCommandFrame(slashed) ?? promptCommand(slashed));
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
