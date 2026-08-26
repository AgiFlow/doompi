import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  files?: string[];
  keywords?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function conditions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

describe('doompi-major-mode package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-major-mode');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(
      expect.arrayContaining(['dist', 'llms.txt', 'src/prompts', 'README.md', 'package.json']),
    );
    expect(manifest.keywords).toEqual([
      'ai',
      'coding-agent',
      'developer-tools',
      'doompi',
      'layer-composition',
      'major-mode',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'session-reload',
    ]);
  });

  it('keeps closed exports and one Pi discovery entry', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).not.toContain('./extensions/doom');
    for (const subpath of ['.', './extensions/pi']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('routes Pi discovery through the command and voice-tool factory', async () => {
    const entry = await readFile(path.join(packageDirectory, 'src/exports/extensions/pi.ts'), 'utf8');
    const factory = await readFile(path.join(packageDirectory, 'src/adapters/pi/extension.ts'), 'utf8');

    expect(entry).toContain("from '../../adapters/pi/extension.ts'");
    expect(entry).toContain('as default');
    expect(entry).not.toContain('doom.ts');
    expect(factory).toContain('registerMajorModeCommand');
    expect(factory).toContain('registerMajorModeVoiceCapability');
    expect(factory).toContain('connectDoomCordisHost');
    expect(factory).toContain('.root.plugin(');
    expect(factory).toContain('inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE]');
    expect(factory).not.toContain('new Context()');
  });

  it('never depends on the host package, which would make the build graph cyclic', async () => {
    const manifest = await readManifest();
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(declared).not.toContain('@agimon-ai/doompi');
  });

  it('ships an H1-led Help index whose linked resources are allowlisted', async () => {
    const manifest = await readManifest();
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');
    const relativeLinks = [...index.matchAll(/\]\((\.\/[^)]+)\)/gu)].map((match) => match[1]!);

    expect(index).toMatch(/^# Doom Pi Major Mode$/m);
    expect(relativeLinks).toEqual([
      './src/prompts/doompi-author-major-mode/SKILL.md',
      './src/prompts/doompi-author-major-mode/references/modes-contract.md',
      './README.md',
    ]);
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'src/prompts', 'README.md']));

    const allowlist = new Set(manifest.files ?? []);
    for (const relativeLink of relativeLinks) {
      const packagePath = relativeLink.slice(2);
      expect([...allowlist].some((entry) => packagePath === entry || packagePath.startsWith(`${entry}/`))).toBe(true);
      expect((await readFile(path.join(packageDirectory, packagePath), 'utf8')).length).toBeGreaterThan(0);
    }

    const skill = await readFile(path.join(packageDirectory, 'src/prompts/doompi-author-major-mode/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: doompi-author-major-mode\n/u);
    expect(skill).toContain('[references/modes-contract.md](references/modes-contract.md)');
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    for (const pi of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      expect(manifest.peerDependencies?.[pi]).toBe('0.84.3');
      expect(manifest.devDependencies?.[pi]).toBe('0.84.3');
    }
  });
});
