import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({
  loadDomains: vi.fn(() => ({ defaultDomains: [] })),
  loadMajorModesConfig: vi.fn(() => ({ defaultMajorMode: 'minimal' })),
  loadProfileCatalog: vi.fn(() => ({ profiles: [] }) as { profiles: []; defaultProfile?: string }),
}));

vi.mock('@agimon-ai/doompi-config/domains', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/doompi-config/domains')>()),
  loadDomains: configMocks.loadDomains,
}));
vi.mock('@agimon-ai/doompi-config/majorModes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/doompi-config/majorModes')>()),
  loadMajorModesConfig: configMocks.loadMajorModesConfig,
}));
vi.mock('@agimon-ai/doompi-config/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/doompi-config/profiles')>()),
  loadProfileCatalog: configMocks.loadProfileCatalog,
}));

const { resolveHarnessOptions } = await import('../../src/controllers/harnessOptions');

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-harness-options-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('resolveHarnessOptions', () => {
  it('uses an unconfigured working directory as its configuration root', () => {
    const cwd = temporaryDirectory();

    const options = resolveHarnessOptions({ args: ['--cwd', cwd], environment: {}, cwd });

    expect(options.repoRoot).toBe(cwd);
    expect(options.cwd).toBe(cwd);
    expect(configMocks.loadMajorModesConfig).toHaveBeenCalledWith(cwd, expect.any(String));
    expect(configMocks.loadDomains).toHaveBeenCalledWith(cwd, expect.any(String));
  });

  it('continues to use the nearest configured repository for a nested working directory', () => {
    const root = temporaryDirectory();
    const cwd = path.join(root, 'packages', 'app');
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(cwd, { recursive: true });

    const options = resolveHarnessOptions({ args: ['--cwd', cwd], environment: {}, cwd });

    expect(options.repoRoot).toBe(root);
    expect(options.cwd).toBe(cwd);
    expect(configMocks.loadMajorModesConfig).toHaveBeenCalledWith(root, expect.any(String));
    expect(configMocks.loadDomains).toHaveBeenCalledWith(root, expect.any(String));
  });

  it('starts on the repository default profile, and lets a run override it', () => {
    const cwd = temporaryDirectory();
    configMocks.loadProfileCatalog.mockReturnValue({ profiles: [], defaultProfile: 'ponytail' });

    expect(resolveHarnessOptions({ args: ['--cwd', cwd], environment: {}, cwd }).profile).toBe('ponytail');
    expect(resolveHarnessOptions({ args: ['--cwd', cwd, '--profile', 'caveman'], environment: {}, cwd }).profile).toBe(
      'caveman',
    );
    // A nested run stays on the persona its parent chose.
    expect(
      resolveHarnessOptions({ args: ['--cwd', cwd], environment: { DOOMPI_PROFILE: 'caveman' }, cwd }).profile,
    ).toBe('caveman');
  });
});
