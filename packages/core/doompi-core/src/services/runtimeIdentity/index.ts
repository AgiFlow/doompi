import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Canonical on-disk identity used for activation deduplication and fingerprints. */
export function canonicalModulePath(target: string): string {
  const absolute = path.resolve(target);
  let resolved = absolute;
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch {
    // Missing synthetic/test paths still receive an absolute normalized identity.
  }
  return resolved.split(path.sep).join('/');
}

/** Stable SHA-256 digest for a canonically serialized runtime identity. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
