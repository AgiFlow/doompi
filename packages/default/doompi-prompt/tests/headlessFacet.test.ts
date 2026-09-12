import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-core/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptServerFacet as promptHeadlessFacet } from '../src/extensions/server';

const roots: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function contextFor(host: DoomHeadlessHostService): Context {
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session', registerApi: () => ({ dispose() {} }) });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  return context;
}

describe('prompt headless facet', () => {
  it('lists saved prompts, handles missing names, and runs a named prompt', async () => {
    const agentDirectory = await mkdtemp(path.join(tmpdir(), 'doompi-prompt-headless-'));
    roots.push(agentDirectory);
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    const resources: DoomHeadlessResource[] = [];
    let command: DoomHeadlessCommand | undefined;
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const register = () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { dispose };
    };
    const host = {
      registerResource: (resource: DoomHeadlessResource) => {
        resources.push(resource);
        return register();
      },
      registerCommand: (registered: DoomHeadlessCommand) => {
        command = registered;
        return register();
      },
    } as unknown as DoomHeadlessHostService;
    const close = await promptHeadlessFacet.apply(contextFor(host));
    if (!command) throw new Error('Prompt command was not registered');
    const execution = {
      cwd: agentDirectory,
      client: { notify: vi.fn() },
      session: { prompt: vi.fn() },
    } as unknown as DoomHeadlessExecutionContext;
    const prompts = resources.find(({ name }) => name === 'doompi/prompts');
    const skill = resources.find(({ name }) => name === 'doompi-use-prompt');
    if (!prompts || !skill) throw new Error('Prompt resources were not registered');

    expect(await prompts.read(execution)).toBe('[]');
    await command.execute('', execution);
    expect(execution.client.notify).toHaveBeenCalledWith({
      title: 'DoomPi prompts',
      body: '(no saved prompts)',
      level: 'info',
    });

    await mkdir(path.join(agentDirectory, 'prompts'), { recursive: true });
    await writeFile(
      path.join(agentDirectory, 'prompts', 'ship.md'),
      '---\ndescription: Ship the feature\n---\nShip the feature now\n',
    );
    const listed = JSON.parse(await prompts.read(execution)) as Array<{
      name: string;
      text: string;
      description: string;
    }>;
    expect(listed).toEqual([{ name: 'ship', description: 'Ship the feature', text: 'Ship the feature now' }]);
    expect(await skill.read(execution)).toContain('prompt');

    await command.execute('missing', execution);
    expect(execution.client.notify).toHaveBeenCalledWith({ body: 'Saved prompt not found: missing', level: 'warning' });
    await command.execute('ship', execution);
    expect(execution.session.prompt).toHaveBeenCalledWith('Ship the feature now');
    expect(await readFile(path.join(agentDirectory, 'prompts', 'ship.md'), 'utf8')).toContain('Ship the feature now');

    await close?.();
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
