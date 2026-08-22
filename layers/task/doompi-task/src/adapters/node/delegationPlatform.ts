import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DelegationPlatform } from '../../services/delegation/manager.ts';

function formatBriefPath(entry: string, cwd: string): string {
  if (!path.isAbsolute(entry)) return path.normalize(entry);
  const relative = path.relative(cwd, entry);
  // Outside the run directory the original beats a `../../` chain.
  return relative && !relative.startsWith('..') ? relative : entry;
}

/** Supply Node-owned process and path facilities to the host-neutral manager. */
export function createNodeDelegationPlatform(): DelegationPlatform {
  return {
    environment: process.env,
    processId: process.pid,
    createRequestId: randomUUID,
    formatBriefPath,
  };
}
