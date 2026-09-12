import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function readLoopResource(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Loop package resource not found.');
    directory = parent;
  }
  return readFile(path.join(directory, 'src/prompts/doompi-use-loop/SKILL.md'), 'utf8');
}
