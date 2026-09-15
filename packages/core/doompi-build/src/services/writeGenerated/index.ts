import fs from 'node:fs';
import path from 'node:path';

/** What a sync pass did, or would have done. */
export interface WriteResult {
  /** Package-relative paths whose contents changed. */
  readonly changed: readonly string[];
}

export class StaleGeneratedError extends Error {
  constructor(readonly stale: readonly string[]) {
    super(
      `Stale generated files: ${stale.join(', ')}. Run the package's build to regenerate them, then commit the result.`,
    );
    this.name = 'StaleGeneratedError';
  }
}

/**
 * Write-if-changed locally, throw on stale under `check`.
 *
 * The same contract `ensureBuiltinWebPluginModules` already uses for the
 * cockpit's generated registry. Generated entries are committed so every
 * consumer, the Pi compiler and the server bundle loader included, keeps
 * reading a real file at a stable path. CI then proves the committed copy
 * matches the tree it came from.
 *
 * Writing only on a real change matters for watch mode: an unconditional
 * write would retrigger the watcher that called it.
 */
export function writeGenerated(packageDir: string, files: ReadonlyMap<string, string>, check = false): WriteResult {
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

  if (check && changed.length > 0) throw new StaleGeneratedError(changed);
  return { changed };
}
