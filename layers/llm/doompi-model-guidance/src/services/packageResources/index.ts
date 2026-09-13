import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve resources from both source and compiled package modules. */
export async function readPackageResource(name: string, moduleUrl: string | URL = import.meta.url): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(path.join(directory, 'src/prompts/doompi-use-model-guidance/SKILL.md'))) {
      try {
        return await readFile(path.join(directory, name), 'utf8');
      } catch {
        return `(resource unavailable: ${name})`;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return `(resource unavailable: ${name})`;
    directory = parent;
  }
}
