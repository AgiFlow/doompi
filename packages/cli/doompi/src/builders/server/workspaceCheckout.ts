import fs from 'node:fs';

import { identifyWorkspace, readWorkspaceMarker } from '@agimon-ai/doompi-core/history';

import { findRepositoryRoot } from '../../composition/repository';

/**
 * The recorded workspace a directory's checkout belongs to: its root, a
 * subdirectory, or a worktree whose git data names it. Undefined for a
 * directory that is not a checkout of any recorded workspace, or whose
 * workspace root has gone, so a caller never admits a new workspace by accident.
 */
export function checkoutWorkspaceId(records: readonly { id: string; root: string }[], cwd: string): string | undefined {
  let checkoutRoot: string;
  try {
    checkoutRoot = fs.realpathSync(findRepositoryRoot(cwd));
  } catch {
    return undefined;
  }
  const identity = identifyWorkspace({ records, checkoutRoot, marker: readWorkspaceMarker(checkoutRoot) });
  if (identity.moved || !records.some((record) => record.id === identity.id)) return undefined;
  return identity.id;
}
