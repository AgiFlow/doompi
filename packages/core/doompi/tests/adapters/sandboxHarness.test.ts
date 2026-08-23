import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSandboxHarness, resolveSandboxHarnessEntry } from '../../src/adapters/sandboxHarness';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sandbox-harness-'));
  tempDirectories.push(repoRoot);
  return repoRoot;
}

function writeSandboxPackage(packageRoot: string, name: string, exitCode: number): void {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name, exports: { './sandbox-harness': { import: './harness.mjs' } } })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, 'harness.mjs'),
    `export function launchSandbox() {\n  return Promise.resolve(${exitCode});\n}\n`,
  );
}

function writePlainPackage(packageRoot: string, name: string): void {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({ name, main: './index.js' })}\n`);
  fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = {};\n');
}

function config(repoRoot: string, layerPackages: MajorModesConfig['layers'][string]['packages']): MajorModesConfig {
  return {
    default: { baseDirectory: repoRoot, packages: ['./packages/plain'] },
    defaultMajorMode: 'copilot',
    majorMode: { copilot: { description: 'Fixture mode.', layers: ['sandbox'] } },
    layers: {
      sandbox: { baseDirectory: repoRoot, packages: layerPackages },
      unselected: { baseDirectory: repoRoot, packages: ['./packages/unselected'] },
    },
  };
}

describe('resolveSandboxHarnessEntry', () => {
  it('resolves a local layer package exporting the sandbox subpath', () => {
    const repoRoot = createRepo();
    writePlainPackage(path.join(repoRoot, 'packages', 'plain'), 'plain');
    writeSandboxPackage(path.join(repoRoot, 'layers', 'sbx'), '@scope/sandbox', 0);

    const resolution = resolveSandboxHarnessEntry(config(repoRoot, ['./layers/sbx']), ['sandbox'], repoRoot);

    expect(resolution?.specifier).toBe('./layers/sbx');
    expect(resolution?.entry).toBe(path.join(repoRoot, 'layers', 'sbx', 'harness.mjs'));
  });

  it('resolves an installed npm layer package from the repository modules', () => {
    const repoRoot = createRepo();
    writeSandboxPackage(path.join(repoRoot, 'node_modules', '@scope', 'sandbox'), '@scope/sandbox', 0);

    const resolution = resolveSandboxHarnessEntry(config(repoRoot, ['@scope/sandbox']), ['sandbox'], repoRoot);

    expect(resolution?.specifier).toBe('@scope/sandbox');
    expect(resolution?.entry).toBe(path.join(repoRoot, 'node_modules', '@scope', 'sandbox', 'harness.mjs'));
  });

  it('answers undefined when no selected package exports the subpath', () => {
    const repoRoot = createRepo();
    writePlainPackage(path.join(repoRoot, 'packages', 'plain'), 'plain');
    writePlainPackage(path.join(repoRoot, 'layers', 'other'), 'other');

    expect(resolveSandboxHarnessEntry(config(repoRoot, ['./layers/other']), ['sandbox'], repoRoot)).toBeUndefined();
  });

  it('ignores providers declared by unselected layers', () => {
    const repoRoot = createRepo();
    writeSandboxPackage(path.join(repoRoot, 'packages', 'unselected'), 'unselected', 0);

    expect(resolveSandboxHarnessEntry(config(repoRoot, ['./layers/none']), [], repoRoot)).toBeUndefined();
  });

  it('rejects a composition with two sandbox providers', () => {
    const repoRoot = createRepo();
    writeSandboxPackage(path.join(repoRoot, 'layers', 'one'), 'one', 0);
    writeSandboxPackage(path.join(repoRoot, 'layers', 'two'), 'two', 0);

    expect(() =>
      resolveSandboxHarnessEntry(config(repoRoot, ['./layers/one', './layers/two']), ['sandbox'], repoRoot),
    ).toThrowError(/Multiple sandbox harnesses/);
  });
});

describe('loadSandboxHarness', () => {
  it('imports the entry and hands back its launcher', async () => {
    const repoRoot = createRepo();
    writeSandboxPackage(path.join(repoRoot, 'layers', 'sbx'), '@scope/sandbox', 42);

    const harness = await loadSandboxHarness(path.join(repoRoot, 'layers', 'sbx', 'harness.mjs'));

    await expect(harness.launchSandbox({ repoRoot, cwd: repoRoot, forwardArgs: [], environment: {} })).resolves.toBe(
      42,
    );
  });

  it('rejects an entry without a launchSandbox export', async () => {
    const repoRoot = createRepo();
    const entry = path.join(repoRoot, 'empty.mjs');
    fs.writeFileSync(entry, 'export const unrelated = true;\n');

    await expect(loadSandboxHarness(entry)).rejects.toThrowError(/does not export launchSandbox/);
  });
});
