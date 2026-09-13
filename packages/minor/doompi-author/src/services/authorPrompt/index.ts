import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readAuthorPrompt(moduleUrl: string | URL = import.meta.url): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const prompt = path.join(directory, 'src/prompts/doompi-use-author/SKILL.md');
    if (existsSync(prompt)) return readFile(prompt, 'utf8');
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not locate the Author prompt resource.');
    directory = parent;
  }
}
