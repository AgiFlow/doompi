/**
 * Writes into the global Doom config file, one key path at a time.
 *
 * Extracted from doom-file-edit, which owned the only writer in the repo and had
 * it hard-coded to `editor.command`. Several extensions now edit their own
 * settings from the config panel, and every one of them needs the same four
 * properties: keep the user's comments, never publish a file the parser would
 * reject, never leave a half-written file behind, and apply a set of related
 * edits together.
 *
 * That last one is not a convenience. `voice.adapters.<engine>.model` accepts a
 * path or an id but not both, so switching between them is a set and an unset
 * that must land in the same write, or the file is briefly invalid.
 *
 * Atomicity is the same rename trick as `atomicJson.ts` next door, and carries
 * the same caveat: it prevents torn reads, not lost updates. Two sessions with
 * the panel open still clobber each other, because the rename only publishes
 * what the caller already computed.
 *
 * AVOID:
 * - Treating this as a lock
 * - Writing an empty string; the parser rejects blank values, so clearing a key
 *   means removing it
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { parseDoomConfig } from '../services/configPolicy.ts';

/**
 * The global file holds machine-wide credentials-adjacent settings and lives in
 * the user's home, so it stays private.
 */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * The repository file is committed to git and read by everyone who checks the
 * project out, so it takes the modes `init.ts` already seeds it with. Writing it
 * private would produce a 0600 file in a working tree, which is both wrong and
 * invisible until someone else clones.
 */
const REPOSITORY_FILE_MODE = 0o644;
const REPOSITORY_DIRECTORY_MODE = 0o755;

/** Which file a write is aimed at; the modes follow from it. */
export type DoomConfigScope = 'global' | 'repository';

/** The permissions a scope's file and its parent directory are created with. */
function modesForScope(scope: DoomConfigScope): { file: number; directory: number } {
  return scope === 'repository'
    ? { file: REPOSITORY_FILE_MODE, directory: REPOSITORY_DIRECTORY_MODE }
    : { file: PRIVATE_FILE_MODE, directory: PRIVATE_DIRECTORY_MODE };
}

export interface DoomConfigEdit {
  /** Key path into the document, e.g. `['voice', 'adapters', 'mlx-whisper', 'model', 'id']`. */
  readonly keyPath: readonly string[];
  /**
   * The value to write. `undefined` removes the key.
   *
   * Not only strings: the config holds numbers (`utteranceIdleMs`) and lists
   * (`startPhrases`), and a panel that edits them as text has to hand back the
   * parsed value or the next load rejects what it wrote.
   */
  readonly value?: string | number | boolean | readonly string[];
}

export interface WriteDoomConfigOptions {
  /**
   * Remove ancestors left holding nothing. Defaults to true, and is not
   * cosmetic: an adapter left as `{}` fails validation, because the parser
   * requires a model once the adapter exists at all.
   */
  readonly prune?: boolean;
  /**
   * Which file this is, so the write lands with the right permissions.
   * Defaults to `global`, which is what every caller wrote before the
   * repository file was writable at all.
   */
  readonly scope?: DoomConfigScope;
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

function isEmptyCollection(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}

/** Drops ancestors of a removed key that are now empty, deepest first. */
function pruneEmptyAncestors(document: ReturnType<typeof parseDocument>, keyPath: readonly string[]): void {
  for (let depth = keyPath.length - 1; depth > 0; depth -= 1) {
    const ancestor = keyPath.slice(0, depth);
    if (!document.hasIn(ancestor)) continue;
    if (!isEmptyCollection(document.getIn(ancestor, true))) return;
    document.deleteIn(ancestor);
  }
}

/**
 * Applies every edit as one document mutation, or throws having written nothing.
 *
 * Validation runs against the serialized result rather than each edit, so a pair
 * of edits only valid together is accepted, and a single edit that breaks an
 * invariant elsewhere is still caught.
 */
export async function writeDoomConfigValues(
  filePath: string,
  edits: readonly DoomConfigEdit[],
  options: WriteDoomConfigOptions = {},
): Promise<void> {
  if (edits.length === 0) return;
  const content = await readIfPresent(filePath);
  // Not `content || '{}\n'`: seeding an absent file with a flow map makes yaml
  // keep that style, so the first write produces `{ editor: { command: ... } }`
  // and every later one grows that one line. An empty source starts a block map.
  const document = parseDocument(content, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(`Could not parse Doom config at ${filePath}`);

  for (const edit of edits) {
    const keyPath = [...edit.keyPath];
    if (edit.value !== undefined) {
      document.setIn(keyPath, edit.value);
      continue;
    }
    // deleteIn throws when an ancestor is missing rather than treating the key as
    // already absent, and clearing an unset key is worth supporting.
    if (!document.hasIn(keyPath)) continue;
    document.deleteIn(keyPath);
    if (options.prune !== false) pruneEmptyAncestors(document, keyPath);
  }

  const output = document.toString();
  parseDoomConfig(output, filePath);

  const modes = modesForScope(options.scope ?? 'global');
  await fs.mkdir(path.dirname(filePath), { mode: modes.directory, recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, output, { encoding: 'utf8', mode: modes.file });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function setDoomConfigValue(
  filePath: string,
  keyPath: readonly string[],
  value: string,
  options: WriteDoomConfigOptions = {},
): Promise<void> {
  await writeDoomConfigValues(filePath, [{ keyPath, value }], options);
}

export async function unsetDoomConfigValue(
  filePath: string,
  keyPath: readonly string[],
  options: WriteDoomConfigOptions = {},
): Promise<void> {
  await writeDoomConfigValues(filePath, [{ keyPath }], options);
}
