import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  files?: string[];
}

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const helpIndex = 'llms.txt';
const resourceFiles = ['SKILL.md', 'references/config-contract.md', 'agents/openai.yaml'];
const canonicalRoot = path.join(packageDirectory, 'src', 'prompts', 'doompi-author-config');

function isAllowlisted(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

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

describe('doom Pi config packaged skill resources', () => {
  it('keeps every canonical resource self-contained in the package', async () => {
    for (const relativePath of resourceFiles) {
      const canonical = await readFile(path.join(canonicalRoot, relativePath), 'utf8');

      expect(canonical.trim().length, relativePath).toBeGreaterThan(0);
      expect(canonical, relativePath).not.toContain('plugins/pi-development');
    }
  });

  it('resolves every relative Markdown reference from the packed canonical root', async () => {
    const markdown = await readFile(path.join(canonicalRoot, 'SKILL.md'), 'utf8');

    for (const reference of localMarkdownReferences(markdown)) {
      await expect(access(path.resolve(canonicalRoot, reference))).resolves.toBeUndefined();
    }
  });

  it('ships an H1-led Help index and every linked package resource', async () => {
    const manifest = await readJsonFile<PackageManifest>(path.join(packageDirectory, 'package.json'));
    const files = manifest.files ?? [];
    const markdown = await readFile(path.join(packageDirectory, helpIndex), 'utf8');

    expect(markdown).toMatch(/^#\s+\S+/u);
    expect(files).toContain(helpIndex);
    for (const reference of localMarkdownReferences(markdown)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isAllowlisted(files, relativePath), relativePath).toBe(true);
      await expect(access(path.resolve(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }
  });

  it('allowlists the prompts resource root without packaging all source or tests', async () => {
    const manifest = await readJsonFile<PackageManifest>(path.join(packageDirectory, 'package.json'));
    const files = manifest.files ?? [];

    expect(files).toContain('src/prompts');
    expect(files).not.toContain('src');
    expect(files).not.toContain('tests');

    for (const relativePath of resourceFiles) {
      await expect(access(path.join(canonicalRoot, relativePath))).resolves.toBeUndefined();
    }
  });
});
