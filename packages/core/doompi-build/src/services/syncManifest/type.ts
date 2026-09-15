import type { ExtensionGraph } from '../../types/extensionGraph';
import type { BuildTarget } from '../resolveTarget/type';

/** Everything deriving a manifest needs, so nothing has to rescan. */
export interface ManifestSync {
  readonly packageDir: string;
  /** The manifest as read, which the sync returns a copy of. */
  readonly manifest: Record<string, unknown>;
  readonly graph: ExtensionGraph;
  /** Hosts this package contributes to, as the generator resolved them. */
  readonly targets: readonly BuildTarget[];
  readonly pluginId: string;
}
