import { readFile } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { helpHeadlessFacet } from '../../src/adapters/headless/facet.ts';

describe('help headless facet', () => {
  it('reads help resources and sends them through the help command', async () => {
    const resources: DoomHeadlessResource[] = [];
    let command: DoomHeadlessCommand | undefined;
    const dispose = vi.fn();
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return { dispose };
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return { dispose };
      },
    } as unknown as DoomHeadlessHostService;
    const close = helpHeadlessFacet.apply({ get: () => host } as unknown as Context);
    if (!command) throw new Error('Help command was not registered');
    const execution = {
      client: { notify: vi.fn() },
    } as unknown as DoomHeadlessExecutionContext;

    const help = resources.find(({ name }) => name === 'doompi-help');
    const skill = resources.find(({ name }) => name === 'doompi-use-help');
    if (!help || !skill) throw new Error('Help resources were not registered');
    expect(await help.read(execution)).toBe(await readFile(new URL('../../llms.txt', import.meta.url), 'utf8'));
    expect(await skill.read(execution)).toContain('help');

    await command.execute('', execution);
    expect(execution.client.notify).toHaveBeenCalledWith({
      title: 'DoomPi help',
      body: await help.read(execution),
      level: 'info',
    });

    close();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
