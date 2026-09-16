import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { facet as majorModeHeadlessFacet } from '../../generated/server';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-major-headless-'));
  roots.push(root);
  const home = path.join(root, 'home');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(root, '.doom'));
  fs.writeFileSync(
    path.join(root, '.doom/modes.yaml'),
    JSON.stringify({
      majorMode: {
        development: { description: 'Develop', layers: [] },
        review: { description: 'Review', layers: [] },
      },
    }),
  );
  const cwd = path.join(root, 'nested');
  fs.mkdirSync(path.join(cwd, '.doom'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.doom/modes.yaml'), JSON.stringify({ majorMode: { foreign: [] } }));
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
  const dispose = await majorModeHeadlessFacet.apply({
    effect() {},
    get: (name: string) => (name === 'doom/server-host' ? { scope: 'session', context: {} } : host),
  } as unknown as Context);
  const execution: DoomHeadlessExecutionContext = {
    cwd,
    repoRoot: root,
    sessionId: 'test',
    environment: {},
    selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
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

describe('headless major-mode command validation', () => {
  it('exposes only its authoring skill, and no selection blobs, then disposes every contribution', async () => {
    const { resources, execution, dispose, disposed } = await setup();
    // doompi/modes-config and doompi/model are gone. majorMode and activeLayers are
    // already in doompi/config, and the model does not need telling its own id.
    expect(resources.map((resource) => resource.name)).toEqual(['doompi-author-major-mode']);
    const authoring = resources[0]!;
    expect(await authoring.read(execution)).toContain('doompi-author-major-mode');
    await dispose?.();
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown modes from the admitted repository before requesting a transition', async () => {
    const { changeSelection, command, execution } = await setup();
    await expect(command.execute('foreign', execution)).rejects.toThrow('Unknown major mode');
    expect(changeSelection).not.toHaveBeenCalled();
    await command.execute(' review ', execution);
    expect(changeSelection).toHaveBeenCalledExactlyOnceWith({ axis: 'majorMode', majorMode: 'review' });
  });

  it('opens a typed picker using the admitted repository and applies the selected value', async () => {
    const { changeSelection, command, execution } = await setup();
    vi.mocked(execution.client.request).mockResolvedValue('review');
    await command.execute(' ', execution);
    expect(execution.client.request).toHaveBeenCalledExactlyOnceWith({
      kind: 'select',
      title: 'Major mode (current: development)',
      options: [
        { label: '[x] development: core only', value: 'development' },
        { label: '[ ] review: core only', value: 'review' },
      ],
    });
    expect(changeSelection).toHaveBeenCalledExactlyOnceWith({ axis: 'majorMode', majorMode: 'review' });
  });

  it.each([undefined, false, '', 'development'])(
    'does not transition for cancellation or the current mode: %s',
    async (answer) => {
      const { changeSelection, command, execution } = await setup();
      vi.mocked(execution.client.request).mockResolvedValue(answer);
      await command.execute('', execution);
      expect(changeSelection).not.toHaveBeenCalled();
    },
  );

  it('validates picker responses and propagates transition failures', async () => {
    const { changeSelection, command, execution } = await setup();
    vi.mocked(execution.client.request).mockResolvedValue('foreign');
    await expect(command.execute('', execution)).rejects.toThrow('Unknown major mode');
    expect(changeSelection).not.toHaveBeenCalled();
    vi.mocked(execution.client.request).mockResolvedValue('review');
    changeSelection.mockRejectedValueOnce(new Error('Selection was not applied'));
    await expect(command.execute('', execution)).rejects.toThrow('Selection was not applied');
  });
});
