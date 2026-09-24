import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DOOM_HEADLESS_OWNER, requireDoomHeadlessHost } from '@agimon-ai/doompi-core/headless';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '@agimon-ai/doompi-core/headlessSessionHost';
import { DOOM_HELP_WHEN as HELP_WHEN } from '@agimon-ai/doompi-core/help';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerBundleEntry } from '@agimon-ai/doompi-core/serverFacet';
import { facet as minorModeFacet } from '@agimon-ai/doompi-minor-mode/extensions/server';
import { Context } from '@deepseek-ai/cordis';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { facet as helpServerFacet } from '../../generated/server';
import { HELP_GUIDANCE } from '../../src/constants/help';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  // Exercise the built host without exporting a production construction API solely for tests.
  const hostModule = (await import(
    new URL('../../../../core/doompi-core/dist/src/systems/main/adapters/headlessSessionHost.mjs', import.meta.url).href
  )) as { createHeadlessSessionHost(options: HeadlessSessionHostOptions): Promise<HeadlessSessionHost> };
  const directHarnessRuntime = (await import(
    new URL('../../../../core/doompi-core/dist/src/server/directHarnessRuntime.mjs', import.meta.url).href
  )) as { createDirectHarnessRuntime(options: { systemPrompt?: () => Promise<string> }): Promise<unknown> };
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'doom-help-headless-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const model = {
    id: 'test',
    name: 'Test',
    provider: 'test',
    api: 'openai-completions',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    contextWindow: 65536,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'test', defaultModel: 'test' }),
  );
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  vi.spyOn(ModelRuntime, 'create').mockResolvedValue({
    getModel: () => model,
    getModels: () => [model],
    getAvailable: async () => [model],
  } as unknown as ModelRuntime);
  const candidates: DoomServerBundleEntry[] = [
    '@agimon-ai/doompi-help',
    '@agimon-ai/doompi-minor-mode',
    '@fixture/help-contributor',
  ].map((packageName) => ({
    packageName,
    entry: './server.ts',
    module: './server.mjs',
    scopes: ['session'],
    required: true,
    owners: [{ majorMode: 'test', layer: 'default' }],
  }));
  const createRuntime = vi.spyOn(directHarnessRuntime, 'createDirectHarnessRuntime');
  const context = new Context();
  const current = await hostModule.createHeadlessSessionHost({
    cwd,
    repoRoot: cwd,
    sessionId: 'help-integration',
    sessionName: 'Help integration',
    agentArgs: [],
    environment: { HOME: cwd },
    candidates,
    piExtensions: false,
    selection: { majorMode: 'test', activeLayers: [], domains: [], state: { 'minor-mode': ['plan'] } },
  });
  cleanup.push(async () => {
    await current.dispose();
    await context.fiber.dispose();
  });
  current.prepareFacets(context);
  context.provide(DOOM_SERVER_HOST_SERVICE, {
    scope: 'session',
    context: {},
    registerApi: () => ({ dispose() {} }),
  } as never);
  const minorOwner = context.extend({ [DOOM_HEADLESS_OWNER]: candidates[1]! });
  const helpOwner = context.extend({ [DOOM_HEADLESS_OWNER]: candidates[0]! });
  const closeMinor = await minorModeFacet.apply(minorOwner);
  const closeHelp = await helpServerFacet.apply(helpOwner);
  const skillPath = path.join(cwd, 'SKILL.md');
  await writeFile(skillPath, '---\nname: fixture-help\ndescription: Diagnose the fixture\n---\n# Fixture help\n');
  const owner = context.extend({ [DOOM_HEADLESS_OWNER]: candidates[2]! });
  const contributor = owner.plugin((child) => {
    const host = requireDoomHeadlessHost(child);
    host.registerTool({
      name: 'read',
      description: 'Ordinary read',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'ordinary' }] }),
    });
    host.registerTool({
      name: 'fixture_diagnostic',
      description: 'Inspect fixture',
      parameters: Type.Object({}),
      when: HELP_WHEN,
      execute: async () => ({ content: [{ type: 'text', text: 'inspected' }] }),
    });
    host.registerResource({
      name: 'fixture-help',
      description: 'Diagnose the fixture',
      kind: 'skill',
      path: skillPath,
      when: HELP_WHEN,
      read: () => '# Fixture help',
    });
  });
  await contributor.await();
  vi.spyOn(current.runtime, 'resume').mockResolvedValue(false);
  await current.activateFacets({
    root: context,
    installedPackages: candidates.map((entry) => entry.packageName),
    dispose: async () => {
      await closeHelp?.();
      await closeMinor?.();
    },
  });
  const prompt = createRuntime.mock.calls.at(-1)![0].systemPrompt as () => Promise<string>;
  return { current, contributor, owner, skillPath, prompt };
}

