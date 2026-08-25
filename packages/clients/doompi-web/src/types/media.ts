/**
 * How the cockpit previews a file a message mentions: the hub serves it from
 * the session's working directory and the timeline picks the element by
 * kind. Anything not listed here is offered as a plain file link.
 */
export type MediaKind = 'image' | 'video' | 'pdf';

export interface MediaType {
  kind: MediaKind;
  contentType: string;
}

/** Keyed by lower-case extension without the dot. */
export const MEDIA_TYPES: Readonly<Record<string, MediaType>> = {
  avif: { kind: 'image', contentType: 'image/avif' },
  bmp: { kind: 'image', contentType: 'image/bmp' },
  gif: { kind: 'image', contentType: 'image/gif' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  png: { kind: 'image', contentType: 'image/png' },
  svg: { kind: 'image', contentType: 'image/svg+xml' },
  webp: { kind: 'image', contentType: 'image/webp' },
  m4v: { kind: 'video', contentType: 'video/mp4' },
  mov: { kind: 'video', contentType: 'video/quicktime' },
  mp4: { kind: 'video', contentType: 'video/mp4' },
  webm: { kind: 'video', contentType: 'video/webm' },
  pdf: { kind: 'pdf', contentType: 'application/pdf' },
};

/** The hub refuses to serve a mentioned file past this size. */
export const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;

/** The route the timeline fetches a mentioned file from; path is the cwd-relative file. */
export const SESSION_FILE_ROUTE = '/api/sessions/:sessionId/file';

export function sessionFileUrl(sessionId: string, relativePath: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(relativePath)}`;
}
