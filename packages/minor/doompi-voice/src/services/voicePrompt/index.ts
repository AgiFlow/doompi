import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
export async function readVoicePrompt(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate Voice package resources.');
    directory = parent;
  }
  return readFile(join(directory, 'src/prompts/doompi-use-voice/SKILL.md'), 'utf8');
}
