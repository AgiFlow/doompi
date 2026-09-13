import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read a shipped Help resource from source or compiled package modules. */
export async function readHelpResource(file: string, moduleUrl: string | URL = import.meta.url): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(path.join(directory, 'src/prompts/doompi-use-help/SKILL.md'))) {
      try {
        return await readFile(path.join(directory, file), 'utf8');
      } catch {
        return '(resource unavailable)';
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return '(resource unavailable)';
    directory = parent;
  }
}
