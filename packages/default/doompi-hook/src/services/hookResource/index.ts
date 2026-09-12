import { readFile } from 'node:fs/promises';
const PACKAGE_ROOT = new URL('../../../', import.meta.url);

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export const readHookResource = (): Promise<string> =>
  readOrFallback(new URL('src/prompts/doompi-author-hook/SKILL.md', PACKAGE_ROOT).pathname, '(resource unavailable)');
