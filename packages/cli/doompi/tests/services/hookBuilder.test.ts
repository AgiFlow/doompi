import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it } from 'vitest';

import { requiredHookGroups, syncHookModules } from '../../src/builders/hooks';
import { hookModulesAreFresh } from '../../src/composition/syncDrift';

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-builder-'));
  directories.push(root);
  const homeDirectory = path.join(root, 'home');
  fs.mkdirSync(path.join(root, '.doom'));
  fs.mkdirSync(homeDirectory);
  const config: MajorModesConfig = {
    defaultMajorMode: 'active',
    majorMode: { active: { description: '', layers: ['active'] }, inactive: { description: '', layers: ['inactive'] } },
    layers: {
      active: { baseDirectory: root, hookGroups: ['active'] },
      inactive: { baseDirectory: root, hookGroups: ['inactive'] },
    },
  };
  return { repoRoot: root, homeDirectory, config, directory: path.join(root, 'generation') };
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync hook modules', () => {
  it('takes every mode and admits all when a selected layer leaves hookGroups unset', () => {
    const options = fixture();
    expect([...requiredHookGroups(options.config)!]).toEqual(['active', 'inactive']);
    delete options.config.layers.inactive.hookGroups;
    expect(requiredHookGroups(options.config)).toBeUndefined();
  });

  it('deduplicates core and inactive-mode rows without evaluating modules, and tracks imported files', async () => {
    const options = fixture();
    fs.writeFileSync(path.join(options.repoRoot, 'value.ts'), 'export const value = 1;');
    fs.writeFileSync(
      path.join(options.repoRoot, 'hook.ts'),
      "import {value} from './value'; throw new Error('must not evaluate'); export default {setup(){return {value}}};",
    );
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      `groups:\n  core:\n    core: true\n    hooks:\n      - event: SessionStart\n        pi: {module: ./hook.ts}\n  inactive:\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./hook.ts}\n  excluded:\n    hooks:\n      - event: Stop\n        pi: {module: ./missing.ts}\n`,
    );
    const reference = await syncHookModules(options);
    const descriptor = JSON.parse(fs.readFileSync(reference.file, 'utf8')) as {
      modules: Array<{ source: string; artifact: string; rows: unknown[] }>;
    };
    expect(descriptor.modules).toHaveLength(1);
    expect(descriptor.modules[0].rows).toHaveLength(2);
    expect(descriptor.modules[0].source).toBe(path.join(options.repoRoot, 'hook.ts'));
    const state = { fileState: { hookModules: reference } };
    expect(hookModulesAreFresh(state, options.directory)).toBe(true);
    fs.writeFileSync(path.join(options.repoRoot, 'value.ts'), 'export const value = 222;');
    expect(hookModulesAreFresh(state, options.directory)).toBe(false);
    expect(hookModulesAreFresh(state, options.directory, false)).toBe(true);
  });

  it('fails on an inactive-mode module with registry and row attribution', async () => {
    const options = fixture();
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      `groups:\n  inactive:\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./missing.ts}\n`,
    );
    await expect(syncHookModules(options)).rejects.toThrow(/hooks.yaml: group inactive, row 0, event PreToolUse/);
  });
});
