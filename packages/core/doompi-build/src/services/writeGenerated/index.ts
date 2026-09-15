import fs from 'node:fs';
import path from 'node:path';

/** What a sync pass did, or would have done. */
export interface WriteResult {
  /** Package-relative paths whose contents changed. */
  readonly changed: readonly string[];
}

export class StaleGeneratedError extends Error {
  constructor(readonly stale: readonly string[]) {
    super(`Stale generated files: ${stale.join(', ')}. Run the package's build to regenerate them.`);
    this.name = 'StaleGeneratedError';
  }
}

/**
 * Write-if-changed locally, throw on stale under an explicit `check`.
 *
 * Generated entries are ignored build inputs, so normal and CI builds create
 * them. Explicit check mode remains available to callers that need to compare
 * an existing generated tree without changing it.
 *
 * Writing only on a real change matters for watch mode: an unconditional
 * write would retrigger the watcher that called it.
 */
export function writeGenerated(
  packageDir: string,
  files: ReadonlyMap<string, string>,
  check = false,
  managed: readonly string[] = [],
): WriteResult {
  const changed: string[] = [];

  for (const [relative, contents] of files) {
    const absolute = path.join(packageDir, relative);
    const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
    if (existing === contents) continue;
    changed.push(relative);
    if (check) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }

  for (const relative of managed) {
    if (files.has(relative)) continue;
    const absolute = path.join(packageDir, relative);
    if (!fs.existsSync(absolute)) continue;
    changed.push(relative);
    if (!check) fs.rmSync(absolute);
  }

  if (check && changed.length > 0) throw new StaleGeneratedError(changed);
  return { changed };
}
