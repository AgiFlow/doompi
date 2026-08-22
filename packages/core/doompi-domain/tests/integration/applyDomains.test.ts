import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_STATE_KEYS } from '@agimon-ai/doompi-config/harnessState';
import { resetHarnessStore } from '@agimon-ai/doompi-config/harnessStore';
import type { DoomHarnessContext } from '@agimon-ai/doompi-config/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDomains } from '../../src/adapters/applyDomains.ts';

const collectResources = vi.hoisted(() => vi.fn());
const resolveMcpAllowlist = vi.hoisted(() => vi.fn(() => ({ servers: ['figma'] })));

vi.mock('@agimon-ai/doompi-config/domains', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/doompi-config/domains')>()),
  resolvePluginEntries: vi.fn(() => []),
  resolveSharedSkills: vi.fn(() => false),
}));
vi.mock('../../src/adapters/mcpFilter.ts', () => ({ resolveMcpAllowlist }));
vi.mock('../../src/adapters/pluginMaterializer.ts', () => ({
  materializePluginEntries: vi.fn(async () => []),
}));
vi.mock('../../src/adapters/resourceCollector.ts', () => ({ collectResources }));

let state: DoomHarnessContext;

beforeEach(() => {
  state = {
    root: '/repo',
    majorMode: 'copilot',
    temporaryDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-apply-')),
    domains: ['engineering'],
    layers: [],
    profileEnvironment: {},
    skillDirectories: [],
    agentDirectories: [],
    additionalDirectories: [],
    childExtensions: [],
    pluginDirectories: [],
    pluginHooks: [],
    allowProtectedWrites: false,
    hooks: true,
    agents: true,
    mcp: true,
  };
});

afterEach(() => {
  for (const key of Object.values(HARNESS_STATE_KEYS)) delete process.env[key];
  delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  delete process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS;
  resetHarnessStore();
  vi.clearAllMocks();
  if (state.temporaryDirectory) fs.rmSync(state.temporaryDirectory, { recursive: true, force: true });
});

describe('applyDomains', () => {
  it('refreshes the generated path and complete live-session projection together', async () => {
    collectResources.mockResolvedValue({
      temporaryDirectory: '/run/session',
      skillDirectories: ['/run/session/skills'],
      skillCount: 1,
      agentCount: 0,
      agentDirectories: ['/run/session/agents'],
      pluginHooks: [],
      mcpConfigPath: '/run/session/mcp.json',
      mcpProjection: {
        version: 1,
        enabled: true,
        fingerprint: 'projection-design',
        repoRoot: '/repo',
        stagingDirectory: '/run/session',
        generatedConfigPath: '/run/session/mcp.json',
        sources: [],
        allowlist: { servers: ['figma'] },
      },
      pluginMcpSources: [],
      pluginMcpConfigPaths: ['/repo/plugins/design/.mcp.json'],
      cleanup: vi.fn(async () => undefined),
    });

    const updated = await applyDomains(['design'], state);

    expect(updated.domains).toEqual(['design']);
    expect(updated.skillDirectories).toEqual(['/run/session/skills']);
    expect(updated.agentDirectories).toEqual(['/run/session/agents']);
    expect(process.env[HARNESS_STATE_KEYS.mcpConfigPath]).toBe('/run/session/mcp.json');
    expect(updated.mcpProjection?.fingerprint).toBe('projection-design');
    // Subagents inherit the same selection through the environment, since they
    // are launched as child processes rather than from this session's state.
    expect(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS).toBe('/run/session/agents');
    expect(process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS).toBe('/run/session/skills');
  });

  it('keeps the layer-owned MCP factory but clears server projection when disabled', async () => {
    collectResources.mockResolvedValue({
      temporaryDirectory: '/run/session',
      skillDirectories: [],
      skillCount: 0,
      agentCount: 0,
      agentDirectories: [],
      pluginHooks: [],
      mcpProjection: {
        version: 1,
        enabled: false,
        fingerprint: 'disabled',
        repoRoot: '/repo',
        stagingDirectory: '/run/session',
        sources: [],
      },
      pluginMcpSources: [],
      pluginMcpConfigPaths: [],
      cleanup: vi.fn(async () => undefined),
    });

    const updated = await applyDomains(['design'], { ...state, mcp: false });

    expect(collectResources).toHaveBeenCalledWith('/repo', [], expect.objectContaining({ mcp: false }));
    expect(updated.mcpProjection?.enabled).toBe(false);
  });

  it('stages a candidate generation without overwriting the active one', async () => {
    collectResources.mockResolvedValue({
      temporaryDirectory: '/run/session',
      skillDirectories: [],
      skillCount: 0,
      agentCount: 0,
      agentDirectories: [],
      pluginHooks: [],
      mcpProjection: {
        version: 1,
        enabled: true,
        fingerprint: 'empty',
        repoRoot: '/repo',
        stagingDirectory: '/run/session',
        sources: [],
      },
      pluginMcpSources: [],
      pluginMcpConfigPaths: [],
      cleanup: vi.fn(async () => undefined),
    });

    await applyDomains([], state);

    const options = collectResources.mock.calls[0]?.[2] as { temporaryDirectory: string; sharedSkills: boolean };
    expect(options.sharedSkills).toBe(false);
    expect(path.dirname(options.temporaryDirectory)).toBe(state.temporaryDirectory);
    expect(path.basename(options.temporaryDirectory)).toMatch(/^domains-/);
  });

  it('refuses to stage without the harness paths a session must already have', async () => {
    await expect(applyDomains(['design'], { ...state, root: undefined })).rejects.toThrow();
  });

  it('removes a failed candidate without touching the active run directory', async () => {
    collectResources.mockRejectedValueOnce(new Error('invalid candidate'));

    await expect(applyDomains(['design'], state)).rejects.toThrow('invalid candidate');

    expect(fs.readdirSync(state.temporaryDirectory!)).toEqual([]);
  });
});
