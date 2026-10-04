import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import * as moduleResolution from '@agimon-ai/doompi-core/moduleResolution';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requiredHookGroups, syncHookModules, validateHookModules } from '../../src/builders/hooks';
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
beforeEach(() => {
  vi.spyOn(moduleResolution, 'optionalPackageEntry').mockReturnValue(
    path.resolve(__dirname, '../../../../default/doompi-hook/src/exports/index.ts'),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('sync hook modules', () => {
  it('preflights new module rows against the pinned descriptor without evaluating source', async () => {
    const options = fixture();
    const registry = path.join(options.repoRoot, '.doom', 'hooks.yaml');
    const reference = await syncHookModules(options);
    fs.writeFileSync(
      registry,
      'groups:\n  core:\n    core: true\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./guard.ts}\n',
    );
    fs.writeFileSync(
      path.join(options.repoRoot, 'guard.ts'),
      'throw new Error("must not evaluate"); export default {setup(){return {}}}',
    );
    await expect(validateHookModules({ ...options, descriptor: reference })).rejects.toThrow(
      'module missing from descriptor',
    );
    const repaired = await syncHookModules(options);
    await expect(validateHookModules({ ...options, descriptor: repaired })).resolves.toBe(true);
    fs.unlinkSync(JSON.parse(fs.readFileSync(repaired.file, 'utf8')).modules[0].artifact);
    await expect(validateHookModules({ ...options, descriptor: repaired })).rejects.toThrow('Run doompi sync');
  });

  it('leaves unselected modules alone but always checks core module rows', async () => {
    const options = fixture();
    const registry = path.join(options.repoRoot, '.doom', 'hooks.yaml');
    fs.writeFileSync(
      registry,
      'groups:\n  excluded:\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./missing.ts}\n',
    );
    await expect(validateHookModules({ ...options, hookGroups: [] })).resolves.toBe(false);
    fs.writeFileSync(
      registry,
      'groups:\n  excluded:\n    core: true\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./missing.ts}\n',
    );
    await expect(validateHookModules({ ...options, hookGroups: [] })).rejects.toThrow('module missing from descriptor');
  });

  it('does not require parent-only artifacts for subagent admission', async () => {
    const options = fixture();
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      'groups:\n  core:\n    core: true\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./parent-only.ts, skipInSubagent: true}\n',
    );
    await expect(validateHookModules({ ...options, isSubagent: true })).resolves.toBe(false);
    await expect(validateHookModules(options)).rejects.toThrow('module missing from descriptor');
  });

  it('does not require an installed hook package to preflight command-only rows', async () => {
    const options = fixture();
    vi.spyOn(moduleResolution, 'optionalPackageEntry').mockReturnValue(undefined);
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      'groups:\n  core:\n    hooks:\n      - event: PreToolUse\n        pi: {command: "echo ok"}\n',
    );
    await expect(validateHookModules(options)).resolves.toBe(false);
  });

  it('does not require an installed hook package for a command-only registry', async () => {
    const options = fixture();
    vi.spyOn(moduleResolution, 'optionalPackageEntry').mockReturnValue(undefined);
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      'groups:\n  core:\n    hooks:\n      - event: PreToolUse\n        pi: {command: "echo ok"}\n',
    );
    const reference = await syncHookModules(options);
    expect(JSON.parse(fs.readFileSync(reference.file, 'utf8')).modules).toEqual([]);
  });

  it('requires the public parser with install guidance only when module rows exist', async () => {
    const options = fixture();
    vi.spyOn(moduleResolution, 'optionalPackageEntry').mockReturnValue(undefined);
    fs.writeFileSync(
      path.join(options.repoRoot, '.doom', 'hooks.yaml'),
      'groups:\n  core:\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./hook.ts}\n',
    );
    await expect(syncHookModules(options)).rejects.toThrow('Install it in the repository');
  });

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
