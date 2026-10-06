import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
  DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import mcp from '../../generated/mcp';
import { facet as skillHeadlessFacet } from '../../generated/server';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('skill headless facet', () => {
  it('contributes nothing when a session agent is unavailable', async () => {
    const close = await skillHeadlessFacet.apply({
      effect() {},
      get: (name: string) => (name === 'doom/server-host' ? { scope: 'session' } : undefined),
    } as unknown as Context);

    await close?.();
  });

  it('lists discovered skills and invokes a requested skill', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'doompi-skill-headless-'));
    temporaryDirectories.push(cwd);
    const skillDirectory = path.join(cwd, '.doom', 'skills', 'example');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: example\ndescription: Example skill\n---\n# Example skill\n',
    );

    const resources: DoomHeadlessResource[] = [];
    const commands = new Map<string, DoomHeadlessCommand>();
    let command: DoomHeadlessCommand | undefined;
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const registration = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const tools: DoomHeadlessTool[] = [];
    const host = {
      context: { cwd, repoRoot: cwd, environment: {} },
      readSkill: (name: string) => (name === 'example' ? '# Example skill' : undefined),
      registerTool: (tool: DoomHeadlessTool) => {
        tools.push(tool);
        return registration();
      },
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return registration();
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        commands.set(registered.name, registered);
        if (registered.name === 'skills') command = registered;
        return registration();
      },
    } as unknown as DoomHeadlessHostService;
    const services = new Context();
    services.provide('doom/server-host', { scope: 'session' });
    services.provide('doom/headless-host', host);
    const close = await skillHeadlessFacet.apply(services);
    if (!command) throw new Error('Skill command was not registered');
    const notify = vi.fn();
    const prompt = vi.fn();
    // Admission, not `prompt`: the command's return is the composer's ack, and `prompt` awaits the turn.
    const admitPrompt = vi.fn();
    const execution = {
      cwd,
      client: { notify },
      session: { prompt, admitPrompt },
    } as unknown as DoomHeadlessExecutionContext;

    // A repository skill is its own prompt entry, with the path the agent reads it from.
    expect(resources.some(({ name }) => name === 'doompi/skills')).toBe(false);
    const listed = resources.find(({ name }) => name === 'example');
    if (!listed) throw new Error('Repository skill resource was not registered');
    expect(listed).toMatchObject({ kind: 'skill', path: expect.stringContaining('SKILL.md') });
    expect(listed.when).toBeUndefined();
    expect(await listed.read(execution)).toContain('Example skill');

    // The session agent loads a listed skill by name through its own tool.
    const load = tools.find(({ name }) => name === 'load_skill');
    if (!load) throw new Error('load_skill was not registered');
    await expect(load.execute('call-1', { name: 'example' }, undefined, undefined, execution)).resolves.toMatchObject({
      content: [{ type: 'text', text: '# Example skill' }],
    });
    await expect(load.execute('call-2', { name: 'missing' }, undefined, undefined, execution)).resolves.toMatchObject({
      isError: true,
    });

    await command.execute('', execution);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'DoomPi skills', body: expect.stringContaining('Example skill') }),
    );
    await command.execute('example', execution);
    expect(admitPrompt).toHaveBeenCalledWith(expect.stringContaining('<skill name="example"'), 'prompt', 'operator');
    expect(admitPrompt).toHaveBeenCalledWith(expect.stringContaining('# Example skill'), 'prompt', 'operator');
    const namedSkill = commands.get('skill:example');
    if (!namedSkill) throw new Error('Named skill command was not registered');
    await namedSkill.execute('', execution);
    await namedSkill.execute('extra context', execution);
    expect(admitPrompt).toHaveBeenCalledWith(expect.stringContaining('extra context'), 'prompt', 'operator');
    expect(prompt).not.toHaveBeenCalled();
    const noAdmission = { ...execution, session: { prompt } } as unknown as DoomHeadlessExecutionContext;
    await expect(namedSkill.execute('', noAdmission)).rejects.toThrow('cannot admit a skill prompt');
    // Repository skills belong to the repository, so no selection gates them.
    expect(namedSkill.when).toBeUndefined();

    await close?.();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('gates a domain plugin skill on that domain so a selection switch reconciles it', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'doompi-skill-domains-'));
    temporaryDirectories.push(cwd);
    const pluginSkill = path.join(cwd, 'plugins', 'writing', 'skills', 'outline');
    await mkdir(pluginSkill, { recursive: true });
    await writeFile(path.join(pluginSkill, 'SKILL.md'), '---\nname: outline\ndescription: Outline\n---\n# Outline\n');
    // Root discovery only registers a directory that declares itself a plugin.
    await mkdir(path.join(cwd, 'plugins', 'writing', '.claude-plugin'), { recursive: true });
    await writeFile(
      path.join(cwd, 'plugins', 'writing', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'writing', version: '0.1.0', description: 'Writing' }),
    );
    await mkdir(path.join(cwd, '.doom'), { recursive: true });
    await writeFile(
      path.join(cwd, '.doom', 'domains.yaml'),
      'plugins:\n  roots: [plugins]\n\ndomains:\n  writing:\n    plugins: [writing]\n',
    );

    const commands = new Map<string, DoomHeadlessCommand>();
    const host = {
      context: { cwd, repoRoot: cwd, environment: { HOME: cwd } },
      registerResource: () => ({ dispose: vi.fn() }),
      registerTool: () => ({ dispose: vi.fn() }),
      registerCommand: (registered: DoomHeadlessCommand) => {
        commands.set(registered.name, registered);
        return { dispose: vi.fn() };
      },
    } as unknown as DoomHeadlessHostService;
    const services = new Context();
    services.provide('doom/server-host', { scope: 'session' });
    services.provide('doom/headless-host', host);
    const close = await skillHeadlessFacet.apply(services);

    // The facet mounts once, so the command has to carry the condition rather
    // than be rebuilt: this is what lets a cockpit /domains switch add and
    // remove it without restarting the session.
    expect(commands.get('skill:outline')?.when).toEqual({ domain: 'writing' });
    const createRemote = mcp.session;
    if (typeof createRemote !== 'function') throw new Error('Expected MCP session factory');
    const remote = (domains: readonly string[]) =>
      createRemote({
        execution: host.context,
        services,
        selection: { read: () => ({ majorMode: 'default', activeLayers: [], domains }), change: async () => {} },
        signal: new AbortController().signal,
        refresh: () => {},
        loadContext: () => {
          throw new Error('Not used by this test.');
        },
      });
    expect((await remote([])).skills?.map((skill) => skill.name)).not.toContain('outline');
    const skills = (await remote(['writing'])).skills!;
    expect(skills.map((skill) => skill.name)).toContain('outline');
    expect(skills.map((skill) => skill.name)).toContain('doompi-use-skill');
    const outline = skills.find((skill) => skill.name === 'outline')!;
    expect(await outline.read(host.context)).toContain('# Outline');

    await close?.();
    await expect(outline.read(host.context)).rejects.toThrow();
  });
});
