/**
 * Ports and domain contracts for the prompt library.
 *
 * DESIGN PATTERNS:
 * - The store port is named in this package's vocabulary; the filesystem
 *   implementation lives in src/adapters/node and imports the port from here.
 * - Staged prompts are session-scoped and never reach a port: the ring is pure
 *   in-memory state, so nothing here describes persistence for them.
 *
 * AVOID:
 * - Declaring a port beside its implementation, which would force services to
 *   depend on the filesystem.
 */

/** A prompt saved as a Pi prompt template on disk. */
export interface SavedPrompt {
  /** Template name without the `.md` suffix, which is also its slash command. */
  name: string;
  /** Frontmatter description, empty when the document declares none. */
  description: string;
  /** Prompt body, verbatim. */
  text: string;
}

/** Where a saved prompt landed, so a command can tell the user. */
export interface SavedPromptWrite {
  name: string;
  path: string;
}

/** Reads and writes the Pi prompt templates this package owns. */
export interface SavedPromptStore {
  /** Every readable template in the prompts directory, sorted by name. */
  list(): Promise<readonly SavedPrompt[]>;
  /** Whether a template file already exists under that name. */
  has(name: string): Promise<boolean>;
  /** Writes the template, replacing any existing file with the same name. */
  save(prompt: SavedPrompt): Promise<SavedPromptWrite>;
  /** Deletes the template, answering false when there was none to delete. */
  remove(name: string): Promise<boolean>;
}

/** The session-scoped ring of prompts the user submitted. */
export interface RecentPrompts {
  /** Records a submitted prompt as the newest entry. */
  push(text: string): void;
  /** Staged prompts, newest first. */
  list(): readonly string[];
}

/** Everything the extension needs, constructed in src/container. */
export interface PromptExtensionDependencies {
  store: SavedPromptStore;
  recent: RecentPrompts;
}
