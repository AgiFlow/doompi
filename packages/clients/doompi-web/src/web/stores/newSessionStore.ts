import { Store } from '@tanstack/store';

/** The shared rail dialog and the workspace a new session belongs to. */
export interface NewSessionState {
  open: boolean;
  /** Null means admit a workspace first instead of creating a session. */
  workspaceId: string | null;
}

const initialState: NewSessionState = { open: false, workspaceId: null };

export const newSessionStore = new Store<NewSessionState>(initialState);

export function openNewSession(workspaceId: string | null = null): void {
  newSessionStore.setState((state) =>
    state.open && state.workspaceId === workspaceId ? state : { open: true, workspaceId },
  );
}

export function closeNewSession(): void {
  newSessionStore.setState((state) => (state.open ? initialState : state));
}

/** Test seam. */
export function resetNewSessionStore(): void {
  newSessionStore.setState(() => initialState);
}
