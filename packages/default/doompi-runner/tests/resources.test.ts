import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  files?: string[];
}

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const canonicalSkill = path.join(packageDirectory, 'skills', 'doom-runner', 'SKILL.md');

async function readJsonFile<TValue>(filePath: string): Promise<TValue> {
  return JSON.parse(await readFile(filePath, 'utf8')) as TValue;
}

function localMarkdownReferences(markdown: string): string[] {
  const references: string[] = [];
  const pattern = /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const reference = match[1];
    if (reference && !reference.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/iu.test(reference)) {
      references.push(reference);
    }
  }
  return references;
}

describe('doom runner packaged skill resources', () => {
  it('keeps the package skill self-contained as its canonical source', async () => {
    const canonical = await readFile(canonicalSkill, 'utf8');

    expect(canonical).toContain('name: doom-runner');
    expect(canonical).not.toMatch(/(?:agirepo-worktree|\.\.\/\.\.\/packages\/)/iu);
  });

  it('resolves every relative Markdown reference from the packed skill root', async () => {
    const markdown = await readFile(canonicalSkill, 'utf8');

    for (const reference of localMarkdownReferences(markdown)) {
      await expect(access(path.resolve(path.dirname(canonicalSkill), reference))).resolves.toBeUndefined();
    }
  });

  it('allowlists the canonical skill without packaging source or tests', async () => {
    const manifest = await readJsonFile<PackageManifest>(path.join(packageDirectory, 'package.json'));
    const files = manifest.files ?? [];

    expect(files.some((entry) => entry === 'skills' || entry === 'skills/**' || entry.startsWith('skills/'))).toBe(
      true,
    );
    expect(files).not.toContain('src');
    expect(files).not.toContain('tests');
  });
});
