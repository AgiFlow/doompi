import type { TransientTab } from '@agimon-ai/doompi-web-contracts';
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
  transientTabsStore.setState((state) => {
    const current = state[sessionId] ?? [];
    if (current.some((existing) => existing.id === tab.id)) return state;
    return { ...state, [sessionId]: [...current, tab] };
  });
}

export function closeTransientTab(sessionId: string, tabId: string): void {
  transientTabsStore.setState((state) => {
    const current = state[sessionId];
    if (current === undefined || !current.some((tab) => tab.id === tabId)) return state;
    return { ...state, [sessionId]: current.filter((tab) => tab.id !== tabId) };
  });
}

/** A session that left takes its tabs with it. */
export function dropTransientTabs(sessionId: string): void {
  transientTabsStore.setState((state) => {
    if (!(sessionId in state)) return state;
    const next = { ...state };
    delete next[sessionId];
    return next;
  });
}

export function resetTransientTabs(): void {
  transientTabsStore.setState(() => ({}));
}

export function useTransientTabs(sessionId: string | null): readonly TransientTab[] {
  return useStore(transientTabsStore, (state) => transientTabsOf(state, sessionId));
}
