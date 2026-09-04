import type { ComposerCapture, WebPluginContextItem } from '@agimon-ai/doompi-web-contracts';
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

export interface ComposerContextAttachment {
  id: string;
  kind: 'context';
  name: string;
  size: number;
  content: string;
  source: string;
  contextId: string;
}

export type ComposerAttachment = ComposerContextAttachment | ComposerImageAttachment | ComposerTextAttachment;

export const MAX_COMPOSER_ATTACHMENTS = 8;
export const MAX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_COMPOSER_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_COMPOSER_TEXT_BYTES = 100 * 1024;
export const MAX_COMPOSER_TOTAL_TEXT_BYTES = 200 * 1024;

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

function contextFields(item: WebPluginContextItem): { name: string; content: string; valid: boolean } {
  const name = item.label
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  const content = item.content.trim();
  return {
    name,
    content,
    valid:
      item.kind.trim() !== '' && item.source.trim() !== '' && item.id.trim() !== '' && name !== '' && content !== '',
  };
}

function isCaptureShape(capture: ComposerCapture): boolean {
  const context: unknown = capture.context;
  if (typeof capture.data !== 'string' || (capture.mimeType !== 'image/png' && capture.mimeType !== 'image/jpeg')) {
    return false;
  }
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return false;
  const item = context as Record<string, unknown>;
  return (
    typeof item.kind === 'string' &&
    typeof item.source === 'string' &&
    typeof item.id === 'string' &&
    typeof item.label === 'string' &&
    typeof item.content === 'string' &&
    (item.url === undefined || typeof item.url === 'string')
  );
}

const MAX_COMPOSER_CAPTURE_DIMENSION = 1600;

