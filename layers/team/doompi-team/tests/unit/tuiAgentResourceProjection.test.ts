import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiscoveredSkill,
  SkillDiscoveryContract,
  ResolvedSkill,
  SkillResolution,
} from '../../src/adapters/agents/skills';
import type { AgentConfig } from '../../src/adapters/agents/types';
import { DOOMPI_CHILD_EXTENSIONS_ENV } from '../../src/exports/env';
import type { ResolvedSubagentCapabilityCeiling } from '../../src/schemas/team/capabilityCeiling';
import {
  buildAgentCatalogEntries,
  projectAgentResources,
  type AgentResourceProjectionContext,
} from '../../src/adapters/pi/tui/agentResourceProjection';

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: false,
    systemPrompt: `You are ${name}.`,
    source: 'plugin',
    filePath: `/agents/${name}.md`,
    ...overrides,
  };
}

function resolvedSkill(name: string): ResolvedSkill {
  return {
    name,
    path: `/skills/${name}/SKILL.md`,
    content: `# ${name}`,
    description: `${name} description`,
    source: 'project',
  };
}

function skillService(
  resolution: SkillResolution = { resolved: [], missing: [] },
  available: DiscoveredSkill[] = [],
): AgentResourceProjectionContext['skills'] {
  return {
    resolveSkillsWithFallback: vi.fn(() => resolution),
    discoverAvailableSkills: vi.fn(() => available),
  } satisfies Pick<SkillDiscoveryContract, 'resolveSkillsWithFallback' | 'discoverAvailableSkills'>;
}

function ceiling(overrides: Partial<ResolvedSubagentCapabilityCeiling> = {}): ResolvedSubagentCapabilityCeiling {
  return {
    version: 2,
    allowedTools: ['read'],
    allowedExternalProfiles: [],
    denyExtensions: false,
    sources: ['plan-mode'],
    ...overrides,
  };
}

function context(overrides: Partial<AgentResourceProjectionContext> = {}): AgentResourceProjectionContext {
  return {
    cwd: '/workspace',
    skills: skillService(),
    environment: {},
    ...overrides,
  };
}

function names(items: readonly { name: string }[]): string[] {
  return items.map((item) => item.name);
}

