import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitPluginSource, NpmPluginSource, PluginEntry } from '@agimon-ai/doompi-config/domains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializePluginEntries } from '../../src/adapters/pluginMaterializer.ts';

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/**
 * The default materializers, driven end to end.
 *
 * Git runs against a repository on disk rather than a remote, and npm runs
 * against a stub earlier on PATH, so both exercise the real spawn plumbing
 * without a network.
 */
describe('default plugin materializers', () => {
  let workspace: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-plugin-sources-'));
    previousPath = process.env.PATH;
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  }

  function originRepository(manifestDirectory = '.'): { url: string; sha: string } {
    const origin = path.join(workspace, 'origin');
    fs.mkdirSync(path.join(origin, manifestDirectory), { recursive: true });
    fs.writeFileSync(
      path.join(origin, manifestDirectory, 'plugin.json'),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: 'plugin' }),
    );
    git(['init', '--initial-branch=main'], origin);
    git(['add', '-A'], origin);
    git(['commit', '-m', 'plugin'], origin);
    return { url: origin, sha: git(['rev-parse', 'HEAD'], origin) };
  }

  function entry(source: GitPluginSource | NpmPluginSource, name = 'plugin'): PluginEntry {
    return { name, directory: path.join(workspace, 'cache', name), source };
  }

  it('clones a git plugin and reads its manifest', async () => {
    const { url } = originRepository();

    const [installed] = await materializePluginEntries([entry({ type: 'git', url })]);

    expect(installed?.skillDiscovery).toBe('direct-children');
    expect(fs.existsSync(path.join(workspace, 'cache', 'plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'cache', 'plugin', '.git'))).toBe(false);
  });

  it('checks out the requested ref and verifies a requested sha', async () => {
    const { url, sha } = originRepository();

    await expect(materializePluginEntries([entry({ type: 'git', url, ref: 'main' }, 'by-ref')])).resolves.toHaveLength(
      1,
    );
    await expect(materializePluginEntries([entry({ type: 'git', url, sha }, 'by-sha')])).resolves.toHaveLength(1);
  });

  it('sparse-checks-out a repository-relative plugin directory', async () => {
    const { url } = originRepository(path.join('packages', 'plugin'));

    const [installed] = await materializePluginEntries([
      entry({ type: 'git', url, path: 'packages/plugin' }, 'sparse'),
    ]);

    expect(installed?.skillDiscovery).toBe('direct-children');
    expect(fs.existsSync(path.join(workspace, 'cache', 'sparse', 'plugin.json'))).toBe(true);
  });

  it('reports the failing git invocation rather than an empty cache', async () => {
    const missing = path.join(workspace, 'no-such-repository');

    await expect(materializePluginEntries([entry({ type: 'git', url: missing })])).rejects.toThrow(
      /Failed to install remote plugin plugin: git clone/u,
    );
    expect(fs.existsSync(path.join(workspace, 'cache', 'plugin'))).toBe(false);
  });

  it('refuses a repository-relative path that escapes the checkout', async () => {
    const missing = path.join(workspace, 'no-such-repository');

    await expect(
      materializePluginEntries([entry({ type: 'git', url: missing, path: '../../escape' }, 'escape')]),
    ).rejects.toThrow(/resolves outside/u);
  });

  it('installs an npm plugin through the resolved npm binary', async () => {
    const stubDirectory = path.join(workspace, 'bin');
    fs.mkdirSync(stubDirectory, { recursive: true });
    const stub = path.join(stubDirectory, 'npm');
    // Writes the package the real npm would have installed, so the prefix, the
    // package path and the containment check are all the production ones.
    fs.writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'set -e',
        'prefix=""',
        'while [ $# -gt 0 ]; do',
        '  if [ "$1" = "--prefix" ]; then prefix="$2"; shift; fi',
        '  shift',
        'done',
        'mkdir -p "$prefix/node_modules/@scope/plugin"',
        `printf '%s' '{"$schema":"${AGENT_PLUGIN_SCHEMA}"}' > "$prefix/node_modules/@scope/plugin/plugin.json"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.PATH = `${stubDirectory}${path.delimiter}${previousPath ?? ''}`;

    const [installed] = await materializePluginEntries([
      entry({ type: 'npm', package: '@scope/plugin', version: '1.0.0', registry: 'https://registry.invalid' }, 'npm'),
    ]);

    expect(installed?.skillDiscovery).toBe('direct-children');
    expect(fs.existsSync(path.join(workspace, 'cache', 'npm', 'plugin.json'))).toBe(true);
  });

  it('reports a missing executable rather than hanging on the spawn', async () => {
    process.env.PATH = path.join(workspace, 'empty-bin');

    await expect(
      materializePluginEntries([entry({ type: 'npm', package: '@scope/plugin' }, 'absent')]),
    ).rejects.toThrow(/Failed to run npm/u);
  });
});
