import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  files?: string[];
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const promptRoot = 'src/prompts/doompi-author-extension';
const resourceFiles = [`${promptRoot}/SKILL.md`, `${promptRoot}/references/extension-contract.md`];

function isAllowlisted(files: readonly string[] | undefined, relativePath: string): boolean {
  return files?.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`)) ?? false;
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

describe('DoomPi packaged Help resources', () => {
  it('ships an H1-led index whose local links stay inside the publish allowlist', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^#\s+\S+/u);
    for (const reference of localMarkdownReferences(index)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isAllowlisted(manifest.files, relativePath), relativePath).toBe(true);
      await expect(access(path.resolve(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }
  });

  it('keeps the extension skill self-contained and removes the obsolete package docs allowlist', async () => {
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
    const skillRoot = path.join(packageDirectory, promptRoot);
    const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');

    expect(manifest.files).not.toContain('docs');
    expect(manifest.files).toContain('src/prompts');
    for (const relativePath of resourceFiles) {
      expect(isAllowlisted(manifest.files, relativePath), relativePath).toBe(true);
      await expect(access(path.join(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }
    for (const reference of localMarkdownReferences(skill)) {
      await expect(access(path.resolve(skillRoot, reference)), reference).resolves.toBeUndefined();
    }
  });
});
