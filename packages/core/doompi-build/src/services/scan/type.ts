/** What the scan needs to know before it walks a package. */
export interface ScanOptions {
  /** Absolute path of the package being scanned. */
  readonly packageDir: string;
  /**
   * Routing root, package-relative. Defaults to `src/extensions`, falling back
   * to `src/extension` when only that one exists.
   */
  readonly root?: string;
  /** Group folder names that select a build side. */
  readonly sides?: { readonly backend?: string; readonly frontend?: string };
  /** Recognised platform suffixes per side. */
  readonly platforms?: { readonly backend?: readonly string[]; readonly frontend?: readonly string[] };
  /** Base names of the generated entries at the root, which the scan skips. */
  readonly generatedEntries?: readonly string[];
}
