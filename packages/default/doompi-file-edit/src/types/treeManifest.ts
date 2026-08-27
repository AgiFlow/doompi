/**
 * Take a bounded manifest of a working tree and report which files moved
 * between two of them.
 *
 * This is what catches the change no tool announced. The agent can write a
 * script and run it, and the bash call names neither the script's targets nor
 * a glob that would give them away, so reading the command string can never be
 * complete. Comparing the tree either side of the call can.
 *
 * The walk is bounded on both entries and depth and skips the directories a
 * build fills, because the point is to notice source changing, not to inventory
 * a machine. A manifest that hit a cap says so, so a caller can report the
 * shortfall instead of implying it saw everything.
 *
 * Declared here, not beside its implementation: services may import types but
 * never adapters, so a port living in src/adapters would be unreachable from
 * the code that needs it.
 */
export interface TreeManifest {
  /** Absolute path to an opaque fingerprint of the file's size and modification time. */
  readonly entries: ReadonlyMap<string, string>;
  /** True when the walk hit a cap, so the manifest covers only part of the tree. */
  readonly truncated: boolean;
}

export interface TreeManifestPort {
  /**
   * Walks the tree once and records what it found.
   *
   * `exclude` names absolute files and directories the walk must not descend
   * into or record. A caller passes its own storage: this package writes a
   * timeline and a snapshot directory that can land inside the very tree it is
   * watching, and reporting those as edits would make every recorded change
   * cause another one.
   */
  take(root: string, exclude?: readonly string[]): Promise<TreeManifest>;
  /**
   * One file's fingerprint, in the same vocabulary a walk records, or undefined
   * when it is not there. A caller that already handled a file folds this into
   * its manifest so the next walk does not report the same change twice.
   */
  fingerprint(filePath: string): Promise<string | undefined>;
  /** Every path added, removed, or modified between two manifests, sorted. */
  changed(before: TreeManifest, after: TreeManifest): string[];
}
