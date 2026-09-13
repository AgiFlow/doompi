/**
 * Cross-package service contract for the immutable configuration snapshot.
 *
 * The provider supplies the concrete snapshot and file-config types. Keeping
 * this contract generic lets independently bundled consumers share the Cordis
 * service definition without making the contracts package depend on config.
 */
export interface IDoomConfigService<TSnapshot = unknown, TFileConfig = unknown> {
  /** Identifies the currently published session service for stale-work fencing. */
  readonly generation: string;
  /** Returns the immutable snapshot currently visible to consumers. */
  getSnapshot(): TSnapshot;
  /** Atomically replaces the immutable live snapshot after a successful transition. */
  replaceSnapshot(snapshot: TSnapshot): TSnapshot;
  /** Loads the package's file configuration outside the live session snapshot. */
  load(repoRoot: string, homeDirectory?: string): TFileConfig;
}
