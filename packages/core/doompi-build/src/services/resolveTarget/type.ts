import type { ExtensionEntry, ExtensionNotice } from '../../types/extensionGraph';

/** The three hosts an entry can be generated for. */
export type BuildTarget = 'cli' | 'server' | 'web';

/** One file, the field it contributes to, and the group it fills when it is a fill. */
export interface ResolvedContribution {
  /** The winning file for this logical contribution on this host. */
  readonly entry: ExtensionEntry;
  /** The host contribution array this belongs in. */
  readonly field: string;
  /**
   * The activity group a fill names, when it names one. Present only for
   * `activity.<group>` fills, whose binding resolves after install.
   */
  readonly activityGroup: string | undefined;
}

/** Everything one host needs generated, plus anything skipped on the way. */
export interface TargetResolution {
  readonly target: BuildTarget;
  readonly contributions: readonly ResolvedContribution[];
  /** Escape-hatch files whose raw contributions are merged in wholesale. */
  readonly escapeHatches: readonly ExtensionEntry[];
  readonly notices: readonly ExtensionNotice[];
}
