import type { PresentedLine } from './hashlineView.ts';

/**
 * Grouping for highlighted hashline bodies.
 *
 * A read result is one file and a grep result is many, so the lines a card
 * shows have to be cut into runs that belong to the same file before any of
 * them can be parsed. A run is parsed whole because a string or a comment
 * spans lines, and grep's gaps between context blocks are accepted: an excerpt
 * is not the file, and colouring it as if it were is close enough to be worth
 * far more than colouring nothing.
 */

export interface HashlineGroup {
  /** The file the run came from, when the body named one. */
  readonly path: string | undefined;
  /** Indices into the presented lines, in order, that this run covers. */
  readonly indices: readonly number[];
  /** The run's content, newline-joined, ready to parse. */
  readonly text: string;
}

/**
 * Consecutive anchored lines, cut at every file heading and at anything that
 * is not code. `fallbackPath` names the file for a body that never states one,
 * which is how a read result arrives.
 */
export function hashlineGroups(
  lines: readonly PresentedLine[],
  fallbackPath: string | undefined,
): readonly HashlineGroup[] {
  const groups: HashlineGroup[] = [];
  let path = fallbackPath;
  let indices: number[] = [];
  let texts: string[] = [];

  const flush = (): void => {
    if (indices.length > 0) groups.push({ path, indices, text: texts.join('\n') });
    indices = [];
    texts = [];
  };

  for (const [index, line] of lines.entries()) {
    if (line.type === 'tagged') {
      indices.push(index);
      texts.push(line.value.content);
      continue;
    }
    flush();
    // A heading opens the next file; a plain line is prose between runs.
    if (line.type === 'file') path = line.path;
  }
  flush();
  return groups;
}

/** One string that changes whenever the groups would highlight differently. */
export function hashlineGroupsKey(groups: readonly HashlineGroup[]): string {
  return groups.map((group) => `${group.path ?? ''}\u0000${group.text}`).join('\u0001');
}
