import path from 'node:path';

/** Scores, highest first: an exact folder name beats a prefix, which beats a substring. */
const EXACT_NAME = 1000;
const NAME_PREFIX = 800;
const NAME_CONTAINS = 600;
const PATH_CONTAINS = 400;
/** Each level down costs this much, so a shallow answer wins a deep one of the same kind. */
const DEPTH_PENALTY = 12;

/**
 * How well one directory answers a typed query, or undefined when it does not.
 *
 * The reader is naming a project, so the folder's own name is what they mean;
 * a match further up the path still counts, because "workspace/agi" is a
 * reasonable way to point at a folder, but it ranks below a name that matches
 * outright. Depth is the tiebreak: given `~/work/api` and
 * `~/work/api/node_modules/x/api`, the first is what anyone meant.
 */
export function scoreDirectory(absolutePath: string, query: string): number | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === '') return undefined;
  const name = path.basename(absolutePath).toLowerCase();
  const depth = absolutePath.split(path.sep).filter(Boolean).length;

  const base =
    name === needle
      ? EXACT_NAME
      : name.startsWith(needle)
        ? NAME_PREFIX
        : name.includes(needle)
          ? NAME_CONTAINS
          : absolutePath.toLowerCase().includes(needle)
            ? PATH_CONTAINS
            : undefined;
  if (base === undefined) return undefined;
  return base - depth * DEPTH_PENALTY;
}

/**
 * The best directories for a query, deduplicated and cut to the limit. Ties
 * break alphabetically so the same query always lists the same way.
 */
export function rankDirectories(paths: Iterable<string>, query: string, limit: number): string[] {
  const scored = new Map<string, number>();
  for (const candidate of paths) {
    if (scored.has(candidate)) continue;
    const score = scoreDirectory(candidate, query);
    if (score !== undefined) scored.set(candidate, score);
  }
  return [...scored.entries()]
    .sort(
      ([leftPath, leftScore], [rightPath, rightScore]) => rightScore - leftScore || leftPath.localeCompare(rightPath),
    )
    .slice(0, limit)
    .map(([candidate]) => candidate);
}

/**
 * The part of a typed value to search for when it is not a path that exists.
 *
 * Someone typing a remembered path from another machine ("/home/me/work/api")
 * still means "api", so the trailing segment is the query and the rest is
 * discarded rather than treated as a location that must exist.
 */
export function searchTermFor(typed: string): string {
  const trimmed = typed.trim().replace(/\/+$/u, '');
  if (trimmed === '') return '';
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}
