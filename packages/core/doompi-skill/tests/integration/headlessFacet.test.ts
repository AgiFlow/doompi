import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessHostService,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillHeadlessFacet } from '../../src/adapters/headless/facet.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('skill headless facet', () => {
  it('lists discovered skills and invokes a requested skill', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'doompi-skill-headless-'));
    temporaryDirectories.push(cwd);
    const skillDirectory = path.join(cwd, '.doom', 'skills', 'example');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), '# Example skill\n');

    const resources: DoomHeadlessResource[] = [];
    let command: DoomHeadlessCommand | undefined;
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const registration = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return registration();
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return registration();
      },
    } as unknown as DoomHeadlessHostService;
    const close = skillHeadlessFacet.apply({ get: () => host } as unknown as Context);
    if (!command) throw new Error('Skill command was not registered');
    const notify = vi.fn();
    const prompt = vi.fn();
    const execution = { cwd, client: { notify }, session: { prompt } } as unknown as DoomHeadlessExecutionContext;

    const catalog = resources.find(({ name }) => name === 'doompi/skills');
    if (!catalog) throw new Error('Skill catalog resource was not registered');
    expect(await catalog.read(execution)).toContain('# Example skill');

    await command.execute('', execution);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'DoomPi skills', body: expect.stringContaining('# Example skill') }),
    );
    await command.execute('example', execution);
    expect(prompt).toHaveBeenCalledWith('/skill:example');

    close();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