describe('Help on the real headless host', () => {
  it('uses the same toggle path, advertises readable skills, and applies and withdraws contributed tools', async () => {
    const { current, contributor, skillPath, prompt } = await fixture();
    const host = current.host!;
    const names = () =>
      current.toolSurface
        .readSurface()
        .tools.map((tool) => tool.name)
        .sort();
    expect(names()).toEqual(['read']);
    expect(host.inspectCapabilities().capabilities.find((entry) => entry.name === 'help_status')).toMatchObject({
      active: false,
      reason: 'inactive',
    });
    await host.dispatchCommand('minor', 'help');
    expect(host.context.selection.state?.['minor-mode']).toEqual(['plan', 'help']);
    expect(names()).toEqual(['fixture_diagnostic', 'help_status', 'read']);
    const snapshot = current.toolSurface.readSurface();
    const status = await current.toolSurface.invokeTool({
      revision: snapshot.revision,
      name: 'help_status',
      arguments: {},
    });
    expect(status.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"skills": 2') });
    const inventory = host.inspectCapabilities();
    expect(inventory.capabilities.find((entry) => entry.name === 'doompi-use-help')).toMatchObject({
      active: true,
      discoverable: true,
    });
    expect(host.appliedResources.find((resource) => resource.name === 'doompi-help')?.text).toBe(HELP_GUIDANCE);
    expect(host.appliedResources.find((resource) => resource.name === 'fixture-help')?.path).toBe(skillPath);
    const actualPrompt = await prompt();
    expect(actualPrompt).toContain(HELP_GUIDANCE);
    expect(actualPrompt).toContain('<available_skills>');
    expect(actualPrompt).toContain('doompi-use-help');
    expect(actualPrompt).toContain(skillPath);
    const helpSkill = snapshot.skills.find((skill) => skill.name === 'doompi-use-help')!;
    expect(await current.toolSurface.readSkill(snapshot.revision, helpSkill.uri)).toContain('# Use Doom Pi Help');
    expect(current.mcpSurface.readSurface().tools.some((tool) => tool.name === 'help_status')).toBe(false);

    await host.dispatchCommand('doom-help', '');
    expect(host.context.selection.state?.['minor-mode']).toEqual(['plan']);
    expect(names()).toEqual(['read']);
    await expect(
      current.toolSurface.invokeTool({ revision: snapshot.revision, name: 'fixture_diagnostic', arguments: {} }),
    ).rejects.toThrow();
    expect(current.toolSurface.readSurface().skills.some((skill) => skill.name === 'doompi-use-help')).toBe(false);
    expect(await prompt()).not.toContain('doompi-use-help');

    await host.dispatchCommand('doom-help', '');
    await contributor.dispose();
    await host.select({});
    expect(names()).toEqual(['help_status']);
    expect(host.inspectCapabilities().capabilities.some((entry) => entry.source === '@fixture/help-contributor')).toBe(
      false,
    );
  });
  it('reconciles late contributors and isolates missing resources without exposing their content', async () => {
    const { current, owner, prompt } = await fixture();
    const host = current.host!;
    await host.dispatchCommand('doom-help', '');
    const skillPath = path.join(host.context.cwd, 'late-help.md');
    await writeFile(skillPath, '---\nname: late-help\ndescription: Diagnose late arrivals\n---\n# Late help\n');
    const late = owner.plugin((child) => {
      const agent = requireDoomHeadlessHost(child);
      agent.registerResource({
        name: 'late-help',
        description: 'Diagnose late arrivals',
        kind: 'skill',
        path: skillPath,
        when: HELP_WHEN,
        read: () => '# Late help',
      });
      agent.registerResource({
        name: 'broken-help',
        description: 'Unavailable fixture guidance',
        kind: 'skill',
        when: HELP_WHEN,
        read: () => {
          throw new Error('fixture-sensitive-error');
        },
      });
    });
    await late.await();
    await host.select({});
    const surface = current.toolSurface.readSurface();
    const result = await current.toolSurface.invokeTool({
      revision: surface.revision,
      name: 'help_status',
      arguments: {},
    });
    const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    expect(JSON.parse(text)).toMatchObject({
      activation: 'degraded',
      counts: { skills: 3, tools: 2 },
      diagnostics: [{ source: '@fixture/help-contributor', code: 'HELP_UNAVAILABLE' }],
    });
    expect(text).not.toContain('fixture-sensitive-error');
    expect(await prompt()).toContain(skillPath);
    expect(await prompt()).not.toContain('broken-help');
    await late.dispose();
    await host.select({});
    expect(host.inspectCapabilities().capabilities.some((entry) => entry.name === 'late-help')).toBe(false);
    expect(await prompt()).not.toContain(skillPath);
    expect(current.toolSurface.readSurface().tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['help_status', 'fixture_diagnostic', 'read']),
    );
  });
});
