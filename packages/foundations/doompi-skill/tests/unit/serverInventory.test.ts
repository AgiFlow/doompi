import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverServerSkills } from '../../src/services/serverInventory';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`);
}

async function writePlugin(repoRoot: string, name: string, skill: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', name);
  await writeSkill(path.join(pluginRoot, 'skills', skill), skill);
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', description: name }),
  );
}

async function repository(domainsYaml: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'doompi-server-inventory-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, '.doom'), { recursive: true });
  await writeFile(path.join(root, '.doom', 'domains.yaml'), domainsYaml);
  return root;
}

function execution(root: string): DoomHeadlessExecutionContext {
  return { cwd: root, repoRoot: root, environment: { HOME: root } } as unknown as DoomHeadlessExecutionContext;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('discoverServerSkills', () => {
  it('offers shared skills to every domain that keeps them and to none that drops them', async () => {
    const root = await repository(
      'plugins:\n  roots: [plugins]\n\ndomains:\n  writing:\n    plugins: [writing]\n  lean:\n    sharedSkills: false\n',
    );
    await writePlugin(root, 'writing', 'outline');
    await writeSkill(path.join(root, '.claude', 'skills', 'vibe-lint'), 'vibe-lint');

    const { groups } = await discoverServerSkills(execution(root), signal());
    const owners = (name: string) =>
      groups.filter((group) => group.skills.some((skill) => skill.name === name)).map((group) => group.domain);

    // A domain that opts out never activates the shared group, and a domain
    // that keeps them carries its own copy: that is how "unless every selected
    // domain opts out" survives a condition that can only say `domain`.
    expect(owners('vibe-lint')).toEqual(['writing']);
    expect(owners('outline')).toEqual(['writing']);
  });

  it('reports a broken domain instead of losing every other domain', async () => {
    const root = await repository(
      'plugins:\n  roots: [plugins]\n\ndomains:\n  writing:\n    plugins: [writing]\n  broken:\n    plugins: [absent]\n',
    );
    await writePlugin(root, 'writing', 'outline');

    const { groups, inventory } = await discoverServerSkills(execution(root), signal());

    expect(groups.flatMap((group) => group.skills.map((skill) => skill.name))).toEqual(['outline']);
    expect(inventory.diagnostics.some((entry) => entry.startsWith("Domain 'broken':"))).toBe(true);
  });

  it('keeps repository skills ungated and in the catalog', async () => {
    const root = await repository('domains:\n  writing: {}\n');
    await writeSkill(path.join(root, '.doom', 'skills', 'house-style'), 'house-style');

    const { groups, catalog } = await discoverServerSkills(execution(root), signal());

    expect(groups).toEqual([{ skills: [expect.objectContaining({ name: 'house-style' })] }]);
    expect(catalog).toContain('house-style');
  });
});
