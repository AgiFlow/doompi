import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installDependencies, installerFor } from '../../../../src/adapters/worktree/dependencyInstall.ts';

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-git-install-'));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installerFor', () => {
  // The lockfile the repository committed is the only correct answer: a
  // worktree shares its parent's history, so it shares its package manager.
  it('picks the package manager from the committed lockfile', () => {
    expect(installerFor(workspace({ 'pnpm-lock.yaml': '' }))?.command).toBe('pnpm');
    expect(installerFor(workspace({ 'yarn.lock': '' }))?.command).toBe('yarn');
    expect(installerFor(workspace({ 'package-lock.json': '{}' }))?.command).toBe('npm');
  });

  it('has no answer without a lockfile', () => {
    expect(installerFor(workspace({ 'package.json': '{}' }))).toBeUndefined();
  });
});

describe('installDependencies', () => {
  // Not every checkout is a Node project, and a worktree of one must still open.
  it('skips a repository with no manifest', async () => {
    await expect(installDependencies(workspace({ 'README.md': '#' }))).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-manifest',
    });
  });

  it('skips a manifest with no lockfile rather than guessing', async () => {
    await expect(installDependencies(workspace({ 'package.json': '{}' }))).resolves.toEqual({
      kind: 'skipped',
      reason: 'no-lockfile',
    });
  });

  // The failure path reports a length, never the installer's output: package
  // managers print absolute paths and registry URLs.
  it('reports a failure without carrying the installer output', async () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'x', dependencies: { 'this-package-does-not-exist-9e7': '^9.9.9' } }),
      'package-lock.json': '{ not valid json',
    });
    const outcome = await installDependencies(root);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.command).toBe('npm');
    expect(Object.keys(outcome)).not.toContain('stderr');
    expect(typeof outcome.stderrBytes).toBe('number');
  }, 120_000);
});
