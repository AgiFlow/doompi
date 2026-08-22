import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_STATE_KEYS } from '@agimon-ai/doompi-config/harnessState';
import {
  createHarnessSession,
  disposeHarnessState,
  getHarnessState,
  resetHarnessStore,
} from '@agimon-ai/doompi-config/harnessStore';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDomains } from '../../src/adapters/applyDomains.ts';
import { activeDomainSkillPaths } from '../../src/adapters/pi/extension.ts';
import { DISPATCHER_AGENT_NAME } from '../../src/adapters/resourceCollector.ts';
import { harnessContext } from '../helpers/session.ts';

const SELECTED_DOMAIN = 'resource-test';
const SELECTED_SKILL = 'selected-skill';
const SELECTED_AGENT = 'selected-agent';
const SELECTED_SERVER = 'selected-server';

describe('live domain resource switching', () => {
  let root: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-switch-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;

    const plugin = path.join(root, 'plugins', 'selected');
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'skills', SELECTED_SKILL), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'run'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      `plugins:\n  entries:\n    selected: plugins/selected\ndomains:\n  ${SELECTED_DOMAIN}:\n    plugins: [selected]\n    sharedSkills: false\n`,
    );
    fs.writeFileSync(
      path.join(plugin, 'skills', SELECTED_SKILL, 'SKILL.md'),
      `---\nname: ${SELECTED_SKILL}\ndescription: Selected after a domain switch.\n---\n\nSelected skill body.\n`,
    );
    fs.writeFileSync(
      path.join(plugin, 'agents', `${SELECTED_AGENT}.md`),
      `---\nname: ${SELECTED_AGENT}\ntools: Read\n---\n\nSelected agent body.\n`,
    );
    fs.writeFileSync(
      path.join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'selected-hook' }] }] } }),
    );
    fs.writeFileSync(
      path.join(plugin, '.mcp.json'),
      JSON.stringify({ mcpServers: { [SELECTED_SERVER]: { command: 'selected-server-command' } } }),
    );

    const state = harnessContext(root, {
      temporaryDirectory: path.join(root, 'run'),
      domains: ['previous'],
      skillDirectories: ['/previous/SKILL.md'],
      agentDirectories: ['/previous/agents'],
    });
    createHarnessSession(state as HarnessState, { directory: path.join(root, 'state'), environment: process.env });
  });

  afterEach(() => {
    disposeHarnessState();
    resetHarnessStore();
    for (const key of Object.values(HARNESS_STATE_KEYS)) delete process.env[key];
    delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    delete process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('replaces skills, agents, and hooks and publishes the selected plugin MCP projection', async () => {
    const updated = await applyDomains([SELECTED_DOMAIN], getHarnessState());
    const plugin = path.join(root, 'plugins', 'selected');
    const canonicalPlugin = fs.realpathSync(plugin);
    const skillPath = path.join(plugin, 'skills', SELECTED_SKILL, 'SKILL.md');

    expect(updated.domains).toEqual([SELECTED_DOMAIN]);
    expect(activeDomainSkillPaths()).toEqual([skillPath]);
    const loadedSkills = loadSkills({
      cwd: root,
      agentDir: path.join(home, '.pi', 'agent'),
      skillPaths: activeDomainSkillPaths(),
      includeDefaults: false,
    });
    expect(loadedSkills.skills.map((skill) => skill.name)).toEqual([SELECTED_SKILL]);
    expect(loadedSkills.diagnostics).toEqual([]);

    expect(updated.agentDirectories).toHaveLength(1);
    const agentDirectory = updated.agentDirectories[0]!;
    expect(fs.readdirSync(agentDirectory).sort()).toEqual([`${DISPATCHER_AGENT_NAME}.md`, `${SELECTED_AGENT}.md`]);
    expect(fs.readFileSync(path.join(agentDirectory, `${SELECTED_AGENT}.md`), 'utf8')).toContain(
      'Selected agent body.',
    );
    expect(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS).toBe(agentDirectory);
    expect(process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS).toBe(skillPath);

    expect(updated.pluginHooks).toEqual([{ pluginRoot: plugin, configPath: path.join(plugin, 'hooks', 'hooks.json') }]);

    expect(updated.mcpProjection).toMatchObject({
      enabled: true,
      repoRoot: root,
      sources: [expect.objectContaining({ owner: 'plugin', configPath: path.join(canonicalPlugin, '.mcp.json') })],
    });
    expect(updated.mcpConfigPath).toBeTruthy();
    const emittedMcp = JSON.parse(fs.readFileSync(updated.mcpConfigPath!, 'utf8')) as {
      mcpServers: Record<string, { command?: string }>;
    };
    expect(emittedMcp.mcpServers).toEqual({
      [SELECTED_SERVER]: expect.objectContaining({ command: 'selected-server-command' }),
    });
    expect(getHarnessState()).toMatchObject({
      domains: [SELECTED_DOMAIN],
      skillDirectories: [skillPath],
      agentDirectories: [agentDirectory],
      pluginHooks: updated.pluginHooks,
      mcpConfigPath: updated.mcpConfigPath,
      mcpProjection: updated.mcpProjection,
    });
  });
});
