import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitPluginSource, NpmPluginSource, PluginEntry } from '@agimon-ai/doompi-config/domains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializePluginEntries } from '../../src/adapters/pluginMaterializer.ts';

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const gitSource: GitPluginSource = { type: 'git', url: 'https://example.invalid/plugin.git' };
const npmSource: NpmPluginSource = { type: 'npm', package: '@scope/plugin' };

/**
 * The real git and npm materializers shell out, so every test here injects one
 * that stages a directory instead. What is under test is the cache contract
 * around them: the marker, the manifest gate and the atomic rename.
 */
describe('materializePluginEntries', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-plugins-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function stage(manifest: Record<string, unknown>, manifestPath = 'plugin.json') {
    return async (_source: unknown, staging: string): Promise<string> => {
      const sourceRoot = path.join(staging, 'source');
      fs.mkdirSync(path.dirname(path.join(sourceRoot, manifestPath)), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, manifestPath), JSON.stringify(manifest));
      fs.mkdirSync(path.join(sourceRoot, '.git'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, '.git', 'config'), 'checkout metadata');
      return sourceRoot;
    };
  }

  function entry(overrides: Partial<PluginEntry> = {}): PluginEntry {
    return { name: 'plugin', directory: path.join(workspace, 'cache', 'plugin'), source: gitSource, ...overrides };
  }

  it('leaves a local entry with no remote source untouched', async () => {
    const local: PluginEntry = { directory: path.join(workspace, 'plugins', 'local') };

    await expect(materializePluginEntries([local])).resolves.toEqual([local]);
  });

  it('installs a git plugin once, records a marker, and drops the checkout metadata', async () => {
    const git = vi.fn(stage({ $schema: AGENT_PLUGIN_SCHEMA, name: 'plugin' }));

    const [installed] = await materializePluginEntries([entry()], { materializers: { git } });

    expect(installed?.skillDiscovery).toBe('direct-children');
    expect(installed?.manifest).toMatchObject({
      path: path.join(entry().directory, 'plugin.json'),
      name: 'plugin',
      agentPluginSchema: AGENT_PLUGIN_SCHEMA,
    });
    expect(fs.existsSync(path.join(entry().directory, '.git'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(entry().directory, '.doompi-plugin.json'), 'utf8'))).toEqual({
      version: 1,
      source: gitSource,
    });

    // A second pass sees the marker and does not materialize again.
    const [reused] = await materializePluginEntries([entry()], { materializers: { git } });
    expect(reused?.skillDiscovery).toBe('direct-children');
    expect(reused?.manifest?.path).toBe(path.join(entry().directory, 'plugin.json'));
    expect(git).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(workspace, 'cache', '.plugin-staging-'))).toBe(false);
  });

  it('routes an npm source to the npm materializer and falls back to recursive discovery', async () => {
    const npm = vi.fn(stage({ name: 'legacy' }, path.join('.claude-plugin', 'plugin.json')));

    const [installed] = await materializePluginEntries([entry({ source: npmSource })], { materializers: { npm } });

    expect(npm).toHaveBeenCalledOnce();
    expect(installed?.skillDiscovery).toBe('recursive');
  });

  it('refuses a materialized tree that carries no supported plugin manifest', async () => {
    const git = vi.fn(async (_source: unknown, staging: string) => {
      const sourceRoot = path.join(staging, 'source');
      fs.mkdirSync(sourceRoot, { recursive: true });
      return sourceRoot;
    });

    await expect(materializePluginEntries([entry()], { materializers: { git } })).rejects.toThrow(
      'does not contain a supported plugin manifest',
    );
    expect(fs.existsSync(entry().directory)).toBe(false);
  });

  it('refuses a plugin that ships the reserved cache metadata path', async () => {
    const git = vi.fn(async (_source: unknown, staging: string) => {
      const sourceRoot = path.join(staging, 'source');
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'plugin.json'), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA }));
      fs.writeFileSync(path.join(sourceRoot, '.doompi-plugin.json'), '{}');
      return sourceRoot;
    });

    await expect(materializePluginEntries([entry()], { materializers: { git } })).rejects.toThrow(
      'reserved cache metadata path',
    );
  });

  it('refuses a manifest that is not a JSON object', async () => {
    const git = vi.fn(stage([] as unknown as Record<string, unknown>, path.join('.claude-plugin', 'plugin.json')));

    await expect(materializePluginEntries([entry()], { materializers: { git } })).rejects.toThrow(
      'must contain a JSON object',
    );
  });

  it('refuses a cache directory that DoomPi did not write', async () => {
    const directory = path.join(workspace, 'cache', 'foreign');
    fs.mkdirSync(directory, { recursive: true });

    await expect(materializePluginEntries([entry({ directory })])).rejects.toThrow('not managed by DoomPi');
  });

  it('refuses a cache whose marker names a different source', async () => {
    const git = vi.fn(stage({ $schema: AGENT_PLUGIN_SCHEMA }));
    await materializePluginEntries([entry()], { materializers: { git } });

    await expect(
      materializePluginEntries([entry({ source: { ...gitSource, ref: 'main' } })], { materializers: { git } }),
    ).rejects.toThrow('cache metadata does not match');
  });

  it('refuses a cache path that is not a directory', async () => {
    const directory = path.join(workspace, 'cache', 'file');
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.writeFileSync(directory, 'not a directory');

    await expect(materializePluginEntries([entry({ directory })])).rejects.toThrow('cache path is not a directory');
  });

  it('refuses a materializer that returns something other than a directory', async () => {
    const git = vi.fn(async (_source: unknown, staging: string) => {
      const file = path.join(staging, 'source');
      fs.writeFileSync(file, 'not a directory');
      return file;
    });

    await expect(materializePluginEntries([entry()], { materializers: { git } })).rejects.toThrow(
      'Materialized plugin source is not a directory',
    );
  });
});
