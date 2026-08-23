import { describe, expect, it } from 'vitest';
import { buildSandboxForwardArgs } from '../../src/commands/cli/sandboxArgs';
import { parseHarnessArgs } from '../../src/exports/cli/options';
import type { HarnessOptions } from '../../src/types/interfaces/harness';

function parsedOptions(args: string[]): HarnessOptions {
  return { repoRoot: '/repo', ...parseHarnessArgs(args, {}, '/repo').options };
}

function replay(options: HarnessOptions): HarnessOptions {
  return parsedOptions(buildSandboxForwardArgs(options));
}

describe('buildSandboxForwardArgs', () => {
  it('replays a fully specified launch identically inside the sandbox', () => {
    const original = parsedOptions([
      '--major-mode',
      'copilot',
      '--profile',
      'reviewer',
      '--domains',
      'default,web',
      '--mute',
      '--allow-protected-writes',
      '--no-hooks',
      '--model',
      'openai-codex/gpt-5.6-terra',
      'fix this',
    ]);

    expect(replay(original)).toEqual(original);
  });

  it('keeps automation flags stable across a replay', () => {
    const original = parsedOptions(['--automation', 'task']);

    expect(replay(original)).toEqual(original);
  });

  it('replays the vibe-lint output contract', () => {
    const original = parsedOptions(['--output-format', 'vibe-lint', '--mute']);

    expect(replay(original)).toEqual(original);
  });

  it('preserves an explicitly empty domain selection', () => {
    const original = parsedOptions(['--no-domains']);
    const forwarded = buildSandboxForwardArgs(original);

    expect(forwarded).toContain('--no-domains');
    expect(replay(original).domains).toEqual([]);
  });

  it('never forwards the sandbox flag itself', () => {
    const original = parsedOptions(['--sandbox', 'run']);
    const forwarded = buildSandboxForwardArgs(original);

    expect(forwarded).not.toContain('--sandbox');
    expect(replay(original)).toEqual({ ...original, sandbox: false });
  });
});
