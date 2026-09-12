import type { IPtySpawner, PtyProcess, PtySpawnRequest } from '../../types/ptySpawner';

const RMUX_REQUIRED_ERROR =
  'The node-pty fallback has been removed. Interactive commands require a supported RMUX runtime.';

/**
 * Compatibility stub for the published NodePtySpawner subpath.
 *
 * Doom Runner no longer starts interactive commands through node-pty. The class
 * remains exportable so existing imports fail at launch with an actionable error.
 */
export class NodePtySpawner implements IPtySpawner {
  async spawn(_request: PtySpawnRequest): Promise<PtyProcess> {
    throw new Error(RMUX_REQUIRED_ERROR);
  }
}
