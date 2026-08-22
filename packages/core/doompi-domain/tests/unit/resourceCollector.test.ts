import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adaptAgentDefinition,
  collectResources,
  DISPATCHER_AGENT_NAME,
  discoverSkills,
  discoverSkillsAsync,
  mergeMcpConfigs,
  mergeMcpConfigsAsync,
} from '../../src/adapters/resourceCollector.ts';

describe('agent definition adaptation', () => {
  it('adapts Claude tools and preserves the agent prompt', () => {
    const result = adaptAgentDefinition(`---
name: worker
description: Works
tools: Read, Edit, Bash, Skill, WebFetch, mcp__posthog__query
permissionMode: default
---
Do the work.
`);

    expect(result.name).toBe('worker');
    expect(result.content).toContain('tools: read, edit, bash, mcp');
    expect(result.content).toContain('inheritProjectContext: true');
    expect(result.content).toContain('inheritSkills: true');
    expect(result.content).not.toContain('permissionMode');
    expect(result.content).toContain('Do the work.');
  });

  it('rejects malformed and unsupported agent definitions', () => {
    expect(() => adaptAgentDefinition('No frontmatter')).toThrow('missing YAML frontmatter');
    expect(() => adaptAgentDefinition('---\ntools: Read\n---\nWork')).toThrow('requires a name');
    expect(() => adaptAgentDefinition('---\nname: worker\ntools: Unknown\n---\nWork')).toThrow(
      'Unsupported agent tool',
    );
  });

  it('rejects traversal names and preserves explicit empty tools', () => {
    expect(() => adaptAgentDefinition('---\nname: ../escape\n---\n')).toThrow('Unsafe agent name');
    expect(() => adaptAgentDefinition('---\nname: a\\b\n---\n')).toThrow('Unsafe agent name');
    const result = adaptAgentDefinition(
      '---\nname: skill-only\ntools: [Skill]\nmemory: user\nfallbackModels: [sonnet, opus]\n---\nPrompt',
    );
    expect(result.content).toContain('tools: []');
    expect(result.content).toContain('scope: user');
    expect(result.content).toContain('path: skill-only');
    expect(result.content).toContain('anthropic/claude-sonnet-4-6');
    expect(result.content).toContain('anthropic/claude-opus-4-6');

    const withoutTools = adaptAgentDefinition('---\nname: default-tools\nmodel: haiku\n---\nPrompt');
    expect(withoutTools.content).not.toMatch(/^tools:/m);
    expect(withoutTools.content).toContain('anthropic/claude-haiku-4-5');
    expect(withoutTools.content).toContain('inheritProjectContext: true');
  });

  it('keeps an object memory declaration and refuses any other shape', () => {
    expect(adaptAgentDefinition('---\nname: a\nmemory:\n  scope: project\n  path: custom\n---\n').content).toContain(
      'path: custom',
    );
    expect(() => adaptAgentDefinition('---\nname: a\nmemory: [project]\n---\n')).toThrow(
      'Unsupported memory declaration',
    );
  });
});

describe('MCP config merging', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-resources-merge-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('merges distinct MCP servers and rejects conflicting names', () => {
    const first = path.join(root, 'first.json');
    const second = path.join(root, 'second.json');
    fs.writeFileSync(first, JSON.stringify({ mcpServers: { docs: { url: 'https://docs.test' } } }));
    fs.writeFileSync(second, JSON.stringify({ mcpServers: { data: { command: 'data' } } }));

    expect(mergeMcpConfigs([first, second])).toEqual({
      mcpServers: {
        docs: { url: 'https://docs.test' },
        data: { command: 'data' },
      },
    });

    fs.writeFileSync(second, JSON.stringify({ mcpServers: { docs: { url: 'https://other.test' } } }));
    expect(() => mergeMcpConfigs([first, second])).toThrow('Conflicting MCP server "docs"');
  });

  it('skips absent layers and repeats the conflict rule asynchronously', async () => {
    const first = path.join(root, 'first.json');
    const missing = path.join(root, 'missing.json');
    fs.writeFileSync(first, JSON.stringify({ mcpServers: { docs: { url: 'https://docs.test' } } }));

    expect(mergeMcpConfigs([missing])).toEqual({ mcpServers: {} });
    await expect(mergeMcpConfigsAsync([first, missing])).resolves.toEqual({
      mcpServers: { docs: { url: 'https://docs.test' } },
    });

    const second = path.join(root, 'second.json');
    fs.writeFileSync(second, JSON.stringify({ mcpServers: { docs: { url: 'https://other.test' } } }));
    await expect(mergeMcpConfigsAsync([first, second])).rejects.toThrow('Conflicting MCP server "docs"');
  });

  it('accepts a layer that declares no servers key', async () => {
    const bare = path.join(root, 'bare.json');
    fs.writeFileSync(bare, JSON.stringify({}));

    expect(mergeMcpConfigs([bare])).toEqual({ mcpServers: {} });
    await expect(mergeMcpConfigsAsync([bare])).resolves.toEqual({ mcpServers: {} });
  });
});

