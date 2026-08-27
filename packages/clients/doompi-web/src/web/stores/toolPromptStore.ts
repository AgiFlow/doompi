import { Store } from '@tanstack/store';

/**
 * The one request a tool's composer prompt failed to render.
 *
 * A tool prompt standing in for the composer is the only surface offering the
 * agent an answer, so a plugin component that throws would otherwise strand
 * the run with nothing to click. Recording the request it threw on hands it
 * back: the claim declines it, and the host's own dialog opens instead.
 *
 * One id is enough because one request is open at a time, and a later request
 * gets its own id, so a plugin fixed between turns is tried again rather than
 * written off for the rest of the session.
 */
export interface ToolPromptState {
  failedDialogId: string | null;
}

export const toolPromptStore = new Store<ToolPromptState>({ failedDialogId: null });

export function markToolPromptFailed(dialogId: string): void {
  toolPromptStore.setState((state) => (state.failedDialogId === dialogId ? state : { failedDialogId: dialogId }));
}

/** Test seam. */
export function resetToolPromptStore(): void {
  toolPromptStore.setState(() => ({ failedDialogId: null }));
}
