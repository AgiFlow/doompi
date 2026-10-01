/**
 * The two-level grouping a changed-file list uses: one header per top-level
 * segment, each naming the deepest directory its files share.
 *
 * Two levels rather than a full tree: paths here run five and six segments
 * deep, so a node per segment spends more rows on directories than on the files
 * someone came to find. The header carries the shared run of directories and
 * each row carries what is left, so a file stays one row and the part that
 * distinguishes it stays readable.
 */

/** One header row and the items under it. */
export interface PathGroup<T> {
  /** The shared directory the header names, or empty for files at the root. */
  prefix: string;
  items: T[];
}

/** The directory part of a relative path, or empty for a file at the root. */
function parentDir(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut === -1 ? '' : relPath.slice(0, cut);
}

/** The longest directory two paths share, compared segment by segment rather than character by character. */
function commonDir(left: string, right: string): string {
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  const shared: string[] = [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) break;
    shared.push(leftParts[index]);
  }
  return shared.join('/');
}

/** Groups by top-level segment, ordered by path so a header's files sit together under it. */
export function groupByDirectory<T>(items: readonly T[], pathOf: (item: T) => string): PathGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const relPath = pathOf(item);
    const cut = relPath.indexOf('/');
    const key = cut === -1 ? '' : relPath.slice(0, cut);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  const groups: PathGroup<T>[] = [];
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket].sort((left, right) => pathOf(left).localeCompare(pathOf(right)));
    // Root files have no directory to name, so they keep an empty header and
    // render their own paths in full.
    const prefix = key === '' ? '' : sorted.map((item) => parentDir(pathOf(item))).reduce(commonDir);
    groups.push({ prefix, items: sorted });
  }
  return groups.sort((left, right) => left.prefix.localeCompare(right.prefix));
}

/** What one row shows once its group's header has already said the shared part. */
export function groupRowLabel(prefix: string, relPath: string): string {
  return prefix === '' ? relPath : relPath.slice(prefix.length + 1);
}
