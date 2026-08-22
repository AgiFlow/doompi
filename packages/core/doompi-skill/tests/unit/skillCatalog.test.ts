import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillCatalog, findSkill, type SkillCatalog } from '../../src/adapters/skillCatalog.ts';

function writeSkill(directory: string, name: string, description: string, body = 'Body.'): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

function group(catalog: SkillCatalog, key: string) {
  return catalog.groups.find((entry) => entry.key === key);
}

describe('buildSkillCatalog', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      [
        'plugins:',
        '  entries:',
        '    development: plugins/development',
        '    outreach: plugins/outreach',
        'domains:',
        '  default:',
        '    plugins: [development]',
        '  marketing:',
        '    plugins: [outreach]',
        '',
      ].join('\n'),
    );
    writeSkill(path.join(root, 'plugins', 'development', 'skills', 'backend'), 'backend', 'Build APIs.');
    writeSkill(path.join(root, 'plugins', 'development', 'skills', 'frontend'), 'frontend', 'Build UIs.');
    writeSkill(path.join(root, 'plugins', 'outreach', 'skills', 'cold-email'), 'cold-email', 'Send email.');
    writeSkill(path.join(root, '.claude', 'skills', 'git-commit'), 'git-commit', 'Commit changes.');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build(
    activeSkillDirectories: string[],
    extensionSources: Array<{ source: string; directories: string[] }> = [],
    helpSkills: Skill[] = [],
  ): Promise<SkillCatalog> {
    return buildSkillCatalog({ repoRoot: root, activeSkillDirectories, extensionSources, helpSkills });
  }

  function helpSkill(name: string, source: string): Skill {
    const directory = path.join(root, 'generated-help', source, name);
    writeSkill(directory, name, `${name} package guidance.`);
    const filePath = path.join(directory, 'SKILL.md');
    return {
      name,
      description: `${name} package guidance.`,
      filePath,
      baseDir: directory,
      sourceInfo: createSyntheticSourceInfo(filePath, { source, scope: 'temporary', origin: 'package' }),
      disableModelInvocation: false,
    };
  }

  it('groups by extensions, Help, plugins and default in that order', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills')]);
    expect(catalog.groups.map((entry) => entry.key)).toEqual(['extensions', 'help', 'plugins', 'default']);
  });

  it('lists the selected plugin and drops the unselected one entirely', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills')]);
    const plugins = group(catalog, 'plugins');

    expect(plugins?.owners.map((owner) => owner.owner)).toEqual(['development']);
    expect(plugins?.owners[0]?.skills.map((skill) => skill.name)).toEqual(['backend', 'frontend']);
  });

  it('sorts owners alphabetically', async () => {
    const catalog = await build([
      path.join(root, 'plugins', 'outreach', 'skills'),
      path.join(root, 'plugins', 'development', 'skills'),
    ]);
    expect(group(catalog, 'plugins')?.owners.map((owner) => owner.owner)).toEqual(['development', 'outreach']);
  });

  it('keeps only the listed skills when a domain takes a plugin subset', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills', 'backend')]);
    const development = group(catalog, 'plugins')?.owners.find((owner) => owner.owner === 'development');
    expect(development?.skills.map((skill) => skill.name)).toEqual(['backend']);
  });

  it('reads .claude/skills as the default group', async () => {
    const catalog = await build([path.join(root, '.claude', 'skills')]);
    const owners = group(catalog, 'default')?.owners;
    expect(owners?.map((owner) => owner.owner)).toEqual(['.claude/skills']);
    expect(owners?.[0]?.skills[0]).toMatchObject({ name: 'git-commit', group: 'default' });
  });

  it('drops the default group when the selection left shared skills out', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills')]);
    expect(group(catalog, 'default')?.owners).toEqual([]);
  });

  it('treats registered extension directories as always loaded', async () => {
    writeSkill(path.join(root, 'ext', 'skills', 'recovery'), 'workflow-recovery', 'Recover a run.');
    const catalog = await build(
      [],
      [{ source: '@agimon-ai/doompi-workflow', directories: [path.join(root, 'ext', 'skills')] }],
    );
    const owners = group(catalog, 'extensions')?.owners;
    expect(owners?.[0]?.owner).toBe('@agimon-ai/doompi-workflow');
    expect(owners?.[0]?.skills[0]).toMatchObject({ name: 'workflow-recovery' });
  });

  it('lists active wrappers in a distinct Help group by package source', async () => {
    const catalog = await build(
      [],
      [],
      [helpSkill('workflow-help', '@agimon-ai/doompi-workflow'), helpSkill('doompi-help', '@agimon-ai/doompi-help')],
    );
    const help = group(catalog, 'help');

    expect(help?.label).toBe('Help');
    expect(help?.owners.map((owner) => owner.owner)).toEqual(['@agimon-ai/doompi-help', '@agimon-ai/doompi-workflow']);
    expect(catalog.skillCount).toBe(2);
  });

  it('keeps a normal catalog skill when an active Help name collides', async () => {
    const catalog = await build(
      [path.join(root, '.claude', 'skills')],
      [],
      [helpSkill('git-commit', '@agimon-ai/doompi-help')],
    );

    expect(group(catalog, 'help')?.owners).toEqual([]);
    expect(findSkill(catalog, 'git-commit')).toMatchObject({ group: 'default', owner: '.claude/skills' });
    expect(catalog.diagnostics).toEqual([expect.stringContaining('HELP_SKILL_COLLISION')]);
  });

  it('counts only the loaded skills', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills')]);
    expect(catalog.skillCount).toBe(2);
  });

  it('prices the loaded skills in prompt and body tokens', async () => {
    const catalog = await build([path.join(root, 'plugins', 'development', 'skills')]);

    expect(catalog.promptTokens).toBeGreaterThan(0);
    expect(catalog.bodyTokens).toBeGreaterThan(0);
  });

  it('charges nothing to the prompt block for a skill the model cannot invoke', async () => {
    const manual = path.join(root, 'plugins', 'development', 'skills', 'manual');
    fs.mkdirSync(manual, { recursive: true });
    fs.writeFileSync(
      path.join(manual, 'SKILL.md'),
      '---\nname: manual\ndescription: Run by hand.\ndisable-model-invocation: true\n---\n\nBody.\n',
    );

    const catalog = await build([manual]);
    expect(catalog.skillCount).toBe(1);
    expect(catalog.promptTokens).toBe(0);
    // The body still costs whatever it costs once someone reads it.
    expect(catalog.bodyTokens).toBeGreaterThan(0);
  });

  it('charges nothing at all when nothing is loaded', async () => {
    const catalog = await build([]);
    expect(catalog.skillCount).toBe(0);
    expect(catalog.promptTokens).toBe(0);
    expect(catalog.bodyTokens).toBe(0);
  });

  it('reports a malformed SKILL.md as a diagnostic rather than throwing', async () => {
    const broken = path.join(root, 'plugins', 'development', 'skills', 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'SKILL.md'), 'no frontmatter here\n');

    const catalog = await build([]);
    expect(catalog.diagnostics.length).toBeGreaterThan(0);
    expect(catalog.diagnostics.join('\n')).toContain('broken');
  });

  it('finds a skill by name across groups', async () => {
    const catalog = await build([path.join(root, '.claude', 'skills')]);
    expect(findSkill(catalog, 'git-commit')?.owner).toBe('.claude/skills');
    expect(findSkill(catalog, 'absent')).toBeUndefined();
  });
});
