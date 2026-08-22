import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibilityCommand } from '../../src/commands/compatibilityCommand.ts';
import { launchCompatibility } from '../../src/adapters/compatibility';
import { buildCompatibilityContext } from '../../src/adapters/compatibilityContext';
import type { CompatibilityContext } from '../../src/adapters/compatibilityContext';

vi.mock('@agimon-ai/doompi-config/domains', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadDomains: vi.fn(() => ({ defaultDomains: ['development', 'qa'] })),
}));
vi.mock('@agimon-ai/doompi-config/majorModes', () => ({
  loadMajorModesConfig: vi.fn(() => ({ defaultMajorMode: 'minimal' })),
}));
vi.mock('../../src/adapters/compatibility', () => ({ launchCompatibility: vi.fn() }));
vi.mock('../../src/adapters/compatibilityContext', () => ({ buildCompatibilityContext: vi.fn() }));

describe('CompatibilityCommand', () => {
  const cleanup = vi.fn(async () => undefined);
  const context = { cleanup } as unknown as CompatibilityContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildCompatibilityContext).mockResolvedValue(context);
    vi.mocked(launchCompatibility).mockResolvedValue(0);
  });

  it('matches only the compat command', () => {
    const command = new CompatibilityCommand();

    expect(command.matches(['compat', 'codex'])).toBe(true);
    expect(command.matches(['codex'])).toBe(false);
  });

  it('resolves the shared matrix and cleans up after launching', async () => {
    const command = new CompatibilityCommand();

    const exitCode = await command.execute(
      ['compat', 'claude', '--domains', 'development,qa', '--major-mode=dev', '--profile', 'product-agiflow', '--help'],
      { DOOMPI_ROOT: '/repo' },
      '/worktree',
    );

    expect(buildCompatibilityContext).toHaveBeenCalledWith({
      repoRoot: '/repo',
      provider: 'claude',
      currentDirectory: '/worktree',
      profile: 'product-agiflow',
      domains: ['development', 'qa'],
      majorMode: 'dev',
      providerArgs: ['--help'],
      additionalDirectories: [],
      skipPermissions: false,
    });
    expect(launchCompatibility).toHaveBeenCalledWith(context);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exitCode).toBe(0);
  });

  it('uses the repository default major mode when the invocation omits one', async () => {
    const command = new CompatibilityCommand();

    await command.execute(['compat', 'codex'], { DOOMPI_ROOT: '/repo' }, '/worktree');

    expect(buildCompatibilityContext).toHaveBeenCalledWith(
      expect.objectContaining({ majorMode: 'minimal', domains: ['development', 'qa'] }),
    );
  });

  it('rejects unsupported providers before building context', async () => {
    const command = new CompatibilityCommand();

    await expect(command.execute(['compat', 'unknown'], { DOOMPI_ROOT: '/repo' }, '/repo')).rejects.toThrow(
      'compat requires one of',
    );
    expect(buildCompatibilityContext).not.toHaveBeenCalled();
  });
});