describe('skill discovery', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-resources-skills-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('caches skill metadata and invalidates the manifest when the tree changes', () => {
    const skills = path.join(root, '.claude', 'skills');
    const cacheDirectory = path.join(root, 'generated', 'cache', 'skills');
    const first = path.join(skills, 'first', 'SKILL.md');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, '---\nname: first\ndescription: First\n---\n');

    expect(discoverSkills(root, skills, 'recursive', cacheDirectory).map((skill) => skill.name)).toEqual(['first']);
    expect(fs.readdirSync(cacheDirectory)).toHaveLength(1);

    const second = path.join(skills, 'second', 'SKILL.md');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(second, '---\nname: second\ndescription: Second\n---\n');
    expect(discoverSkills(root, skills, 'recursive', cacheDirectory).map((skill) => skill.name)).toEqual([
      'first',
      'second',
    ]);

    fs.writeFileSync(first, '---\nname: renamed\ndescription: First\n---\n');
    expect(discoverSkills(root, skills, 'recursive', cacheDirectory).map((skill) => skill.name)).toEqual([
      'renamed',
      'second',
    ]);
  });

  it('reuses a written manifest asynchronously and reports an absent root as empty', async () => {
    const skills = path.join(root, 'plugin', 'skills');
    const cacheDirectory = path.join(root, 'cache');
    fs.mkdirSync(path.join(skills, 'one'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n');

    await expect(discoverSkillsAsync(root, skills, 'recursive', cacheDirectory)).resolves.toMatchObject([
      { name: 'one' },
    ]);
    // The second pass reads the manifest written by the first rather than
    // walking the tree again, which is the whole point of the cache.
    await expect(discoverSkillsAsync(root, skills, 'recursive', cacheDirectory)).resolves.toMatchObject([
      { name: 'one' },
    ]);
    await expect(discoverSkillsAsync(root, path.join(root, 'absent'), 'recursive', cacheDirectory)).resolves.toEqual(
      [],
    );
    expect(discoverSkills(root, path.join(root, 'absent'), 'recursive', cacheDirectory)).toEqual([]);
  });

  it('falls back to the home-scoped cache when the caller names none', () => {
    const home = path.join(root, 'home');
    const skills = path.join(root, 'skills');
    fs.mkdirSync(path.join(skills, 'one'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'one', 'SKILL.md'), '---\nname: one\ndescription: One\n---\n');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(discoverSkills(root, skills).map((skill) => skill.name)).toEqual(['one']);
      expect(fs.existsSync(path.join(home, '.pi', '.doom', 'sync'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('limits Agent Plugin skill discovery to direct child directories', () => {
    const skills = path.join(root, 'plugin', 'skills');
    const cacheDirectory = path.join(root, 'cache');
    const direct = path.join(skills, 'direct', 'SKILL.md');
    const nested = path.join(skills, 'group', 'nested', 'SKILL.md');
    const rootSkill = path.join(skills, 'SKILL.md');
    fs.mkdirSync(path.dirname(direct), { recursive: true });
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(direct, '---\nname: direct\ndescription: Direct\n---\n');
    fs.writeFileSync(nested, '---\nname: nested\ndescription: Nested\n---\n');
    fs.writeFileSync(rootSkill, '---\nname: root\ndescription: Root\n---\n');

    expect(discoverSkills(root, skills, 'direct-children', cacheDirectory).map((skill) => skill.name)).toEqual([
      'direct',
    ]);
    expect(discoverSkills(root, skills, 'recursive', cacheDirectory).map((skill) => skill.name)).toEqual([
      'direct',
      'nested',
      'root',
    ]);
  });

  it('refuses a skill whose frontmatter carries no name', () => {
    const skills = path.join(root, 'skills');
    fs.mkdirSync(path.join(skills, 'unnamed'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'unnamed', 'SKILL.md'), '---\ndescription: Nameless\n---\n');

    expect(() => discoverSkills(root, skills, 'recursive', path.join(root, 'cache'))).toThrow('requires a name');
  });
});

describe('collectResources', () => {
  let root: string;
  let cacheDirectory: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-resources-'));
    cacheDirectory = path.join(root, 'cache', 'skills');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('collects shared and plugin resources into private temporary files', async () => {
    const sharedSkills = path.join(root, '.claude', 'skills', 'shared');
    const plugin = path.join(root, 'plugins', 'development');
    fs.mkdirSync(sharedSkills, { recursive: true });
    fs.mkdirSync(path.join(plugin, 'skills', 'develop'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(sharedSkills, 'SKILL.md'), '---\nname: shared\ndescription: Shared\n---\n');
    fs.writeFileSync(path.join(plugin, 'skills', 'develop', 'SKILL.md'), '---\nname: develop\ndescription: Dev\n---\n');
    fs.writeFileSync(path.join(plugin, 'agents', 'worker.md'), '---\nname: worker\ntools: Read, Write\n---\nWork.');
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), '{}');
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { plugin: {} } }));
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const resources = await collectResources(root, [plugin], {
      agents: true,
      mcp: true,
      skillCacheDirectory: cacheDirectory,
    });
    try {
      const canonicalPlugin = fs.realpathSync(plugin);
      expect(resources.temporaryDirectory).toBeTruthy();
      expect(resources.skillDirectories).toEqual([
        path.join(plugin, 'skills', 'develop', 'SKILL.md'),
        path.join(root, '.claude', 'skills', 'shared', 'SKILL.md'),
      ]);
      expect(resources.skillCount).toBe(2);
      expect(resources.agentCount).toBe(1);
      expect(resources.pluginHooks).toEqual([
        { pluginRoot: plugin, configPath: path.join(plugin, 'hooks', 'hooks.json') },
      ]);
      expect(resources.pluginMcpConfigPaths).toEqual([path.join(canonicalPlugin, '.mcp.json')]);
      expect(resources.pluginMcpSources).toMatchObject([
        { owner: 'plugin', format: 'native', configPath: path.join(canonicalPlugin, '.mcp.json') },
      ]);
      expect(resources.mcpProjection).toMatchObject({ enabled: true, sources: expect.any(Array) });
      expect(resources.agentDirectories).toHaveLength(1);
      expect(fs.statSync(path.join(resources.agentDirectories[0]!, 'worker.md')).mode & 0o777).toBe(0o600);
      expect(resources.mcpConfigPath).toBeTruthy();
    } finally {
      await resources.cleanup();
    }
    expect(fs.existsSync(resources.agentDirectories[0]!)).toBe(false);
  });

  it('discovers schema-gated Agent Plugin mcp.json without mixing in legacy .mcp.json', async () => {
    const plugin = path.join(root, 'plugins', 'portable');
    const pluginDataRoot = path.join(root, 'plugin-data');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'portable' }),
    );
    fs.writeFileSync(
      path.join(plugin, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { portable: { type: 'stdio', command: 'portable-server' } },
      }),
    );
    fs.writeFileSync(
      path.join(plugin, '.mcp.json'),
      JSON.stringify({ mcpServers: { legacy: { command: 'legacy-server' } } }),
    );

    const resources = await collectResources(root, [plugin], {
      agents: false,
      mcp: true,
      sharedSkills: false,
      skillCacheDirectory: cacheDirectory,
      pluginDataRoot,
    });
    try {
      const canonicalPlugin = fs.realpathSync(plugin);
      expect(resources.pluginMcpConfigPaths).toEqual([path.join(canonicalPlugin, 'mcp.json')]);
      expect(resources.pluginMcpSources).toMatchObject([
        {
          owner: 'plugin',
          format: 'agent-plugin-v1',
          configPath: path.join(canonicalPlugin, 'mcp.json'),
          pluginRoot: canonicalPlugin,
          mcpSchemaUrl: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        },
      ]);
      const [source] = resources.pluginMcpSources;
      expect(source?.format).toBe('agent-plugin-v1');
      if (source?.format !== 'agent-plugin-v1') throw new Error('Expected an Agent Plugin MCP source');
      expect(source.pluginDataDirectory).toBe(path.join(pluginDataRoot, source.pluginId));
      const emitted = JSON.parse(fs.readFileSync(resources.mcpConfigPath!, 'utf8')) as {
        mcpServers: Record<string, { type?: string; cwd?: string; env?: Record<string, string> }>;
      };
      expect(Object.keys(emitted.mcpServers)).toEqual(['portable']);
      expect(emitted.mcpServers.portable).toMatchObject({
        type: 'stdio',
        cwd: canonicalPlugin,
        env: {
          PLUGIN_ROOT: canonicalPlugin,
          PLUGIN_DATA: fs.realpathSync(source.pluginDataDirectory),
        },
      });
    } finally {
      await resources.cleanup();
    }
  });

  it('isolates invalid Agent Plugin documents and server entries in the external config', async () => {
    const validPlugin = path.join(root, 'plugins', 'partially-valid');
    const invalidPlugin = path.join(root, 'plugins', 'invalid-document');
    const pluginDataRoot = path.join(root, 'plugin-data');
    for (const plugin of [validPlugin, invalidPlugin]) {
      fs.mkdirSync(plugin, { recursive: true });
      fs.writeFileSync(
        path.join(plugin, 'plugin.json'),
        JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' }),
      );
    }
    fs.writeFileSync(
      path.join(validPlugin, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          web: { type: 'streamable-http', url: 'https://mcp.example.test' },
          broken: { type: 'stdio', command: '../outside' },
        },
      }),
    );
    fs.writeFileSync(
      path.join(invalidPlugin, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/0.0.0/mcp.schema.json',
        mcpServers: { ignored: { type: 'stdio', command: 'ignored' } },
      }),
    );

    const resources = await collectResources(root, [validPlugin, invalidPlugin], {
      agents: false,
      mcp: true,
      sharedSkills: false,
      skillCacheDirectory: cacheDirectory,
      pluginDataRoot,
    });
    try {
      const emitted = JSON.parse(fs.readFileSync(resources.mcpConfigPath!, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(emitted.mcpServers).toEqual({
        web: { type: 'http', url: 'https://mcp.example.test' },
      });
      expect(resources.pluginMcpSources).toHaveLength(2);
    } finally {
      await resources.cleanup();
    }
  });

  it('uses selected plugin skills instead of same-name shared skills', async () => {
    const sharedSkill = path.join(root, '.claude', 'skills', 'review', 'SKILL.md');
    const plugin = path.join(root, 'plugins', 'development');
    const pluginSkill = path.join(plugin, 'skills', 'review', 'SKILL.md');
    fs.mkdirSync(path.dirname(sharedSkill), { recursive: true });
    fs.mkdirSync(path.dirname(pluginSkill), { recursive: true });
    fs.writeFileSync(sharedSkill, '---\nname: review\ndescription: Review with shared defaults.\n---\n\nShared.\n');
    fs.writeFileSync(pluginSkill, '---\nname: review\ndescription: Review this domain.\n---\n\nPlugin.\n');

    const resources = await collectResources(root, [plugin], {
      agents: false,
      mcp: false,
      skillCacheDirectory: cacheDirectory,
    });
    try {
      expect(resources.skillDirectories).toEqual([pluginSkill]);
      expect(resources.skillCount).toBe(1);

      const loaded = loadSkills({
        cwd: root,
        agentDir: path.join(root, '.pi-agent'),
        skillPaths: resources.skillDirectories,
        includeDefaults: false,
      });
      expect(loaded.skills.map((skill) => skill.filePath)).toEqual([pluginSkill]);
      expect(loaded.diagnostics).toEqual([]);
    } finally {
      await resources.cleanup();
    }
  });

  it('honours a plugin entry that subsets or opts out of what it contributes', async () => {
    const plugin = path.join(root, 'plugins', 'development');
    fs.mkdirSync(path.join(plugin, 'skills', 'keep'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'skills', 'drop'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'skills', 'keep', 'SKILL.md'), '---\nname: keep-me\ndescription: K\n---\n');
    fs.writeFileSync(path.join(plugin, 'skills', 'drop', 'SKILL.md'), '---\nname: other\ndescription: O\n---\n');
    fs.writeFileSync(path.join(plugin, 'agents', 'keep.md'), '---\nname: keeper\n---\nKeep.');
    fs.writeFileSync(path.join(plugin, 'agents', 'drop.md'), '---\nname: dropped\n---\nDrop.');
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), '{}');
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const resources = await collectResources(
      root,
      [{ directory: plugin, skills: ['keep-*'], agents: ['keeper'], hooks: false, mcp: false }],
      { agents: false, mcp: false, sharedSkills: false, skillCacheDirectory: cacheDirectory },
    );
    try {
      expect(resources.skillDirectories).toEqual([path.join(plugin, 'skills', 'keep', 'SKILL.md')]);
      expect(resources.agentCount).toBe(1);
      expect(resources.pluginHooks).toEqual([]);
      expect(resources.pluginMcpConfigPaths).toEqual([]);
      expect(resources.pluginMcpSources).toEqual([]);
      expect(resources.mcpProjection.enabled).toBe(false);
      expect(resources.agentDirectories).toEqual([]);
      expect(resources.mcpConfigPath).toBeUndefined();
    } finally {
      await resources.cleanup();
    }
  });

  it('refuses two different skills, agents, or the reserved dispatcher name', async () => {
    const first = path.join(root, 'plugins', 'first');
    const second = path.join(root, 'plugins', 'second');
    fs.mkdirSync(path.join(first, 'skills', 'a'), { recursive: true });
    fs.mkdirSync(path.join(second, 'skills', 'b'), { recursive: true });
    fs.writeFileSync(path.join(first, 'skills', 'a', 'SKILL.md'), '---\nname: same\ndescription: One\n---\n');
    fs.writeFileSync(path.join(second, 'skills', 'b', 'SKILL.md'), '---\nname: same\ndescription: Two\n---\n');

    await expect(
      collectResources(root, [first, second], { agents: false, mcp: false, skillCacheDirectory: cacheDirectory }),
    ).rejects.toThrow('Conflicting skill "same"');

    const reserved = path.join(root, 'plugins', 'reserved');
    fs.mkdirSync(path.join(reserved, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(reserved, 'agents', 'dispatcher.md'),
      `---\nname: ${DISPATCHER_AGENT_NAME}\n---\nReserved.`,
    );
    await expect(
      collectResources(root, [reserved], { agents: false, mcp: false, skillCacheDirectory: cacheDirectory }),
    ).rejects.toThrow(`Conflicting agent "${DISPATCHER_AGENT_NAME}"`);
  });

  it('lets the loop dispatcher inherit the selected child composition', async () => {
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });

    const resources = await collectResources(root, [], {
      agents: true,
      mcp: false,
      skillCacheDirectory: cacheDirectory,
    });
    try {
      const agentPath = path.join(resources.agentDirectories[0]!, `${DISPATCHER_AGENT_NAME}.md`);
      const agent = fs.readFileSync(agentPath, 'utf8');

      expect(agent).toContain(`name: ${DISPATCHER_AGENT_NAME}`);
      expect(agent).toContain('launch_workflow');
      expect(agent).not.toContain('workflow_runs');
      expect(agent).toContain('After dispatching, report and exit.');
      expect(agent).not.toContain('extensions:');
      expect(fs.statSync(agentPath).mode & 0o777).toBe(0o600);
    } finally {
      await resources.cleanup();
    }
  });

  it('can refresh resources in a stable temporary directory', async () => {
    const temporaryDirectory = path.join(root, 'tmp');
    const firstPlugin = path.join(root, 'plugins', 'first');
    const secondPlugin = path.join(root, 'plugins', 'second');
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(firstPlugin, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(secondPlugin, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    fs.writeFileSync(path.join(firstPlugin, 'agents', 'first.md'), '---\nname: first\ntools: Read\n---\nFirst.');
    fs.writeFileSync(path.join(secondPlugin, 'agents', 'second.md'), '---\nname: second\ntools: Read\n---\nSecond.');

    const options = { agents: true, mcp: true, temporaryDirectory, skillCacheDirectory: cacheDirectory };
    const first = await collectResources(root, [firstPlugin], options);
    const second = await collectResources(root, [secondPlugin], options);

    expect(first.temporaryDirectory).toBe(temporaryDirectory);
    expect(second.temporaryDirectory).toBe(temporaryDirectory);
    expect(first.mcpConfigPath).toBe(second.mcpConfigPath);
    expect(fs.existsSync(path.join(temporaryDirectory, 'agents', 'first.md'))).toBe(false);
    expect(fs.existsSync(path.join(temporaryDirectory, 'agents', 'second.md'))).toBe(true);

    // A caller-owned directory outlives the collection, so cleanup is a no-op.
    await second.cleanup();
    expect(fs.existsSync(temporaryDirectory)).toBe(true);
  });
});
