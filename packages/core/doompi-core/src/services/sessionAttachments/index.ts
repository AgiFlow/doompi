import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SESSION_FILE_CONTENT_TYPES, SESSION_FILE_DEFAULT_CONTENT_TYPE } from '../../constants/sessionFiles';
import { agentDirectory, safeName } from '../contextDetailStore';

/**
 * Where composer attachments live on the host, so a tool can be handed one by path.
 *
 * Each upload gets its own random directory under the session's root, which keeps
 * two files with the same name apart and lets the original name survive. The
 * directory is owner-only because an attachment is whatever the user dropped in.
 */

const DIRECTORY_NAME = 'doom-attachments';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_NAME_BYTES = 200;
const FALLBACK_NAME = 'file';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionAttachment {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/** Throws for an id whose directory would be the attachment root itself or its parent. */
export function sessionAttachmentRoot(
  sessionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const directory = safeName(sessionId);
  if (directory === '' || directory === '.' || directory === '..')
    throw new Error('This session id cannot hold attachments.');
  return path.join(agentDirectory(environment), DIRECTORY_NAME, directory);
}

/**
 * One plain file name: no separators or control characters, and no leading dot, so
 * an attachment is never hidden and never `.` or `..`. Cut on a code point boundary
 * to fit common file-name limits.
 */
function attachmentName(name: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const plain = name.replace(/[\u0000-\u001f\u007f/\\]/gu, '').replace(/^\.+/u, '');
  let fitted = '';
  for (const character of plain) {
    if (Buffer.byteLength(fitted + character) > MAX_NAME_BYTES) break;
    fitted += character;
  }
  return fitted === '' ? FALLBACK_NAME : fitted;
}

/** Best effort: a sweep that cannot read or remove a directory leaves it for the next write. */
async function sweepExpired(root: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  let sessions: fs.Dirent[];
  try {
    sessions = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const sessionDirectory = path.join(root, session.name);
    let uploads: fs.Dirent[];
    try {
      uploads = await fs.promises.readdir(sessionDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const upload of uploads) {
      if (!upload.isDirectory()) continue;
      const uploadDirectory = path.join(sessionDirectory, upload.name);
      try {
        if ((await fs.promises.lstat(uploadDirectory)).mtimeMs < cutoff)
          await fs.promises.rm(uploadDirectory, { recursive: true, force: true });
      } catch {
        // Left for the next sweep.
      }
    }
  }
}

/** Stores one attachment and returns where it landed. Written through a temporary file, then renamed. */
export async function writeSessionAttachment(
  sessionId: string,
  name: string,
  bytes: Uint8Array,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SessionAttachment> {
  const root = sessionAttachmentRoot(sessionId, environment);
  const fileName = attachmentName(name);
  await fs.promises.mkdir(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await sweepExpired(path.dirname(root));
  const directory = path.join(root, randomUUID());
  await fs.promises.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  const target = path.join(directory, fileName);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, bytes, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: target,
    name: fileName,
    size: bytes.byteLength,
    mimeType: SESSION_FILE_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? SESSION_FILE_DEFAULT_CONTENT_TYPE,
  };
}