describe('agentResourceProjection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows effective tools and separates Team package and ceiling removals', () => {
    const resources = projectAgentResources(
      agent('worker', { tools: ['read', 'write', 'bash'] }),
      context({
        capabilityCeiling: ceiling({ allowedTools: ['read', 'write'] }),
        excludeTools: ['write'],
        exclusionSource: '/workspace/.doom/modes.yaml',
      }),
    );

    expect(names(resources.tools.effective)).toEqual(['read']);
    expect(resources.tools.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'write', detail: expect.stringContaining('Team package policy') }),
        expect.objectContaining({ name: 'bash', detail: expect.stringContaining('plan-mode') }),
      ]),
    );
  });

  it('distinguishes unresolved host defaults from an explicit empty tool policy', () => {
    const hostDefaults = projectAgentResources(agent('ambient'), context());
    const noTools = projectAgentResources(agent('empty', { tools: [] }), context());

    expect(names(hostDefaults.tools.unresolved)).toContain('Pi host-default tool set');
    expect(names(noTools.tools.unresolved)).not.toContain('Pi host-default tool set');
    expect(noTools.tools.effective).toEqual([]);
  });

  it('projects the parent ceiling as the effective allowlist when the agent leaves tools undefined', () => {
    const resources = projectAgentResources(
      agent('ceiling-defaults'),
      context({ capabilityCeiling: ceiling({ allowedTools: ['read', 'grep'] }) }),
    );

    expect(names(resources.tools.effective)).toEqual(['grep', 'read']);
    expect(resources.tools.effective).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'read', detail: expect.stringContaining('parent capability ceiling') }),
      ]),
    );
    expect(names(resources.tools.unresolved)).not.toContain('Pi host-default tool set');
  });

  it('projects explicit and parent-visible ambient skills without treating the snapshot as runtime proof', () => {
    const packageSkill = resolvedSkill('package-development');
    const resources = projectAgentResources(
      agent('package-dev', { tools: ['read'], inheritSkills: true, skills: [packageSkill.name] }),
      context({
        skills: skillService({ resolved: [packageSkill], missing: [] }, [
          { name: packageSkill.name, source: 'project' },
          { name: 'ambient-docs', source: 'extension' },
        ]),
      }),
    );

    expect(names(resources.skills.effective)).toEqual([packageSkill.name, 'ambient-docs']);
    expect(names(resources.skills.unresolved)).toContain('Ambient Pi skills');
  });

  it('keeps explicit skills when ambient inheritance is disabled and reports missing names', () => {
    const packageSkill = resolvedSkill('package-development');
    const resources = projectAgentResources(
      agent('package-dev', {
        tools: ['read'],
        inheritSkills: false,
        skills: [packageSkill.name, 'missing-skill'],
      }),
      context({
        skills: skillService({ resolved: [packageSkill], missing: ['missing-skill'] }, [
          { name: 'ambient-docs', source: 'extension' },
        ]),
      }),
    );

    expect(names(resources.skills.effective)).toEqual([packageSkill.name]);
    expect(resources.skills.unresolved).toContainEqual(
      expect.objectContaining({ name: 'missing-skill', detail: expect.stringContaining('not found') }),
    );
  });

  it('keeps inherited guardrails while showing configured extensions and MCP selectors removed by the ceiling', () => {
    const resources = projectAgentResources(
      agent('guarded', {
        tools: ['read', '/agent/tool.ts'],
        mcpDirectTools: ['search'],
        extensions: ['/agent/standard.ts'],
        subagentOnlyExtensions: ['/agent/child.ts'],
      }),
      context({
        capabilityCeiling: ceiling({ denyExtensions: true }),
        environment: {
          [DOOMPI_CHILD_EXTENSIONS_ENV]: JSON.stringify(['/doom/guardrails.mjs']),
        },
      }),
    );

    expect(names(resources.extensions.effective)).toContain('/doom/guardrails.mjs');
    expect(names(resources.extensions.removed)).toEqual(
      expect.arrayContaining(['/agent/tool.ts', '/agent/standard.ts', '/agent/child.ts']),
    );
    expect(resources.tools.removed).toContainEqual(
      expect.objectContaining({ name: 'search', detail: expect.stringContaining('MCP extensions denied') }),
    );
  });

  it('qualifies MCP selectors that do not resolve from the current parent catalog', () => {
    const resources = projectAgentResources(
      agent('mcp-agent', { tools: ['read'], mcpDirectTools: ['missing-server'] }),
      context(),
    );

    expect(resources.tools.unresolved).toContainEqual(
      expect.objectContaining({ name: 'missing-server', detail: expect.stringContaining('did not resolve') }),
    );
  });

  it('turns a required read rejection into an inspectable per-agent projection error', () => {
    const packageSkill = resolvedSkill('package-development');
    const resources = projectAgentResources(
      agent('invalid', { tools: ['grep'], skills: [packageSkill.name] }),
      context({
        skills: skillService({ resolved: [packageSkill], missing: [] }),
        capabilityCeiling: ceiling({ allowedTools: ['grep'] }),
      }),
    );

    expect(resources.error).toContain("excludes required tool 'read'");
    expect(resources.notice).toContain('failed');
  });

  it('uses a configured-only projection for external runtimes', () => {
    const resources = projectAgentResources(
      agent('external', {
        runtime: 'claude',
        tools: ['read'],
        skills: ['docs'],
        extensions: ['/agent/extension.ts'],
      }),
      context(),
    );
    const runtimeDefaults = projectAgentResources(
      agent('external-defaults', { runtime: 'codex', inheritSkills: true }),
      context(),
    );

    expect(resources.configuredOnly).toBe(true);
    expect(names(resources.tools.unresolved)).toContain('read');
    expect(names(resources.skills.unresolved)).toContain('docs');
    expect(names(resources.extensions.unresolved)).toContain('/agent/extension.ts');
    expect(names(runtimeDefaults.tools.unresolved)).toContain('Runtime-default tools');
    expect(names(runtimeDefaults.skills.unresolved)).toContain('Ambient Pi skills');
    expect(names(runtimeDefaults.extensions.unresolved)).toContain('Ambient Pi extensions');
  });

  it('builds one immutable display entry per discovered agent', () => {
    const entries = buildAgentCatalogEntries([agent('zeta'), agent('alpha', { tools: [] })], context());

    expect(entries.map((entry) => entry.agent.name)).toEqual(['zeta', 'alpha']);
    expect(entries[0]?.resources).not.toBe(entries[1]?.resources);
  });
});
