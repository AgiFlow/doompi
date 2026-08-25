import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type JsonRecord = Record<string, unknown>;

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_MANIFEST = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as JsonRecord;
const PROJECT_CONFIG = readFileSync(resolve(PACKAGE_ROOT, 'project.json'), 'utf8');
const CONFIG_FILES = ['tsdown.config.ts', 'tsconfig.json', 'vitest.config.ts', 'vibe-lint.config.yaml'];
const HELP_INDEX = 'llms.txt';
const PACKAGE_README = 'README.md';
const RECOVERY_SKILL = 'skills/workflow-recovery/SKILL.md';
const PROMPTS_ROOT = 'src/prompts';
const SKILL_EXPORT = `./${RECOVERY_SKILL}`;
// The web plugin is not an export: the cockpit's bundler compiles it from the
// source the doompiWeb manifest names; './web-hub' is the built hub channel entry.
const EXPORT_SUBPATHS = ['.', './extensions/pi', './package.json', './web-hub', SKILL_EXPORT];
const STANDARD_ENTRY = './dist/extensions/pi.mjs';

function objectValue(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as JsonRecord;
}

function dependencyNames(value: unknown): string[] {
  return Object.keys(objectValue(value));
}

function localMarkdownReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1])
    .filter((reference): reference is string => Boolean(reference) && !/^[a-z][a-z0-9+.-]*:/iu.test(reference));
}

function isAllowlisted(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

describe('@agimon-ai/doompi-workflow package shape', () => {
  it('keeps the publishable package identity', () => {
    expect(PACKAGE_MANIFEST.name).toBe('@agimon-ai/doompi-workflow');
    expect(PACKAGE_MANIFEST.private).toBeUndefined();
    expect(PACKAGE_MANIFEST.version).toMatch(SEMVER_PATTERN);
  });

  it('declares the shared Doom UI and exact Cordis runtime without retaining rig packages', () => {
    expect(dependencyNames(PACKAGE_MANIFEST.dependencies)).toContain('@agimon-ai/doompi-ui');
    expect(objectValue(PACKAGE_MANIFEST.dependencies)['@deepseek-ai/cordis']).toBe('4.0.1');
    expect(objectValue(PACKAGE_MANIFEST.devDependencies)['@earendil-works/pi-coding-agent']).toBe('0.84.2');
    expect(objectValue(PACKAGE_MANIFEST.peerDependencies)['@earendil-works/pi-coding-agent']).toBe('0.84.2');
    expect(dependencyNames(PACKAGE_MANIFEST.dependencies).some((name) => name.startsWith('@agimonai/rig-'))).toBe(
      false,
    );
    expect(dependencyNames(PACKAGE_MANIFEST.devDependencies).some((name) => name.startsWith('@agimonai/rig-'))).toBe(
      false,
    );
  });

  it('uses package-local configuration and the Doom extension source template', () => {
    expect(objectValue(PACKAGE_MANIFEST.exports)).toEqual(
      expect.objectContaining({
        '.': expect.anything(),
        './extensions/pi': expect.anything(),
        './package.json': expect.anything(),
      }),
    );
    expect(PROJECT_CONFIG).toContain('"sourceTemplate": "doom-extension"');
    for (const file of CONFIG_FILES) {
      expect(readFileSync(resolve(PACKAGE_ROOT, file), 'utf8')).not.toMatch(/@agimon-ai\/rig-/);
    }
  });

  it('declares a closed built export surface with one standard Pi entry', () => {
    const exports = objectValue(PACKAGE_MANIFEST.exports);
    expect(Object.keys(exports).sort()).toEqual([...EXPORT_SUBPATHS].sort());
    expect(exports).not.toHaveProperty('./*');

    const serializedExports = JSON.stringify(exports);
    expect(serializedExports).toContain('.mjs');
    expect(serializedExports).toContain('.cjs');
    expect(serializedExports).toMatch(/\.d\.[cm]?ts/);

    const pi = objectValue(PACKAGE_MANIFEST.pi);
    expect(pi.extensions).toEqual([STANDARD_ENTRY]);
    expect(exports).not.toHaveProperty('./extensions/dispatcher');
    expect(readFileSync(resolve(PACKAGE_ROOT, 'tsdown.config.ts'), 'utf8')).not.toContain('extensions/dispatcher');
    expect(readFileSync(resolve(PACKAGE_ROOT, 'src/exports/index.ts'), 'utf8')).not.toMatch(
      /registerWorkflow(?:Dispatcher)?Extension/u,
    );
  });

  it('declares the workflow-recovery skill so Pi can discover it from the manifest', () => {
    // A consumer installs this package rather than reading the checkout, so the
    // skill has to be both declared and shipped to be discoverable.
    const exports = objectValue(PACKAGE_MANIFEST.exports);
    expect(exports[SKILL_EXPORT]).toBe(SKILL_EXPORT);
    expect(PACKAGE_MANIFEST.files).toContain(RECOVERY_SKILL);
    expect(existsSync(resolve(PACKAGE_ROOT, SKILL_EXPORT))).toBe(true);
  });

  it('ships an H1-led Help index and every linked package resource', () => {
    const files = PACKAGE_MANIFEST.files as string[];
    const index = readFileSync(resolve(PACKAGE_ROOT, HELP_INDEX), 'utf8');

    expect(index).toMatch(/^#\s+\S+/u);
    expect(files).toEqual(expect.arrayContaining([HELP_INDEX, PACKAGE_README, PROMPTS_ROOT, RECOVERY_SKILL]));
    for (const reference of localMarkdownReferences(index)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isAllowlisted(files, relativePath), relativePath).toBe(true);
      expect(existsSync(resolve(PACKAGE_ROOT, relativePath)), relativePath).toBe(true);
    }
  });

  it('keeps idea files out of the published allowlist', () => {
    for (const entry of PACKAGE_MANIFEST.files as string[]) {
      expect(entry).not.toContain('ideas');
      expect(entry).not.toMatch(/\.pen$/);
    }
  });
});
