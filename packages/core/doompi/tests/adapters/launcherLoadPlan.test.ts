import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { describe, expect, it } from 'vitest';
import { resolveLauncherLoadPlan } from '../../src/adapters/launcherComposition.ts';
import {
  LAUNCHER_COMPOSITION_VERSION,
  type LauncherCompositionState,
} from '../../src/types/interfaces/launcherComposition';

/** This repository is a configured DoomPi root, so its real modes.yaml drives the composition. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

function state(overrides: Partial<LauncherCompositionState> = {}): LauncherCompositionState {
  return {
    version: LAUNCHER_COMPOSITION_VERSION,
    root: REPO_ROOT,
    preset: 'default',
    mute: false,
    autoStop: false,
    agents: true,
    bundles: {},
    ...overrides,
  };
}

function harness(majorMode: string, layers: string[]): HarnessState {
  return {
    root: REPO_ROOT,
    majorMode,
    layers,
    domains: [],
    profileEnvironment: {},
    skillDirectories: [],
    agentDirectories: [],
    additionalDirectories: [],
    childExtensions: [],
    pluginDirectories: [],
    pluginHooks: [],
    allowProtectedWrites: false,
    hooks: true,
  } as unknown as HarnessState;
}

describe('resolveLauncherLoadPlan', () => {
  it('composes from the selection that is live now, not the one recorded at launch', () => {
    // This is the whole point of the stable entry: the record is fixed for the
    // process, so a different plan here can only come from harness state.
    const copilot = resolveLauncherLoadPlan(state(), harness('copilot', ['team', 'ask-user', 'task']));
    const minimal = resolveLauncherLoadPlan(state(), harness('minimal', ['team', 'task']));

    expect(copilot.fingerprint).not.toBe(minimal.fingerprint);
    expect(copilot.entries).not.toEqual(minimal.entries);
  });

  it('activates a built aggregate when the selected composition has one', () => {
    const plan = resolveLauncherLoadPlan(state(), harness('copilot', ['team', 'ask-user', 'task']));
    const withBundle = resolveLauncherLoadPlan(
      state({ bundles: { [plan.fingerprint]: '/cache/copilot.mjs' } }),
      harness('copilot', ['team', 'ask-user', 'task']),
      () => true,
    );

    expect(withBundle.entries).toEqual(['/cache/copilot.mjs']);
  });

  it('falls back to the individual entries when the selected composition was never built', () => {
    // A launcher session can be asked for a composition sync never precompiled,
    // so the sources are the answer rather than refusing the switch.
    const plan = resolveLauncherLoadPlan(
      state({ bundles: { someOtherFingerprint: '/cache/other.mjs' } }),
      harness('minimal', ['team', 'task']),
    );

    expect(plan.entries.length).toBeGreaterThan(1);
    expect(plan.entries).not.toContain('/cache/other.mjs');
  });

  it('ignores a recorded aggregate whose file has since been removed', () => {
    const plan = resolveLauncherLoadPlan(state(), harness('copilot', ['team', 'ask-user', 'task']));
    const stale = resolveLauncherLoadPlan(
      state({ bundles: { [plan.fingerprint]: '/cache/deleted.mjs' } }),
      harness('copilot', ['team', 'ask-user', 'task']),
      () => false,
    );

    expect(stale.entries).toEqual(plan.entries);
  });
});
