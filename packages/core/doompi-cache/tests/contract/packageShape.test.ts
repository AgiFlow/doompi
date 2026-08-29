// @scaffold-generated
import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  files?: string[];
  keywords?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string };
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const PROMPT_SUPPORT_DIRECTORIES = new Set(['agents', 'assets', 'references', 'scripts']);

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function conditions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

function localMarkdownReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1])
    .filter((reference): reference is string => Boolean(reference) && !/^[a-z][a-z0-9+.-]*:/iu.test(reference));
}

function isPublished(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => {
    const normalizedEntry = entry.replace(/\/+$/u, '');
    return relativePath === normalizedEntry || relativePath.startsWith(`${normalizedEntry}/`);
  });
}

function frontmatterField(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)?.groups?.body;
  if (!frontmatter) return undefined;
  const value = new RegExp(`^${field}:\\s*(.+)$`, 'mu').exec(frontmatter)?.[1]?.trim();
  if (!value) return undefined;
  const quoted = /^(?<quote>['"])(?<content>.*)\k<quote>$/u.exec(value);
  return quoted?.groups?.content ?? value;
}

describe('doompi-cache package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-cache');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(
      expect.arrayContaining(['dist', 'src/prompts', 'llms.txt', 'README.md', 'package.json']),
    );
    const keywords = manifest.keywords ?? [];
    expect(keywords).toEqual(
      expect.arrayContaining([
        'coding-agent',
        'doompi',
        'pi-coding-agent',
        'pi-extension',
        'pi-package',
        'typescript',
        'prompt-cache',
      ]),
    );
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords).toEqual(keywords.map((keyword) => keyword.toLowerCase()));
  });

  it('keeps closed ESM, CJS, and declaration exports plus Pi discovery metadata', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './env', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(conditions(exportsMap['.'])).toEqual(['types', 'import', 'require']);
    expect(conditions(exportsMap['./env'])).toEqual(['types', 'import', 'require']);
    expect(conditions(exportsMap['./extensions/pi'])).toEqual(['types', 'import', 'require']);
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('ships an H1-led Help index and every linked package resource', async () => {
    const manifest = await readManifest();
    const files = manifest.files ?? [];
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^#\s+\S+/u);
    for (const reference of localMarkdownReferences(index)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isPublished(files, relativePath), relativePath).toBe(true);
      await expect(access(path.resolve(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }
  });

  it('ships well-formed package Help prompts and indexes every prompt', async () => {
    const manifest = await readManifest();
    const files = manifest.files ?? [];
    const promptRoot = path.join(packageDirectory, 'src/prompts');
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');
    const references = new Set(localMarkdownReferences(index).map((reference) => reference.replace(/^\.\//u, '')));
    const promptDirectories = await readdir(promptRoot, { withFileTypes: true });

    expect(files.filter((entry) => entry === 'src/prompts')).toHaveLength(1);
    expect(promptDirectories.length).toBeGreaterThan(0);

    for (const promptDirectory of promptDirectories) {
      expect(promptDirectory.isDirectory(), promptDirectory.name).toBe(true);
      expect(promptDirectory.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

      const promptPath = path.join(promptRoot, promptDirectory.name);
      const entries = await readdir(promptPath, { withFileTypes: true });
      const skillFiles = entries.filter((entry) => entry.isFile() && entry.name === 'SKILL.md');
      expect(skillFiles, promptDirectory.name).toHaveLength(1);

      for (const entry of entries.filter((candidate) => candidate.name !== 'SKILL.md')) {
        expect(entry.isDirectory(), `${promptDirectory.name}/${entry.name}`).toBe(true);
        expect(PROMPT_SUPPORT_DIRECTORIES.has(entry.name), `${promptDirectory.name}/${entry.name}`).toBe(true);
      }

      const skill = await readFile(path.join(promptPath, 'SKILL.md'), 'utf8');
      expect(frontmatterField(skill, 'name')).toBe(promptDirectory.name);
      expect(frontmatterField(skill, 'description')?.trim().length ?? 0).toBeGreaterThan(0);
      expect(references).toContain(`src/prompts/${promptDirectory.name}/SKILL.md`);
    }
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
  });
});
