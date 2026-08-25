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
  reduceSession,
  type SessionState,
} from '../lib/sessionModel.ts';
import { sendFrame } from '../lib/transport.ts';
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
  sessionStoreFor(sessionId).setState((state) => reduceSession(state, frame));
}

/** A subscribe replays history from scratch; the fold must start clean too. */
export function resetSessionStore(sessionId: string): void {
  sessionStoreFor(sessionId).setState(() => initialSessionState);
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
