import type { TransientTab } from '@agimon-ai/doompi-core/web';
import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';

type TransientTabsState = Partial<Record<string, TransientTab[]>>;

/** One stable empty list, so a selector for a session with no tabs never re-renders its reader. */
const NO_TABS: readonly TransientTab[] = [];

/**
 * The tabs plugins opened at runtime, per session. A tab keeps the panel it
 * was opened with: opening the same id again focuses it rather than swapping
 * the component out from under React. Nothing here survives a reload, which
 * is what makes the tabs temporary.
 */
export const transientTabsStore = new Store<TransientTabsState>({});

export function transientTabsOf(state: TransientTabsState, sessionId: string | null): readonly TransientTab[] {
  return (sessionId === null ? undefined : state[sessionId]) ?? NO_TABS;
}

export function findTransientTab(
  state: TransientTabsState,
  sessionId: string | undefined,
  tabId: string | undefined,
): TransientTab | undefined {
  if (sessionId === undefined || tabId === undefined) return undefined;
  return transientTabsOf(state, sessionId).find((tab) => tab.id === tabId);
}

export function openTransientTab(sessionId: string, tab: TransientTab): void {
  if (findTransientTab(transientTabsStore.state, sessionId, tab.id) !== undefined) return;
  transientTabsStore.setState((state) => ({ ...state, [sessionId]: [...(state[sessionId] ?? []), tab] }));
  tab.onOpen?.(sessionId);
}

export function closeTransientTab(sessionId: string, tabId: string): void {
  const tab = findTransientTab(transientTabsStore.state, sessionId, tabId);
  if (tab === undefined) return;
  transientTabsStore.setState((state) => ({
    ...state,
    [sessionId]: (state[sessionId] ?? []).filter((candidate) => candidate.id !== tabId),
  }));
  tab.onClose?.(sessionId);
}

/** A session that left takes its tabs with it. */
export function dropTransientTabs(sessionId: string): void {
  const tabs = transientTabsStore.state[sessionId];
  if (tabs === undefined) return;
  transientTabsStore.setState((state) => {
    const next = { ...state };
    delete next[sessionId];
    return next;
  });
  for (const tab of tabs) tab.onClose?.(sessionId);
}

export function resetTransientTabs(): void {
  const previous = transientTabsStore.state;
  transientTabsStore.setState(() => ({}));
  for (const [sessionId, tabs] of Object.entries(previous)) {
    for (const tab of tabs ?? []) tab.onClose?.(sessionId);
  }
}

export function useTransientTabs(sessionId: string | null): readonly TransientTab[] {
  return useStore(transientTabsStore, (state) => transientTabsOf(state, sessionId));
}
