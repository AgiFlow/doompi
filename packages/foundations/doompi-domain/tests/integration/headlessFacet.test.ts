import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { facet as domainHeadlessFacet } from '../../generated/server';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup(withSkill = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-headless-'));
  roots.push(root);
  const home = path.join(root, 'home');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(root, '.doom'));
  fs.writeFileSync(
    path.join(root, '.doom/domains.yaml'),
    JSON.stringify({ domains: { default: { description: 'Default' }, web: { description: 'Web' } } }),
  );
  if (withSkill) {
    const plugin = path.join(root, 'plugins', 'web');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'skills', 'web-guide'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'web', skills: './skills/' }),
    );
    fs.writeFileSync(
      path.join(plugin, 'skills/web-guide/SKILL.md'),
      '---\nname: web-guide\ndescription: Web guide\n---\n# Web guidance',
    );
    fs.writeFileSync(
      path.join(root, '.doom/domains.yaml'),
      JSON.stringify({
        plugins: { roots: ['plugins'] },
        domains: { default: {}, web: { plugins: ['web'] } },
      }),
    );
  }
  const commands: DoomHeadlessCommand[] = [];
  const resources: DoomHeadlessResource[] = [];
  const disposed = vi.fn();
  const changeSelection = vi.fn(async () => undefined);
  const host = {
    context: { repoRoot: root, environment: { HOME: home } },
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return { dispose: disposed };
    },
    registerCommand: (command: DoomHeadlessCommand) => {
      commands.push(command);
      return { dispose: disposed };
    },
    changeSelection,
  } as unknown as DoomHeadlessHostService;
  const dispose = await domainHeadlessFacet.apply({
    effect() {},
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? { scope: 'session' } : host),
  } as unknown as Context);
  const execution: DoomHeadlessExecutionContext = {
    cwd: root,
    repoRoot: root,
    sessionId: 'test',
    environment: {},
    selection: { majorMode: 'development', activeLayers: [], domains: ['default'], state: {} },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    shutdown: vi.fn(),
  };
  return { changeSelection, command: commands[0]!, execution, resources, dispose, disposed };
}

describe('headless domains command', () => {
  it('loads configured plugin skill content and gates it on its domain', async () => {
    const { resources, execution } = await setup(true);
    const skill = resources.find((resource) => resource.name === 'web-guide');
    expect(skill?.when).toEqual({ domain: 'web', attribution: { kind: 'domain', mode: 'web' } });
    expect(await skill?.read(execution)).toContain('# Web guidance');
  });
  it('opens a typed toggle picker and applies the resulting domain set', async () => {
    const { changeSelection, command, execution } = await setup();
    vi.mocked(execution.client.request).mockResolvedValue('[ ] web');
    await command.execute('', execution);
    expect(execution.client.request).toHaveBeenCalledExactlyOnceWith({
      kind: 'select',
      title: 'Domains (active: default)',
      options: [
        { label: '[x] default', value: '[x] default' },
        { label: '[ ] web', value: '[ ] web' },
      ],
    });
    expect(changeSelection).toHaveBeenCalledExactlyOnceWith({ axis: 'domains', domains: ['default', 'web'] });
  });

  it.each([undefined, false, ''])('does not transition when the picker is cancelled: %s', async (answer) => {
    const { changeSelection, command, execution } = await setup();
    vi.mocked(execution.client.request).mockResolvedValue(answer);
    await command.execute('', execution);
    expect(changeSelection).not.toHaveBeenCalled();
  });

  it('validates requested and picker domain names before selecting', async () => {
    const { changeSelection, command, execution } = await setup();
    await expect(command.execute('foreign', execution)).rejects.toThrow('Unknown domain: foreign');
    vi.mocked(execution.client.request).mockResolvedValue('[ ] foreign');
    await expect(command.execute('', execution)).rejects.toThrow('Unknown domain: foreign');
    expect(changeSelection).not.toHaveBeenCalled();
  });

  it('skips an unchanged explicit selection and propagates selection failures', async () => {
    const { changeSelection, command, execution } = await setup();
    await command.execute('default', execution);
    expect(changeSelection).not.toHaveBeenCalled();
    changeSelection.mockRejectedValueOnce(new Error('Selection was not applied'));
    await expect(command.execute('web', execution)).rejects.toThrow('Selection was not applied');
  });

  it('exposes only its authoring skill, and no domain blob, then disposes every contribution', async () => {
    const { resources, execution, dispose, disposed } = await setup();
    // doompi/domain-config is gone: `domains` is already carried by doompi/config.
    expect(resources.map((resource) => resource.name)).toEqual(['doompi-author-domain']);
    expect(await resources[0]!.read(execution)).toContain('doompi-author-domain');
    await dispose?.();
    expect(disposed).toHaveBeenCalledTimes(2);
  });
});
