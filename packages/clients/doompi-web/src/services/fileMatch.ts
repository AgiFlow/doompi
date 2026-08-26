/**
 * Ranking for the composer's @ file completion: pure string policy, no
 * filesystem, so the ordering rules stay testable on their own.
 */

interface RankedMatch {
  file: string;
  rank: number;
}

/**
 * Case-insensitive substring match, ranked so what a person is reaching for
 * surfaces first: basename prefix beats basename substring beats path
 * substring, earlier and shorter paths break ties.
 */
export function rankFileMatches(files: readonly string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase();
  const ranked: RankedMatch[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let rank: number;
    if (needle === '') rank = 3;
    else if (base.startsWith(needle)) rank = 0;
    else if (base.includes(needle)) rank = 1;
    else if (lower.includes(needle)) rank = 2;
    else continue;
    ranked.push({ file, rank });
  }
  return ranked
    .sort(
      (left, right) =>
        left.rank - right.rank || left.file.length - right.file.length || left.file.localeCompare(right.file),
    )
    .slice(0, limit)
    .map((entry) => entry.file);
}
