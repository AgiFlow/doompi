import { useStore } from '@tanstack/react-store';
import { Store } from '@tanstack/store';

export interface ComposerImageAttachment {
  id: string;
  kind: 'image';
  name: string;
  size: number;
  dataUrl: string;
  data: string;
  mimeType: string;
}

export interface ComposerTextAttachment {
  id: string;
  kind: 'text';
  name: string;
  size: number;
  content: string;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerTextAttachment;

export interface ComposerSessionState {
  draft: string;
  caret: number;
  dismissedToken: number | null;
  attachments: ComposerAttachment[];
  attachmentError: string;
  nextAttachmentId: number;
}

type ComposerState = Partial<Record<string, ComposerSessionState>>;

const EMPTY_COMPOSER_SESSION: ComposerSessionState = {
  draft: '',
  caret: 0,
  dismissedToken: null,
  attachments: [],
  attachmentError: '',
  nextAttachmentId: 0,
};

/** Browser-only composer state, retained independently for each live session. */
export const composerStore = new Store<ComposerState>({});

function composerStateOf(state: ComposerState, sessionId: string | null): ComposerSessionState {
  return (sessionId === null ? undefined : state[sessionId]) ?? EMPTY_COMPOSER_SESSION;
}

export function useComposerState(sessionId: string | null): ComposerSessionState {
  return useStore(composerStore, (state) => composerStateOf(state, sessionId));
}

export function updateComposerState(
  sessionId: string | null,
  update: (state: ComposerSessionState) => ComposerSessionState,
): void {
  if (sessionId === null) return;
  composerStore.setState((state) => ({ ...state, [sessionId]: update(composerStateOf(state, sessionId)) }));
}

export function clearComposerState(sessionId: string | null): void {
  if (sessionId === null) return;
  composerStore.setState((state) => ({ ...state, [sessionId]: EMPTY_COMPOSER_SESSION }));
}

/** A session that left takes its unfinished composer state with it. */
export function dropComposerState(sessionId: string): void {
  composerStore.setState((state) => {
    if (!(sessionId in state)) return state;
    const next = { ...state };
    delete next[sessionId];
    return next;
  });
}

/** Test seam. */
export function resetComposerStore(): void {
  composerStore.setState(() => ({}));
}
