import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  files?: string[];
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

function localMarkdownReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1])
    .filter((reference): reference is string => Boolean(reference) && !/^[a-z][a-z0-9+.-]*:/iu.test(reference));
}

function isAllowlisted(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

describe('Doom Skill packaged Help resources', () => {
  it('ships author and use prompts through its H1-led package index', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
    const files = manifest.files ?? [];
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^# Doom Pi Skill$/m);
    expect(files).toContain('src/prompts');
    for (const reference of localMarkdownReferences(index)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isAllowlisted(files, relativePath), relativePath).toBe(true);
      await expect(access(path.join(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }

    await expect(
      readFile(path.join(packageDirectory, 'src/prompts/doompi-author-skill/SKILL.md'), 'utf8'),
    ).resolves.toMatch(/^---\nname: doompi-author-skill$/m);
    await expect(
      readFile(path.join(packageDirectory, 'src/prompts/doompi-use-skill/SKILL.md'), 'utf8'),
    ).resolves.toMatch(/^---\nname: doompi-use-skill$/m);
  });
});
