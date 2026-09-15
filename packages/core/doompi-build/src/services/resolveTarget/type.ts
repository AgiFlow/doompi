import type { ExtensionEntry, ExtensionNotice } from '../../types/extensionGraph';

/** The three hosts an entry can be generated for. */
export type BuildTarget = 'cli' | 'server' | 'web';

/** One file and the host contribution array it belongs in. */
export interface ResolvedContribution {
  /** The winning file for this logical contribution on this host. */
  readonly entry: ExtensionEntry;
  /** The host contribution array this belongs in. */
  readonly field: string;
  /**
   * A presentation file folded into this contribution rather than emitted
   * beside it. Only the terminal has one: its tool renderers are fields of the
   * tool declaration, so the pair becomes a single registration.
   */
  readonly renderers?: ExtensionEntry;
}

/** Everything one host needs generated, plus anything skipped on the way. */
export interface TargetResolution {
  readonly target: BuildTarget;
  readonly contributions: readonly ResolvedContribution[];
  /** Escape-hatch files whose raw contributions are merged in wholesale. */
  readonly escapeHatches: readonly ExtensionEntry[];
  /**
   * Scope constructors, outermost first.
   *
   * Each one runs before the contributions beneath it and its value joins
   * their mount context, so the order is the nesting order and nothing else.
   */
  readonly roots: readonly ExtensionEntry[];
  readonly notices: readonly ExtensionNotice[];
}
