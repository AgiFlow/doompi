import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type DoomHeadlessExecutionContext,
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
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
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

function profileResource(): DoomHeadlessResource {
  const resources: DoomHeadlessResource[] = [];
  const host = {
    registerResource: (resource: DoomHeadlessResource) => {
      resources.push(resource);
      return { dispose: vi.fn() };
    },
    registerCommand: () => ({ dispose: vi.fn() }),
  } as unknown as DoomHeadlessHostService;
  const context = { get: () => host } as unknown as Context;
  profileHeadlessFacet.apply(context);
  const resource = resources.find(({ name }) => name === 'doompi/profile-config');
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
