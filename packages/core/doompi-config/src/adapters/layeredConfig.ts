import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { globalDoomConfigDirectory } from './config.ts';

/** Repository-local doom-pi configuration directory, committed to git. */
export const DOOM_DIR = '.doom';

const TEXT_ENCODING = 'utf8';

/** Source identity retained for diagnostics and composition fingerprints. */
export interface DoomConfigProvenance {
  /** Absolute path of the declaring configuration file. */
  filePath: string;
  /** Directory used to resolve paths authored by that file. */
  baseDirectory: string;
}

/** One `.doom` document plus the root its relative paths resolve against. */
export interface DoomConfigSource<TDocument> extends DoomConfigProvenance {
  /** Absolute path of the file the document was read from. */
  filePath: string;
  /**
   * Where relative paths inside this document point.
   *
   * A repository document resolves against the repository root, so `plugins/x`
   * keeps meaning the same thing it always has. A global document resolves
   * against the global `.doom` directory, so it can name plugins and extensions
   * that live beside it in `~/.pi/.doom` rather than inside whichever
   * repository happens to be open.
   */
  baseDirectory: string;
  /** Raw file contents, for callers that cache parsed results by source text. */
  text: string;
  document: TDocument;
}

/**
 * Reads one named `.doom` document from the global and repository config
 * directories, lowest precedence first.
 *
 * A missing or empty file contributes nothing, so either location on its own is
 * a complete configuration. Documents are deliberately returned unmerged:
 * merging is by name, and only the caller knows what a name means in its own
 * document, so each one folds the sources itself with the repository last.
 */
export function doomConfigCandidates(
  fileName: string,
  repoRoot: string,
  homeDirectory: string = os.homedir(),
): Array<{ filePath: string; baseDirectory: string }> {
  const globalDirectory = globalDoomConfigDirectory(homeDirectory);
  return [
    { filePath: path.join(globalDirectory, fileName), baseDirectory: globalDirectory },
    { filePath: path.join(repoRoot, DOOM_DIR, fileName), baseDirectory: repoRoot },
  ];
}

export function readDoomConfigSources<TDocument>(
  fileName: string,
  repoRoot: string,
  homeDirectory: string = os.homedir(),
): Array<DoomConfigSource<TDocument>> {
  const candidates = doomConfigCandidates(fileName, repoRoot, homeDirectory);

  const sources: Array<DoomConfigSource<TDocument>> = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.filePath)) continue;
    const text = fs.readFileSync(candidate.filePath, TEXT_ENCODING);
    const document = parseYaml(text) as TDocument | null | undefined;
    // An empty file parses to null and is treated as an absent one, so a seeded
    // placeholder never has to be deleted to get out of the way.
    if (document === null || document === undefined) continue;
    sources.push({ ...candidate, text, document });
  }
  return sources;
}

/**
 * Merges same-named records across sources, tagging each entry with the base
 * directory of the document that supplied it.
 *
 * Later sources win outright rather than being deep-merged: a repository that
 * redefines a name is replacing it, and a half-inherited definition whose paths
 * straddle two roots would be impossible to resolve.
 */
export function mergeNamedSources<TDocument, TEntry extends object>(
  sources: ReadonlyArray<DoomConfigSource<TDocument>>,
  select: (document: TDocument) => Record<string, TEntry> | undefined,
): Record<string, TEntry & DoomConfigProvenance> {
  const merged: Record<string, TEntry & DoomConfigProvenance> = {};
  for (const source of sources) {
    for (const [name, entry] of Object.entries(select(source.document) ?? {})) {
      merged[name] = {
        ...entry,
        baseDirectory: source.baseDirectory,
        filePath: source.filePath,
      };
    }
  }
  return merged;
}
