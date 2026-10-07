/** Largest session file the host reads into a response or publishes at a share link. */
export const MAX_SESSION_FILE_BYTES = 25 * 1024 * 1024;

/** Media types for session files a browser may render; anything else is served as bytes. */
export const SESSION_FILE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/** The fallback media type for a session file whose extension is not listed above. */
export const SESSION_FILE_DEFAULT_CONTENT_TYPE = 'application/octet-stream';
