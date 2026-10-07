import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  MAX_SESSION_FILE_BYTES,
  SESSION_FILE_CONTENT_TYPES,
  SESSION_FILE_DEFAULT_CONTENT_TYPE,
} from '../../constants/sessionFiles';
import { DOOM_SHARE_FILE_REMOTE_OFF_MESSAGE, type DoomSharedFile } from '../../schemas/packageApi';
import { sessionAttachmentRoot } from '../sessionAttachments';

/**
 * Short-lived public links to one session file, so a remote MCP server can fetch
 * what the model was asked to hand it.
 *
 * The link is the only credential, so only its hash is kept, and every way a
 * link can fail answers the same 404. A file is pinned by identity when the
 * link is minted and reopened when it is served: a path that now names another
 * file, or reaches it through a new symlink, is refused rather than followed.
 */

/** Public tunnel path prefix; the token is the only segment after it. */
export const PUBLIC_FILE_SHARE_PREFIX = '/mcp-file/';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHARE_TTL_MS = 10 * 60 * 1000;
const SHARE_DOWNLOADS = 3;
const MAX_LIVE_SHARES_PER_SESSION = 16;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

export interface PublicFileShareRequest {
  sessionId: string;
  cwd: string;
  /** Relative to cwd, or absolute. */
  path: string;
  /** Who the file is for, for the host's notice. */
  label: string;
}

export interface PublicFileShares {
  mint(request: PublicFileShareRequest): Promise<DoomSharedFile>;
  serve(token: string, method: string): Promise<Response>;
}

export interface PublicFileSharesOptions {
  publicOrigin(): string | undefined;
  /** Bumped whenever the tunnel goes away; a link minted under another revision is dead. */
  publicOriginRevision(): number;
  /** Never receives a token or a link. */
  onNotice(message: string): void;
  /** Locates the attachment root; defaults to the process environment, as the upload route does. */
  environment?: Readonly<Record<string, string | undefined>>;
}

interface Share {
  sessionId: string;
  filePath: string;
  fileName: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  revision: number;
  expiresAt: number;
  downloadsLeft: number;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function notFound(): Response {
  return Response.json({ error: 'Not found.' }, { status: 404 });
}

/** RFC 8187 value for `filename*`: encodeURIComponent leaves a few characters the grammar forbids. */
function contentDispositionName(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** True when filePath sits strictly below the real root with no segment that starts with a dot. */
async function containedIn(root: string, filePath: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, filePath);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep).every((segment) => !segment.startsWith('.'))
  );
}

/** The real path of a shareable file: inside the session cwd or its attachment root, never through a dot segment. */
async function resolveShareable(
  request: PublicFileShareRequest,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const refused = new Error(`"${request.path}" is not a file in this session's working directory or attachments.`);
  if (
    request.path === '' ||
    request.path.includes('\0') ||
    request.path.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')
  )
    throw refused;
  let filePath: string;
  try {
    filePath = await fs.promises.realpath(path.resolve(request.cwd, request.path));
  } catch {
    throw refused;
  }
  const roots = [request.cwd];
  try {
    roots.push(sessionAttachmentRoot(request.sessionId, environment));
  } catch {
    // An id that cannot hold attachments only has its working directory.
  }
  for (const root of roots) if (await containedIn(root, filePath)) return filePath;
  throw refused;
}

/**
 * Opens a regular file without following a final symlink, then proves the handle is
 * still the file at that real path: a parent swapped for a symlink changes the real
 * path, and a replaced file changes the identity. Resolves undefined, with nothing
 * left open, when either check fails.
 */
async function openPinned(filePath: string): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats } | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    const named = await fs.promises.lstat(filePath);
    if (
      stat.isFile() &&
      named.dev === stat.dev &&
      named.ino === stat.ino &&
      (await fs.promises.realpath(filePath)) === filePath
    )
      return { handle, stat };
  } catch {
    // Treated like a mismatch below.
  }
  await handle.close();
  return undefined;
}

