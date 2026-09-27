import { Store } from '@tanstack/store';

/** Which history the resume dialog browses: one session's, or a whole workspace's. */
export type ResumeTarget = { sessionId: string } | { workspaceId: string };

/** Host dialogs the template rail opens; they call their own APIs, so the host renders them. */
export interface RailDialogState {
  resume: ResumeTarget | null;
}

const initialState: RailDialogState = { resume: null };

export const railDialogStore = new Store<RailDialogState>(initialState);

export function openResumeDialog(target: ResumeTarget): void {
  railDialogStore.setState(() => ({ resume: target }));
}

export function closeResumeDialog(): void {
  railDialogStore.setState((state) => (state.resume === null ? state : initialState));
}

/** Test seam. */
export function resetRailDialogStore(): void {
  railDialogStore.setState(() => initialState);
}
