import type { ExtensionEntry, ExtensionNotice } from '../../types/extensionGraph';

/** The three hosts an entry can be generated for. */
export type BuildTarget = 'cli' | 'server' | 'web';

/** One file and the host contribution array it belongs in. */
export interface ResolvedContribution {
  /** The winning file for this logical contribution on this host. */
  readonly entry: ExtensionEntry;
  /** The host contribution array this belongs in. */
  readonly field: string;
}

/** Everything one host needs generated, plus anything skipped on the way. */
export interface TargetResolution {
  readonly target: BuildTarget;
  readonly contributions: readonly ResolvedContribution[];
  /** Escape-hatch files whose raw contributions are merged in wholesale. */
  readonly escapeHatches: readonly ExtensionEntry[];
  readonly notices: readonly ExtensionNotice[];
}
