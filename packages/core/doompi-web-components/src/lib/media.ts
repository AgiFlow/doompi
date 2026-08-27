import type { MediaKind } from '../types/editor.ts';

/**
 * Which files a browser can show without help.
 *
 * Keyed by lower-case extension without the dot, and deliberately short: an
 * entry here is a promise that the element named by its kind will render the
 * bytes, so a format the browser only sometimes handles belongs in the
 * download fallback instead of on this list.
 */
const MEDIA_KIND_BY_EXTENSION: Readonly<Record<string, MediaKind>> = {
  avif: 'image',
  bmp: 'image',
  gif: 'image',
  ico: 'image',
  jpeg: 'image',
  jpg: 'image',
  png: 'image',
  svg: 'image',
  webp: 'image',
  m4v: 'video',
  mov: 'video',
  mp4: 'video',
  webm: 'video',
  pdf: 'pdf',
};

/** The extension of a path, lower-cased and without the dot; empty when it has none. */
function extensionOf(filePath: string): string {
  const name = filePath.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not the start of a suffix.
  return dot < 1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * How to show the file at this path. Anything unrecognised is a download,
 * which is the honest answer for a `.docx` or a `.zip`: a browser cannot
 * render it, and pretending otherwise costs a converter that loses the
 * formatting it converted.
 */
export function mediaKindOf(filePath: string): MediaKind {
  return MEDIA_KIND_BY_EXTENSION[extensionOf(filePath)] ?? 'download';
}
