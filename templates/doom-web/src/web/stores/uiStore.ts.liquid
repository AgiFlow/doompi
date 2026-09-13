import { Store } from '@tanstack/store';

/** Where the page remembers its chrome layout; one key per machine. */
const DOCK_STORAGE_KEY = 'doompi.web.dock';
const DOCK_TAB_STORAGE_KEY = 'doompi.web.dock-tab';

/**
 * Which face of the dock is showing. The host owns `activity` and `context`;
 * installed plugins may contribute additional opaque ids.
 */
export type DockTab = string;
export interface UiState {
  /** Whether the activity dock is shown; survives route changes and reloads. */
  dockOpen: boolean;
  /** Which dock tab is selected; survives route changes and reloads. */
  dockTab: DockTab;
}

function readDock(): boolean {
  try {
    return window.localStorage.getItem(DOCK_STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function readDockTab(): DockTab {
  try {
    return window.localStorage.getItem(DOCK_TAB_STORAGE_KEY)?.trim() || 'activity';
  } catch {
    return 'activity';
  }
}

export const uiStore = new Store<UiState>({ dockOpen: readDock(), dockTab: readDockTab() });

export function setDockOpen(open: boolean): void {
  uiStore.setState((state) => (state.dockOpen === open ? state : { ...state, dockOpen: open }));
  try {
    window.localStorage.setItem(DOCK_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // A layout preference is a convenience; losing it costs one click.
  }
}

export function setDockTab(tab: DockTab): void {
  uiStore.setState((state) => (state.dockTab === tab ? state : { ...state, dockTab: tab }));
  try {
    window.localStorage.setItem(DOCK_TAB_STORAGE_KEY, tab);
  } catch {
    // A layout preference is a convenience; losing it costs one click.
  }
}
