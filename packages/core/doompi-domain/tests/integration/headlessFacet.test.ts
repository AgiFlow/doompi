import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainServerFacet as domainHeadlessFacet } from '../../src/extensions/server';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-domain-headless-'));
  roots.push(root);
  const home = path.join(root, 'home');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(root, '.doom'));
  fs.writeFileSync(
    path.join(root, '.doom/domains.yaml'),
    JSON.stringify({ domains: { default: { description: 'Default' }, web: { description: 'Web' } } }),
  );
  const commands: DoomHeadlessCommand[] = [];
  const resources: DoomHeadlessResource[] = [];
  const disposed = vi.fn();
  const changeSelection = vi.fn(async () => undefined);
  const host = {
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
    selection: { majorMode: 'development', activeLayers: [], domains: ['default'], minorModes: [] },
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

  it('projects domain metadata, reads its skill, and disposes every contribution', async () => {
    const { resources, execution, dispose, disposed } = await setup();
    const texts = await Promise.all(resources.map((resource) => Promise.resolve(resource.read(execution))));
    expect(JSON.parse(texts[0]!)).toEqual({ domains: ['default'] });
    expect(texts[1]).toContain('doompi-author-domain');
    await dispose?.();
    expect(disposed).toHaveBeenCalledTimes(3);
  });
});
