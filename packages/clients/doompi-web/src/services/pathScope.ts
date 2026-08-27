import path from 'node:path';

/**
 * Whether one path lies within another.
 *
 * Shared because two different boundaries ask the same question: which sessions
 * a container could recreate, and which directories a remote device is allowed
 * to see. Both are security answers, so both use the same one.
 *
 * Pure by design: no filesystem, so a test can name any path it likes.
 */

/**
 * The prefix has to end at a separator. Without that, `/work` would claim
 * `/workspace-secrets`, which is the difference between a boundary and a string
 * comparison that looks like one.
 */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const from = path.resolve(root);
  const to = path.resolve(candidate);
  if (to === from) return true;
  return to.startsWith(from.endsWith(path.sep) ? from : `${from}${path.sep}`);
}
