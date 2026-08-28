import path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a request path to a file inside the asset root.
 *
 * Returns undefined when the result would escape the root, so an encoded
 * traversal cannot read files the bundle was never meant to publish.
 */
export function resolveAssetPath(assetsDir: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const root = path.resolve(assetsDir);
  const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return undefined;
  return candidate;
}
