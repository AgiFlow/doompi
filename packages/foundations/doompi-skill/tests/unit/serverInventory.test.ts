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

async function writePlugin(repoRoot: string, name: string, skill: string, packageName?: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', name);
  await writeSkill(path.join(pluginRoot, 'skills', skill), skill);
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', description: name }),
  );
  if (packageName) await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: packageName }));
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

  it('keeps minor modes other than computer-use and plan, plus git and user-feedback, local only', async () => {
    const localOnlyPackages = [
      '@agimon-ai/doompi-author',
      '@agimon-ai/doompi-git',
      '@agimon-ai/doompi-goal',
      '@agimon-ai/doompi-help',
      '@agimon-ai/doompi-loop',
      '@agimon-ai/doompi-user-feedback',
      '@agimon-ai/doompi-voice',
      '@agimon-ai/doompi-workflow',
    ];
    const remotePackages = ['@agimon-ai/doompi-computer-use', '@agimon-ai/doompi-plan', '@example/catalog-plugin'];
    const packages = [...localOnlyPackages, ...remotePackages];
    const pluginNames = packages.map((_, index) => `plugin-${index}`);
    const root = await repository(
      `plugins:\n  roots: [plugins]\n\ndomains:\n  all:\n    plugins: [${pluginNames.join(', ')}]\n`,
    );
    await Promise.all(
      packages.map((packageName, index) => writePlugin(root, pluginNames[index]!, `skill-${index}`, packageName)),
    );

    const { groups, inventory, mcpGroups } = await discoverServerSkills(execution(root), signal());
    const localSkills = groups.flatMap((group) => group.skills.map((skill) => skill.name));
    const remoteSkills = mcpGroups.flatMap((group) => group.skills.map((skill) => skill.name));

    expect(localSkills).toEqual(packages.map((_, index) => `skill-${index}`));
    expect(inventory.skills.map((skill) => skill.name)).toEqual(localSkills);
    expect(remoteSkills).toEqual(remotePackages.map((_, index) => `skill-${index + localOnlyPackages.length}`));
  });

  it('fails closed for a malformed package identity without removing its local skill', async () => {
    const root = await repository('plugins:\n  roots: [plugins]\n\ndomains:\n  local:\n    plugins: [broken]\n');
    await writePlugin(root, 'broken', 'broken-skill');
    await writeFile(path.join(root, 'plugins', 'broken', 'package.json'), '{"name":');

    const { groups, mcpGroups } = await discoverServerSkills(execution(root), signal());

    expect(groups.flatMap((group) => group.skills.map((skill) => skill.name))).toEqual(['broken-skill']);
    expect(mcpGroups.flatMap((group) => group.skills)).toEqual([]);
  });

  it('retains each domain skill subset when another domain loads the whole plugin', async () => {
    const root = await repository(
      [
        'plugins:',
        '  roots: [plugins]',
        'domains:',
        '  narrow:',
        '    plugins:',
        '      - name: toolkit',
        '        skills: [selected]',
        '  broad:',
        '    plugins: [toolkit]',
        '',
      ].join('\n'),
    );
    await writePlugin(root, 'toolkit', 'selected', '@example/toolkit');
    await writeSkill(path.join(root, 'plugins', 'toolkit', 'skills', 'other'), 'other');

    const { groups, inventory, mcpGroups } = await discoverServerSkills(execution(root), signal());

    expect(groups.find((group) => group.domain === 'narrow')?.skills.map((skill) => skill.name)).toEqual(['selected']);
    expect(mcpGroups.find((group) => group.domain === 'narrow')?.skills.map((skill) => skill.name)).toEqual([
      'selected',
    ]);
    expect(mcpGroups.find((group) => group.domain === 'broad')?.skills.map((skill) => skill.name)).toEqual([
      'other',
      'selected',
    ]);
    expect(inventory.skills.map((skill) => skill.name)).toEqual(['other', 'selected']);
  });
});
