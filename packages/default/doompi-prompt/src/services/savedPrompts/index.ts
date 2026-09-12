import { readFile } from 'node:fs/promises';
import { resolvePromptsDirectory } from '../promptStore';
import { parsePromptDocument } from '../savedPromptDocument';
const PACKAGE_ROOT = new URL('../../../', import.meta.url);

export async function savedPrompts(): Promise<readonly { name: string; text: string; description: string }[]> {
  const directory = resolvePromptsDirectory();
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory, { withFileTypes: true });
    const prompts = [] as { name: string; text: string; description: string }[];
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && candidate.name.endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name.slice(0, -3);
      prompts.push(parsePromptDocument(name, await readFile(`${directory}/${entry.name}`, 'utf8')));
    }
    return prompts;
  } catch {
    return [];
  }
}

export async function readPromptSkill(): Promise<string> {
  try {
    return await readFile(new URL('src/prompts/doompi-use-prompt/SKILL.md', PACKAGE_ROOT), 'utf8');
  } catch {
    return '(resource unavailable)';
  }
}