function decodeCanonicalBase64(data: string): string | null {
  if (data === '' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  try {
    const decoded = atob(data);
    return btoa(decoded) === data ? decoded : null;
  } catch {
    return null;
  }
}

function uint16(binary: string, offset: number): number {
  return binary.charCodeAt(offset) * 0x100 + binary.charCodeAt(offset + 1);
}

function uint32(binary: string, offset: number): number {
  return (
    binary.charCodeAt(offset) * 0x1000000 +
    binary.charCodeAt(offset + 1) * 0x10000 +
    binary.charCodeAt(offset + 2) * 0x100 +
    binary.charCodeAt(offset + 3)
  );
}

function pngDimensions(binary: string): { width: number; height: number } | null {
  const signature = '\x89PNG\r\n\x1a\n';
  if (binary.length < 24 || !binary.startsWith(signature) || binary.slice(12, 16) !== 'IHDR') return null;
  return { width: uint32(binary, 16), height: uint32(binary, 20) };
}

function jpegDimensions(binary: string): { width: number; height: number } | null {
  if (
    binary.length < 4 ||
    binary.charCodeAt(0) !== 0xff ||
    binary.charCodeAt(1) !== 0xd8 ||
    binary.charCodeAt(2) !== 0xff
  ) {
    return null;
  }
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < binary.length) {
    if (binary.charCodeAt(offset) !== 0xff) return null;
    while (binary.charCodeAt(offset) === 0xff) offset += 1;
    if (offset >= binary.length) return null;
    const marker = binary.charCodeAt(offset);
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > binary.length) return null;
    const segmentLength = uint16(binary, offset);
    if (segmentLength < 2 || offset + segmentLength > binary.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { width: uint16(binary, offset + 5), height: uint16(binary, offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function validCaptureDimensions(binary: string, mimeType: ComposerCapture['mimeType']): boolean {
  const dimensions = mimeType === 'image/png' ? pngDimensions(binary) : jpegDimensions(binary);
  return (
    dimensions !== null &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= MAX_COMPOSER_CAPTURE_DIMENSION &&
    dimensions.height <= MAX_COMPOSER_CAPTURE_DIMENSION
  );
}

/** Adds structured plugin context without changing the visible composer draft. */
export function attachComposerContext(sessionId: string | null, item: WebPluginContextItem): void {
  if (sessionId === null) return;
  const { name, content, valid } = contextFields(item);
  updateComposerState(sessionId, (state) => {
    if (!valid) {
      return { ...state, attachmentError: 'Context needs a source, id, label, and content.' };
    }
    if (state.attachments.length >= MAX_COMPOSER_ATTACHMENTS) {
      return { ...state, attachmentError: `Only ${String(MAX_COMPOSER_ATTACHMENTS)} attachments are allowed.` };
    }
    const size = new TextEncoder().encode(content).byteLength;
    if (size > MAX_COMPOSER_TEXT_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 100 KB context limit.` };
    }
    const textBytes = state.attachments.reduce(
      (total, attachment) => total + (attachment.kind === 'image' ? 0 : attachment.size),
      0,
    );
    if (textBytes + size > MAX_COMPOSER_TOTAL_TEXT_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 200 KB total text limit.` };
    }
    return {
      ...state,
      attachments: [
        ...state.attachments,
        {
          id: `context-${String(state.nextAttachmentId)}`,
          kind: 'context',
          name,
          size,
          content,
          source: item.source,
          contextId: item.id,
        },
      ],
      attachmentError: '',
      nextAttachmentId: state.nextAttachmentId + 1,
    };
  });
}

/**
 * Stages a capture as one image and one context chip in a single store update.
 * Nothing is transported until the reader explicitly submits or queues it.
 */
export function attachComposerCapture(sessionId: string | null, capture: ComposerCapture): void {
  if (sessionId === null) return;
  updateComposerState(sessionId, (state) => {
    if (!isCaptureShape(capture)) {
      return { ...state, attachmentError: 'Capture needs a base64 PNG or JPEG image and valid context.' };
    }
    const { name, content, valid } = contextFields(capture.context);
    if (!valid) {
      return { ...state, attachmentError: 'Capture needs a base64 PNG or JPEG image and valid context.' };
    }
    if (capture.data.length > Math.ceil(MAX_COMPOSER_IMAGE_BYTES / 3) * 4) {
      return { ...state, attachmentError: `${name} exceeds the 10 MB image limit.` };
    }
    const decodedImage = decodeCanonicalBase64(capture.data);
    if (decodedImage === null || !validCaptureDimensions(decodedImage, capture.mimeType)) {
      return { ...state, attachmentError: 'Capture needs a base64 PNG or JPEG image and valid context.' };
    }
    const imageSize = decodedImage.length;
    if (state.attachments.length > MAX_COMPOSER_ATTACHMENTS - 2) {
      return { ...state, attachmentError: `Only ${String(MAX_COMPOSER_ATTACHMENTS)} attachments are allowed.` };
    }
    if (imageSize > MAX_COMPOSER_IMAGE_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 10 MB image limit.` };
    }
    const imageBytes = state.attachments.reduce(
      (total, attachment) => total + (attachment.kind === 'image' ? attachment.size : 0),
      0,
    );
    if (imageBytes + imageSize > MAX_COMPOSER_TOTAL_IMAGE_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 20 MB total image limit.` };
    }
    const contextSize = new TextEncoder().encode(content).byteLength;
    if (contextSize > MAX_COMPOSER_TEXT_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 100 KB context limit.` };
    }
    const textBytes = state.attachments.reduce(
      (total, attachment) => total + (attachment.kind === 'image' ? 0 : attachment.size),
      0,
    );
    if (textBytes + contextSize > MAX_COMPOSER_TOTAL_TEXT_BYTES) {
      return { ...state, attachmentError: `${name} exceeds the 200 KB total text limit.` };
    }

    const imageId = state.nextAttachmentId;
    const extension = capture.mimeType === 'image/png' ? 'png' : 'jpg';
    return {
      ...state,
      attachments: [
        ...state.attachments,
        {
          id: `capture-${String(imageId)}`,
          kind: 'image',
          name: `${name}.${extension}`,
          size: imageSize,
          dataUrl: `data:${capture.mimeType};base64,${capture.data}`,
          data: capture.data,
          mimeType: capture.mimeType,
        },
        {
          id: `context-${String(imageId + 1)}`,
          kind: 'context',
          name,
          size: contextSize,
          content,
          source: capture.context.source,
          contextId: capture.context.id,
        },
      ],
      attachmentError: '',
      nextAttachmentId: imageId + 2,
    };
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
