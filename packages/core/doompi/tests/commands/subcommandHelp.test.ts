import { describe, expect, it, vi } from 'vitest';
import { doctorHelp, syncHelp } from '../../src/controllers/help';
import { CompatibilityCommand } from '../../src/controllers/compatibilityCommand';
import { DoctorCommand } from '../../src/controllers/doctorCommand';
import { InitCommand } from '../../src/controllers/initCommand';
import { SyncPipeline } from '../../src/controllers/syncPipeline';

/** Collects what a command wrote so a help run can be checked for side effects. */
function recorder(): { write: (chunk: string) => boolean; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

describe('subcommand help', () => {
  it('prints sync help instead of running a sync', async () => {
    const output = recorder();

    await expect(new SyncPipeline().execute(['sync', '--help'], {}, process.cwd(), output)).resolves.toBe(0);

    // Exactly the help text and nothing else: any sync work would have written
    // progress or a result line, which is what the old behaviour did.
    expect(output.text()).toBe(syncHelp());
  });

  it('prints sync help for --check --help as well', async () => {
    const output = recorder();

    await expect(new SyncPipeline().execute(['sync', '--check', '--help'], {}, process.cwd(), output)).resolves.toBe(0);

    expect(output.text()).toBe(syncHelp());
  });

  it('prints init help instead of rejecting the flag', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(new InitCommand().execute(['init', '--help'])).resolves.toBe(0);
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Usage: doompi init');
    } finally {
      write.mockRestore();
    }
  });

  it('prints compat help instead of demanding a provider', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(new CompatibilityCommand().execute(['compat', '--help'])).resolves.toBe(0);
      expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Usage: doompi compat');
    } finally {
      write.mockRestore();
    }
  });

  it('prints doctor help without running any check', () => {
    const output = recorder();

    expect(new DoctorCommand().execute(['doctor', '--help'], {}, process.cwd(), output)).toBe(0);

    // Exactly the help text: a real run appends per-section result lines.
    expect(output.text()).toBe(doctorHelp());
  });

  // A provider's own --help belongs to the provider, not to doompi.
  it('does not claim a help flag that follows the passthrough separator', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(new CompatibilityCommand().execute(['compat', '--', '--help'])).rejects.toThrow(
        /compat requires one of/,
      );
    } finally {
      write.mockRestore();
    }
  });
});