export function createPublicFileShares(options: PublicFileSharesOptions): PublicFileShares {
  const environment = options.environment ?? process.env;
  const shares = new Map<string, Share>();

  const live = (share: Share): boolean =>
    Date.now() < share.expiresAt &&
    share.downloadsLeft > 0 &&
    share.revision === options.publicOriginRevision() &&
    options.publicOrigin() !== undefined;

  return {
    async mint(request) {
      const origin = options.publicOrigin();
      const revision = options.publicOriginRevision();
      if (origin === undefined) throw new Error(DOOM_SHARE_FILE_REMOTE_OFF_MESSAGE);
      const filePath = await resolveShareable(request, environment);
      const opened = await openPinned(filePath);
      if (opened === undefined) throw new Error(`"${request.path}" is not a regular file DoomPi can share.`);
      const { stat } = opened;
      await opened.handle.close();
      if (stat.size > MAX_SESSION_FILE_BYTES)
        throw new Error(`"${request.path}" is larger than the 25 MB file sharing limit.`);
      for (const [key, share] of shares) if (!live(share)) shares.delete(key);
      if (
        [...shares.values()].filter((share) => share.sessionId === request.sessionId).length >=
        MAX_LIVE_SHARES_PER_SESSION
      )
        throw new Error(
          `This session already shares ${String(MAX_LIVE_SHARES_PER_SESSION)} files. Retry after a tool call finishes.`,
        );
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const key = tokenDigest(token);
      const fileName = path.basename(filePath);
      shares.set(key, {
        sessionId: request.sessionId,
        filePath,
        fileName,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        revision,
        expiresAt: Date.now() + SHARE_TTL_MS,
        downloadsLeft: SHARE_DOWNLOADS,
      });
      options.onNotice(`file share: published "${fileName}" for ${request.label} on the remote-access tunnel.`);
      return {
        url: `${origin}${PUBLIC_FILE_SHARE_PREFIX}${token}`,
        fileName,
        mimeType: SESSION_FILE_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? SESSION_FILE_DEFAULT_CONTENT_TYPE,
        size: stat.size,
        revoke: () => {
          shares.delete(key);
        },
      };
    },

    async serve(token, method) {
      if ((method !== 'GET' && method !== 'HEAD') || !TOKEN_PATTERN.test(token)) return notFound();
      const key = tokenDigest(token);
      const share = shares.get(key);
      if (share === undefined) return notFound();
      if (!live(share)) {
        shares.delete(key);
        return notFound();
      }
      // Counted before the first await, so concurrent downloads cannot outrun the limit.
      if (method === 'GET') {
        share.downloadsLeft -= 1;
        if (share.downloadsLeft === 0) shares.delete(key);
      }
      const opened = await openPinned(share.filePath);
      if (
        opened === undefined ||
        opened.stat.dev !== share.dev ||
        opened.stat.ino !== share.ino ||
        opened.stat.size !== share.size ||
        opened.stat.mtimeMs !== share.mtimeMs
      ) {
        await opened?.handle.close();
        shares.delete(key);
        options.onNotice(`file share: refused "${share.fileName}" because the file changed after it was shared.`);
        return notFound();
      }
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(share.size),
        'content-disposition': `attachment; filename*=UTF-8''${contentDispositionName(share.fileName)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store, private',
        'referrer-policy': 'no-referrer',
        'accept-ranges': 'none',
        'x-robots-tag': 'noindex',
      };
      if (method === 'HEAD' || share.size === 0) {
        await opened.handle.close();
        return new Response(method === 'HEAD' ? null : new Uint8Array(), { headers });
      }
      // The stream closes the handle when it ends, fails, or is cancelled. Bounded to the
      // pinned size, so bytes appended after the identity check are never sent.
      const body = Readable.toWeb(opened.handle.createReadStream({ start: 0, end: share.size - 1 }));
      return new Response(body as ReadableStream<Uint8Array>, { headers });
    },
  };
}
