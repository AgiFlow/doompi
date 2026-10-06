import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import * as moduleResolution from '@agimon-ai/doompi-core/moduleResolution';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkoutHookDescriptor,
  requiredHookGroups,
  syncHookModules,
  validateHookModules,
} from '../../src/builders/hooks';
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

describe('checkout hook descriptor', () => {
  it('validates checkout rows and invokes admitted artifacts with checkout context', async () => {
    const options = fixture();
    const checkout = path.join(options.repoRoot, 'checkout');
    const temporary = path.join(options.repoRoot, 'session');
    fs.mkdirSync(path.join(checkout, '.doom'), { recursive: true });
    fs.mkdirSync(temporary);
    const yaml =
      'groups:\n  core:\n    core: true\n    hooks:\n      - event: PreToolUse\n        pi: {module: ./guard.ts}\n';
    fs.writeFileSync(path.join(options.repoRoot, '.doom', 'hooks.yaml'), yaml);
    fs.writeFileSync(path.join(checkout, '.doom', 'hooks.yaml'), yaml);
    fs.writeFileSync(
      path.join(options.repoRoot, 'guard.ts'),
      'export default {setup(ctx){return {tool_call(){return {block:true,reason:ctx.repoRoot}}}}}',
    );
    const descriptor = await syncHookModules(options);
    const original = fs.readFileSync(descriptor.file, 'utf8');
    await expect(validateHookModules({ ...options, repoRoot: checkout, descriptor })).rejects.toThrow(
      'module missing from descriptor',
    );
    const aliased = checkoutHookDescriptor(descriptor, options.repoRoot, checkout, temporary)!;
    await expect(validateHookModules({ ...options, repoRoot: checkout, descriptor: aliased })).resolves.toBe(true);
    expect(fs.statSync(aliased.file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(descriptor.file, 'utf8')).toBe(original);
    const { createHookModules } = await import('@agimon-ai/doompi-hook');
    const modules = createHookModules({ descriptor: aliased });
    try {
      await expect(
        modules.invoke(
          { root: checkout, hook: { module: path.join(checkout, 'guard.ts') } },
          { type: 'tool_call', toolName: 'bash', toolCallId: 'call', input: {} },
          {
            sessionId: 'checkout',
            cwd: checkout,
            repoRoot: checkout,
            isSubagent: false,
            signal: new AbortController().signal,
            sendMessage: async () => {},
            appendCustomEntry: async () => {},
          },
        ),
      ).resolves.toEqual({ result: { block: true, reason: checkout } });
    } finally {
      await modules.dispose();
    }
  });

  it('preserves identity without writing for absent descriptors, same roots and external sources', () => {
    const options = fixture();
    const descriptor = { file: path.join(options.repoRoot, 'descriptor.json') };
    const directory = path.join(options.repoRoot, 'nonexistent');
    expect(checkoutHookDescriptor(undefined, options.repoRoot, '/checkout', directory)).toBeUndefined();
    expect(checkoutHookDescriptor(descriptor, options.repoRoot, options.repoRoot, directory)).toBe(descriptor);
    fs.writeFileSync(
      descriptor.file,
      JSON.stringify({
        version: 1,
        modules: [
          { source: '/global/hook.ts', artifact: '/admitted/hook.mjs' },
          { source: options.repoRoot + '-sibling/hook.ts', artifact: '/admitted/sibling.mjs' },
          { source: options.repoRoot, artifact: '/admitted/root.mjs' },
        ],
      }),
    );
    expect(checkoutHookDescriptor(descriptor, options.repoRoot, '/checkout', directory)).toBe(descriptor);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('retains exact mappings and external entries without duplicate aliases', () => {
    const options = fixture();
    const descriptor = { file: path.join(options.repoRoot, 'descriptor.json') };
    const originals = [
      { source: path.join(options.repoRoot, 'hook.ts'), artifact: '/admitted/workspace.mjs' },
      { source: '/checkout/hook.ts', artifact: '/admitted/exact.mjs' },
      { source: '/global/hook.ts', artifact: '/admitted/global.mjs' },
      { source: path.join(options.repoRoot, 'other.ts'), artifact: '/admitted/other.mjs' },
    ];
    fs.writeFileSync(descriptor.file, JSON.stringify({ version: 1, modules: originals }));
    const result = checkoutHookDescriptor(descriptor, options.repoRoot, '/checkout', options.repoRoot)!;
    expect(JSON.parse(fs.readFileSync(result.file, 'utf8')).modules).toEqual([
      ...originals,
      { ...originals[3], source: '/checkout/other.ts' },
    ]);
  });

  it.each([
    { version: 2, modules: [] },
    { version: 1, modules: [null] },
    { version: 1, modules: [{ source: 'relative.ts', artifact: '/artifact.mjs' }] },
    { version: 1, modules: [{ source: '/source.ts', artifact: 'relative.mjs' }] },
    { version: 1, modules: [{ source: '/source.ts', artifact: '/artifact.ts' }] },
    {
      version: 1,
      modules: [
        { source: '/source.ts', artifact: '/a.mjs' },
        { source: '/source.ts', artifact: '/b.mjs' },
      ],
    },
  ])('rejects malformed originals without writing: %j', (value) => {
    const options = fixture();
    const descriptor = { file: path.join(options.repoRoot, 'descriptor.json') };
    fs.writeFileSync(descriptor.file, JSON.stringify(value));
    expect(() => checkoutHookDescriptor(descriptor, options.repoRoot, '/checkout', options.repoRoot)).toThrow(
      'invalid hook module',
    );
    expect(fs.existsSync(path.join(options.repoRoot, 'hook-modules.json'))).toBe(false);
  });
});
