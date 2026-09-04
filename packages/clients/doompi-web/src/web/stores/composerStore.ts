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

/** Appends non-empty text to the latest draft for one session. */
export function appendComposerDraft(sessionId: string | null, text: string): void {
  const transcript = text.trim();
  if (sessionId === null || transcript === '') return;
  updateComposerState(sessionId, (state) => {
    const separator = state.draft === '' || /\s$/.test(state.draft) ? '' : ' ';
    const draft = `${state.draft}${separator}${transcript}`;
    return { ...state, draft, caret: draft.length, dismissedToken: null };
  });
}

/** Adds message text as a Markdown blockquote and leaves the caret ready for an instruction. */
export function appendComposerQuote(sessionId: string | null, text: string): number | null {
  const transcript = text.trim().replace(/\r\n?/g, '\n');
  if (sessionId === null || transcript === '') return null;
  let caret = 0;
  updateComposerState(sessionId, (state) => {
    const separator =
      state.draft === '' ? '' : state.draft.endsWith('\n\n') ? '' : state.draft.endsWith('\n') ? '\n' : '\n\n';
    const quote = transcript
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n');
    const draft = `${state.draft}${separator}${quote}\n\n`;
    caret = draft.length;
    return { ...state, draft, caret, dismissedToken: null };
  });
  return caret;
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

const DRAFT_STORAGE_KEY = 'doompi:composer-drafts';

interface StoredDraft {
  draft: string;
  caret: number;
}

/**
 * Holds unsent text across a reload the person did not ask for.
 *
 * A verified bundle update reloads the page underneath whoever is typing, so
 * the text has to outlive the document. Only the draft and the caret travel:
 * attachments carry base64 image payloads that would not fit a storage quota,
 * and re-attaching a file is a smaller loss than losing a written message.
 */
export function saveComposerDrafts(): void {
  try {
    const drafts: Record<string, StoredDraft> = {};
    for (const [sessionId, state] of Object.entries(composerStore.state)) {
      if (state !== undefined && state.draft !== '') drafts[sessionId] = { draft: state.draft, caret: state.caret };
    }
    if (Object.keys(drafts).length === 0) window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    else window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Losing a draft is not worth breaking the reload that was already decided.
  }
}

/** Seeds the store from the last save, then forgets it so a later reload starts clean. */
export function restoreComposerDrafts(): void {
  let stored: unknown;
  try {
    const raw = window.sessionStorage.getItem(DRAFT_STORAGE_KEY);
    window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    if (raw === null) return;
    stored = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return;
  for (const [sessionId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.draft !== 'string' || entry.draft === '' || !Number.isSafeInteger(entry.caret)) continue;
    const caret = Math.max(0, Math.min(Number(entry.caret), entry.draft.length));
    updateComposerState(sessionId, (state) => ({ ...state, draft: entry.draft as string, caret }));
  }
}

/** Test seam. */
export function resetComposerStore(): void {
  composerStore.setState(() => ({}));
}
