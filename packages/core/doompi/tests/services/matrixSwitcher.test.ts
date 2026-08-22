import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getHarnessState,
  HARNESS_STATE_KEYS,
  projectHarnessEnvironment,
  refreshHarnessState,
} from '../../src/exports/config/harnessState';
import { applyMajorMode } from '@agimon-ai/doompi-config/selectionSwitch';
import { extensionLayers, needsRelaunch } from '../../src/exports/services/matrixSwitcher';

const config: MajorModesConfig = {
  layers: {
    scaffolding: { baseDirectory: '/repo', hookGroups: ['scaffolding'] },
    guardrails: { baseDirectory: '/repo', extensions: ['repositoryHooks'], hookGroups: ['guardrails'] },
    'vibe-lint': { baseDirectory: '/repo', packages: ['@agimon-ai/vibe-lint'] },
    task: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-task'] },
    team: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-team'] },
  },
  defaultMajorMode: 'copilot',
  majorMode: {
    copilot: {
      description: 'Copilot test mode.',
      layers: ['guardrails', 'vibe-lint', 'scaffolding', 'task'],
    },
    marketing: { description: 'Marketing test mode.', layers: ['task'] },
  },
};

afterEach(() => {
  for (const key of Object.values(HARNESS_STATE_KEYS)) delete process.env[key];
  refreshHarnessState();
});

describe('base switching', () => {
  it('preserves disabled hooks when applying another base', () => {
    projectHarnessEnvironment({ hooks: false }, process.env);
    refreshHarnessState();

    applyMajorMode(config, 'copilot', getHarnessState());

    expect(getHarnessState()).toMatchObject({
      majorMode: 'copilot',
      layers: ['vibe-lint', 'task'],
      hookGroups: [],
      hooks: false,
    });
  });

  it('refreshes the child extension projection with a reloaded composition', () => {
    projectHarnessEnvironment({ hooks: true, childExtensions: ['/child/old.mjs'] }, process.env);
    refreshHarnessState();

    applyMajorMode(config, 'marketing', getHarnessState(), 'candidate-fingerprint', [
      '/child/config.mjs',
      '/child/task.mjs',
    ]);

    expect(getHarnessState()).toMatchObject({
      majorMode: 'marketing',
      compositionFingerprint: 'candidate-fingerprint',
      childExtensions: ['/child/config.mjs', '/child/task.mjs'],
    });
  });
});

describe('extension-set staleness', () => {
  it('counts only layers that contribute extensions or packages', () => {
    expect(extensionLayers(config, ['guardrails', 'vibe-lint', 'scaffolding'])).toEqual(['guardrails', 'vibe-lint']);
    expect(extensionLayers(config, ['scaffolding'])).toEqual([]);
    expect(extensionLayers(config, ['unknown'])).toEqual([]);
  });

  it('does not demand a relaunch for a hook-only change', () => {
    expect(needsRelaunch(config, ['guardrails'], ['guardrails', 'scaffolding'])).toBe(false);
  });

  it('demands a relaunch when the extension set changes', () => {
    expect(needsRelaunch(config, ['guardrails'], ['guardrails', 'vibe-lint'])).toBe(true);
    expect(needsRelaunch(config, ['guardrails'], [])).toBe(true);
    expect(needsRelaunch(config, ['task'], ['task', 'team'])).toBe(true);
  });

  it('treats authored activation ordering as part of the extension closure', () => {
    expect(needsRelaunch(config, ['vibe-lint', 'guardrails'], ['guardrails', 'vibe-lint'])).toBe(true);
  });
});
