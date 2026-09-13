import { Store } from '@tanstack/store';

/**
 * Whether the new-session dialog is open.
 *
 * There are three ways in and they are in two different columns: ctrl+t and
 * the rail's plus on one side, the welcome panel's button on the other. A flag
 * held by whichever component happens to mount the dialog would put the other
 * column's button out of reach, and a feature may not import a sibling, so the
 * flag lives here and the dialog stays mounted once in the rail.
 */
export interface NewSessionState {
  open: boolean;
}

export const newSessionStore = new Store<NewSessionState>({ open: false });

export function openNewSession(): void {
  newSessionStore.setState((state) => (state.open ? state : { open: true }));
}

export function closeNewSession(): void {
  newSessionStore.setState((state) => (state.open ? { open: false } : state));
}

/** Test seam. */
export function resetNewSessionStore(): void {
  newSessionStore.setState(() => ({ open: false }));
}
