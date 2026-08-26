import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLauncherComposition, writeLauncherComposition } from '../../src/adapters/launcherComposition.ts';
import {
  LAUNCHER_COMPOSITION_ENV,
  LAUNCHER_COMPOSITION_VERSION,
  type LauncherCompositionState,
} from '../../src/types/interfaces/launcherComposition';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-launcher-composition-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function record(overrides: Partial<LauncherCompositionState> = {}): LauncherCompositionState {
  return {
    version: LAUNCHER_COMPOSITION_VERSION,
    root: '/workspace/repo',
    preset: 'ollama',
    mute: true,
    autoStop: true,
    agents: false,
    bundles: { abc123: '/cache/dist/copilot.abc123.mjs' },
    ...overrides,
  };
}

function write(state: unknown): string {
  const target = path.join(workDir, 'composition.json');
  fs.writeFileSync(target, JSON.stringify(state));
  return target;
}

describe('launcher composition record', () => {
  it('round-trips the launch identity the entry has to recover', () => {
    const target = path.join(workDir, 'composition.json');
    writeLauncherComposition(target, record());

    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: target })).toEqual(record());
  });

  it('reads as absent when no session recorded a composition', () => {
    expect(readLauncherComposition({})).toBeUndefined();
  });

  it('reads as absent rather than throwing when the record is unusable', () => {
    // An unreadable record must leave the session on its startup composition
    // instead of failing every extension load.
    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: path.join(workDir, 'missing.json') })).toBeUndefined();
    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: write('not an object') })).toBeUndefined();
    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: write({ version: 99, root: '/r' }) })).toBeUndefined();
    expect(
      readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: write(record({ root: 7 as never })) }),
    ).toBeUndefined();
  });

  it('defaults the flags a truncated record omits', () => {
    const target = write({ version: LAUNCHER_COMPOSITION_VERSION, root: '/workspace/repo' });

    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: target })).toEqual({
      version: LAUNCHER_COMPOSITION_VERSION,
      root: '/workspace/repo',
      preset: 'default',
      mute: false,
      autoStop: false,
      // Agents are on unless a record says otherwise, matching the launcher default.
      agents: true,
      bundles: {},
    });
  });

  it('drops bundle entries that are not paths', () => {
    const target = write(record({ bundles: { good: '/a.mjs', bad: 3 as never } }));

    expect(readLauncherComposition({ [LAUNCHER_COMPOSITION_ENV]: target })?.bundles).toEqual({ good: '/a.mjs' });
  });
});
