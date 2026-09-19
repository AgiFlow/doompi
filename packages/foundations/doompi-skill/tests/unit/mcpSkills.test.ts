import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it } from 'vitest';

import discovered from '../../src/extensions/workspaces/sessions/(backend)/skill/discovered.mcp';
import { bindMcpSkills, mountMcpSkills } from '../../src/services/mcpSkills';
import { discoverServerSkills } from '../../src/services/serverInventory';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function remote(services: Context, domains: readonly string[], signal = new AbortController().signal) {
  return {
    services,
    signal,
    execution: {} as unknown as DoomHeadlessExecutionContext,
    selection: { read: () => ({ majorMode: 'default', activeLayers: [], domains }), change: async () => {} },
  } satisfies DoomMcpPluginContext;
}

it('requires an explicit provider rather than falling back to local resources', () => {
  expect(() => bindMcpSkills(remote(new Context(), []))).toThrow('Discovered MCP skills are unavailable');
});

it('exposes repository and selected domain skills, deduplicates shared skills, and reads lazily', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doompi-mcp-skills-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.doom'), { recursive: true });
  await writeFile(
    path.join(root, '.doom/domains.yaml'),
    'domains:\n  writing: {}\n  code: {}\n  lean:\n    sharedSkills: false\n',
  );
  for (const [directory, name] of [
    ['.doom/skills/repo', 'repo'],
    ['.claude/skills/shared', 'shared'],
  ]) {
    await mkdir(path.join(root, directory!), { recursive: true });
    await writeFile(
      path.join(root, directory!, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`,
    );
  }
  const lifetime = new AbortController();
  const { groups } = await discoverServerSkills(
    { cwd: root, repoRoot: root, environment: { HOME: root } } as unknown as DoomHeadlessExecutionContext,
    lifetime.signal,
  );
  const services = new Context();
  mountMcpSkills(groups, lifetime.signal)(services);
  const selected = new AbortController();
  const context = remote(services, ['writing', 'code'], selected.signal);
  const skills = discovered(context);
  expect(skills.map((skill) => skill.name)).toEqual(['shared', 'repo']);
  expect(bindMcpSkills(remote(services, ['lean'])).map((skill) => skill.name)).toEqual(['repo']);
  expect(bindMcpSkills(remote(services, [])).map((skill) => skill.name)).toEqual(['repo']);

  const file = path.join(root, '.doom/skills/repo/SKILL.md');
  await writeFile(file, '# Updated content');
  expect(await skills[1]!.read(context.execution)).toBe('# Updated content');
  await rm(file);
  await expect(skills[1]!.read(context.execution)).rejects.toThrow();
  selected.abort();
  await expect(skills[0]!.read(context.execution)).rejects.toThrow();
  expect(() => bindMcpSkills(context)).toThrow();

  const fresh = bindMcpSkills(remote(services, ['writing']));
  lifetime.abort();
  await expect(fresh[0]!.read(context.execution)).rejects.toThrow();
  expect(() => bindMcpSkills(remote(services, ['writing']))).toThrow();
});
