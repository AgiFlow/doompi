import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileHeadlessFacet } from '../../src/adapters/headless/facet.ts';

const roots: string[] = [];
const SECRET = 'synthetic-headless-profile-secret';

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-profile-headless-'));
  roots.push(root);
  return root;
}

function execution(repoRoot: string, profile: string): DoomHeadlessExecutionContext {
  return {
    cwd: path.join(repoRoot, 'different-working-directory'),
    repoRoot,
    sessionId: 'headless-profile-test',
    environment: {},
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    selection: {
      majorMode: 'copilot',
      activeLayers: [],
      domains: [],
      minorModes: [],
      profile,
    },
    shutdown: vi.fn(),
  };
}

function profileSetup() {
  const commands: DoomHeadlessCommand[] = [];
  const hooks: DoomHeadlessHook<'session_start'>[] = [];
  const resources: DoomHeadlessResource[] = [];
  const changeSelection = vi.fn(async () => undefined);
  const disposed = vi.fn();
  const host = {
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return { dispose: disposed };
    },
    registerCommand: (command: DoomHeadlessCommand) => {
      commands.push(command);
      return { dispose: disposed };
    },
    registerHook: (hook: DoomHeadlessHook) => {
      if (hook.event === 'session_start') hooks.push(hook as DoomHeadlessHook<'session_start'>);
      return { dispose: disposed };
    },
    changeSelection,
  } as unknown as DoomHeadlessHostService;
  const dispose = profileHeadlessFacet.apply({ get: () => host } as unknown as Context);
  return { changeSelection, command: commands[0]!, dispose, disposed, hook: hooks[0]!, resources };
}

function profileResource(): DoomHeadlessResource {
  const resource = profileSetup().resources.find(({ name }) => name === 'doompi/profile-config');
  if (!resource) throw new Error('profile headless resource was not registered');
  return resource;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('profile headless resource', () => {
  it('reads only the selected persona, re-reads its source, and never exposes profile env', async () => {
    const root = temporaryRoot();
    const personaDirectory = path.join(root, 'agents', 'writer', 'mara');
    fs.mkdirSync(personaDirectory, { recursive: true });
    fs.writeFileSync(path.join(personaDirectory, 'profile.md'), '# Mara, first version');
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'profiles.yaml'),
      `profiles:\n  entries:\n    writer:\n      persona: agents/writer/mara\n      env:\n        API_TOKEN: ${SECRET}\n`,
    );

    const resource = profileResource();
    const first = await resource.read(execution(root, 'writer'));
    expect(first).toContain('# Mara, first version');
    expect(first).not.toContain(SECRET);

    fs.writeFileSync(path.join(personaDirectory, 'profile.md'), '# Mara, reloaded');
    const second = await resource.read(execution(root, 'writer'));
    expect(second).toContain('# Mara, reloaded');
    expect(second).not.toContain(SECRET);
  });

  it('rejects an unknown selected profile', async () => {
    const root = temporaryRoot();
    const resource = profileResource();

    await expect(resource.read(execution(root, 'missing'))).rejects.toThrow('Unknown profile: missing');
  });
});

describe('headless profile command', () => {
  function configuredExecution() {
    const root = temporaryRoot();
    const personaDirectory = path.join(root, 'agents', 'writer', 'mara');
    fs.mkdirSync(personaDirectory, { recursive: true });
    fs.writeFileSync(path.join(personaDirectory, 'profile.md'), '# Mara');
    fs.mkdirSync(path.join(root, 'agents', 'reviewer', 'reed'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'reviewer', 'reed', 'profile.md'), '# Reed');
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'profiles.yaml'),
      'profiles:\n  entries:\n    writer:\n      persona: agents/writer/mara\n      env: {}\n    reviewer:\n      persona: agents/reviewer/reed\n      env: {}\n',
    );
    return execution(root, 'writer');
  }

  it('opens a typed picker and applies the selected configured profile', async () => {
    const { changeSelection, command } = profileSetup();
    const context = configuredExecution();
    vi.mocked(context.client.request).mockResolvedValue('reviewer');
    await command.execute('', context);
    expect(context.client.request).toHaveBeenCalledExactlyOnceWith({
      kind: 'select',
      title: 'Profile (current: writer)',
      options: [
        { label: 'reviewer', value: 'reviewer', description: 'agents/reviewer/reed' },
        { label: 'writer', value: 'writer', description: 'agents/writer/mara' },
      ],
    });
    expect(changeSelection).toHaveBeenCalledExactlyOnceWith({ axis: 'profile', profile: 'reviewer' });
    expect(context.session.appendCustomEntry).toHaveBeenCalledWith('doom-profile-identity', {
      profile: 'reviewer',
    });
  });

  it('publishes the selected identity when the headless session starts', async () => {
    const { hook } = profileSetup();
    const context = configuredExecution();
    await hook.handle({}, context);
    expect(context.session.appendCustomEntry).toHaveBeenCalledWith('doom-profile-identity', {
      profile: 'writer',
    });
  });

  it.each([undefined, false, '', 'writer'])(
    'does not transition for cancellation or the current profile: %s',
    async (answer) => {
      const { changeSelection, command } = profileSetup();
      const context = configuredExecution();
      vi.mocked(context.client.request).mockResolvedValue(answer);
      await command.execute('', context);
      expect(changeSelection).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown values and propagates selection failures', async () => {
    const { changeSelection, command } = profileSetup();
    const context = configuredExecution();
    await expect(command.execute('missing', context)).rejects.toThrow('Unknown profile: missing');
    vi.mocked(context.client.request).mockResolvedValue('missing');
    await expect(command.execute('', context)).rejects.toThrow('Unknown profile: missing');
    expect(changeSelection).not.toHaveBeenCalled();
    vi.mocked(context.client.request).mockResolvedValue('reviewer');
    changeSelection.mockRejectedValueOnce(new Error('Selection was not applied'));
    await expect(command.execute('', context)).rejects.toThrow('Selection was not applied');
  });
});
