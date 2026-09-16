import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of a file shipped by the calling package.
 *
 * Anchored on the nearest ancestor holding a `package.json`, which is the only
 * sentinel that is correct from `src/` and from `dist/` alike. Counting levels
 * with a fixed `new URL('../../..', import.meta.url)` is not: a bundled entry
 * sits at a different depth than its source, so the walk lands outside the
 * package and every read misses.
 *
 * `moduleUrl` is required on purpose. A default of `import.meta.url` resolves to
 * this package rather than the caller's, which is a silently wrong answer.
 */
export function packageResourcePath(moduleUrl: string | URL, file: string): string | undefined {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(path.join(directory, 'package.json'))) {
      const candidate = path.join(directory, file);
      return existsSync(candidate) ? candidate : undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Text of a file shipped by the calling package, or `''` when it is not there.
 *
 * Empty rather than a placeholder, and never a throw. A context resource's text
 * is pasted into the system prompt, so `'(resource unavailable: README.md)'` is
 * a string the model pays for and may act on; `''` is dropped by the prompt
 * composer instead. A throw is worse still: it propagates out of resource
 * resolution and fails the whole prompt build.
 */
export async function readPackageResource(moduleUrl: string | URL, file: string): Promise<string> {
  const resolved = packageResourcePath(moduleUrl, file);
  if (resolved === undefined) return '';
  try {
    return await readFile(resolved, 'utf8');
  } catch {
    return '';
  }
}
