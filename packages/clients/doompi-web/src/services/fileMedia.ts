import path from 'node:path';
import { MEDIA_TYPES, type MediaType } from '../types/media.ts';

const OCTET_STREAM = 'application/octet-stream';

/** The preview type for a file the hub is asked to serve, or undefined for a plain download. */
export function mediaTypeFor(filePath: string): MediaType | undefined {
  return MEDIA_TYPES[path.extname(filePath).slice(1).toLowerCase()];
}

/**
 * The response headers for a mentioned file. Previewable kinds render inline;
 * everything else downloads under its own name. SVG is the one previewable
 * type that can carry script, so it is served sandboxed: an <img> never runs
 * script anyway, and a direct navigation gets an inert document.
 */
export function sessionFileHeaders(filePath: string): Record<string, string> {
  const media = mediaTypeFor(filePath);
  const name = path.basename(filePath).replaceAll('"', '');
  const headers: Record<string, string> = {
    'Content-Type': media?.contentType ?? OCTET_STREAM,
    'Content-Disposition': `${media ? 'inline' : 'attachment'}; filename="${name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (media?.contentType === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  return headers;
}
