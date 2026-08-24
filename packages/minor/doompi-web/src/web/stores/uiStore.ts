import { Store } from '@tanstack/store';

/** Where the page remembers its chrome layout; one key per machine. */
const DOCK_STORAGE_KEY = 'doompi.web.dock';

export interface UiState {
  /** Whether the activity dock is shown; survives route changes and reloads. */
  dockOpen: boolean;
}

function readDock(): boolean {
  try {
    return window.localStorage.getItem(DOCK_STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export const uiStore = new Store<UiState>({ dockOpen: readDock() });

export function setDockOpen(open: boolean): void {
  uiStore.setState((state) => (state.dockOpen === open ? state : { ...state, dockOpen: open }));
  try {
    window.localStorage.setItem(DOCK_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // A layout preference is a convenience; losing it costs one click.
  }
}
