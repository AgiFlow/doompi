import type { ExtensionGraph, ExtensionNotice } from '../../types/extensionGraph';
import type { BuildTarget } from '../resolveTarget/type';
import type { ScanOptions } from '../scan/type';

export interface GenerateOptions extends ScanOptions {
  /** Defaults to the name in the package's own package.json. */
  readonly packageName?: string;
  /** Defaults to the package name without its scope and `doompi-` prefix. */
  readonly pluginId?: string;
  /** Throw on stale output instead of writing it. */
  readonly check?: boolean;
}

export interface GenerateResult {
  readonly graph: ExtensionGraph;
  readonly packageName: string;
  readonly pluginId: string;
  /** Package-relative path to rendered source, for every entry the tree calls for. */
  readonly files: ReadonlyMap<string, string>;
  /** Package-relative paths whose contents changed. */
  readonly changed: readonly string[];
  readonly notices: readonly ExtensionNotice[];
  /** The hosts this package contributes to. */
  readonly targets: readonly BuildTarget[];
}
