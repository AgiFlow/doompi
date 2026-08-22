import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLAPSE_KEY,
  DEFAULT_DELEGATION_TIMEOUT_MS,
  DEFAULT_MAX_TASKS,
  DEFAULT_MAX_WIDGET_LINES,
  DEFAULT_STORE_TTL_MS,
  getMaxTasks,
  MAX_TASKS_ENV,
} from '../src/exports/config';

interface TaskConfig {
  maxWidgetLines: number;
  maxTasks: number;
  storeTtlMs: number;
  collapseKey: string;
  delegationTimeoutMs: number;
}

interface TaskConfigModule {
  parsePiTaskConfig?: (value: unknown) => TaskConfig;
}

describe('doom-task standalone adapters', () => {
  it('parses trusted Pi JSON into typed widget, retention, shortcut, and delegation settings', async () => {
    const configModule = (await import('../src/exports/config')) as unknown as TaskConfigModule;

    expect(configModule.parsePiTaskConfig).toEqual(expect.any(Function));
    if (!configModule.parsePiTaskConfig) return;

    expect(
      configModule.parsePiTaskConfig({
        maxWidgetLines: 24,
        maxTasks: 30,
        storeTtlMs: 86_400_000,
        collapseKey: 'ctrl+alt+t',
        delegationTimeoutMs: 30_000,
      }),
    ).toEqual({
      maxWidgetLines: 24,
      maxTasks: 30,
      storeTtlMs: 86_400_000,
      collapseKey: 'ctrl+alt+t',
      delegationTimeoutMs: 30_000,
    });
  });

  it('clamps invalid trusted values to the same safe defaults as environment configuration', async () => {
    const configModule = (await import('../src/exports/config')) as unknown as TaskConfigModule;

    expect(configModule.parsePiTaskConfig).toEqual(expect.any(Function));
    if (!configModule.parsePiTaskConfig) return;

    expect(
      configModule.parsePiTaskConfig({
        maxWidgetLines: 1,
        maxTasks: 0,
        storeTtlMs: 0,
        collapseKey: 'off',
        delegationTimeoutMs: -1,
      }),
    ).toEqual({
      maxWidgetLines: 3,
      maxTasks: DEFAULT_MAX_TASKS,
      storeTtlMs: DEFAULT_STORE_TTL_MS,
      collapseKey: 'off',
      delegationTimeoutMs: DEFAULT_DELEGATION_TIMEOUT_MS,
    });
    expect(configModule.parsePiTaskConfig({})).toEqual({
      maxWidgetLines: DEFAULT_MAX_WIDGET_LINES,
      maxTasks: DEFAULT_MAX_TASKS,
      storeTtlMs: DEFAULT_STORE_TTL_MS,
      collapseKey: DEFAULT_COLLAPSE_KEY,
      delegationTimeoutMs: DEFAULT_DELEGATION_TIMEOUT_MS,
    });
  });

  it('reads a positive integer task limit from the environment', () => {
    expect(getMaxTasks({ [MAX_TASKS_ENV]: '21' })).toBe(21);
    expect(getMaxTasks({ [MAX_TASKS_ENV]: '2.5' })).toBe(DEFAULT_MAX_TASKS);
    expect(getMaxTasks({ [MAX_TASKS_ENV]: '0' })).toBe(DEFAULT_MAX_TASKS);
  });

  it('exposes one standard Pi adapter and no alternate Doom entry', async () => {
    const standardAdapter = await import('../src/exports/extensions/pi');
    const doomAdapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/extensions/doom.ts');

    expect(standardAdapter.default).toEqual(expect.any(Function));
    await expect(access(doomAdapterPath)).rejects.toThrow();
  });
});
