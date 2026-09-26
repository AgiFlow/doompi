import fs from 'node:fs/promises';
import path from 'node:path';

import { DocumentRequestError, documentTooLarge } from './common';

export const AUTHOR_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

export async function readDocument(cwd: string, requestedPath: unknown): Promise<Uint8Array> {
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.length === 0 ||
    requestedPath.includes('\0') ||
    path.isAbsolute(requestedPath)
  ) {
    throw new Error('A relative document path is required.');
  }
  const root = await fs.realpath(cwd);
  const candidate = path.resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
    throw new DocumentRequestError('Document path is outside the working directory.', 403);
  const realCandidate = await fs.realpath(candidate);
  if (realCandidate !== root && !realCandidate.startsWith(`${root}${path.sep}`)) {
    throw new DocumentRequestError('Document path is outside the working directory.', 403);
  }
  const stat = await fs.stat(realCandidate);
  if (stat.size > AUTHOR_DOCUMENT_MAX_BYTES) {
    throw documentTooLarge(`Document exceeds the ${AUTHOR_DOCUMENT_MAX_BYTES} byte preview limit.`);
  }
  return await fs.readFile(realCandidate);
}
