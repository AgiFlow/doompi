import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookDocumentReader } from '../../src/adapters/hookDocuments.ts';
import { HOOK_TELEMETRY_EVENT } from '../../src/types/telemetry.ts';
import { recordingTelemetry } from '../helpers/telemetry.ts';

const REGISTRY = (command: string): string =>
  [
    'groups:',
    '  safety:',
    '    core: true',
    '    hooks:',
    '      - event: PreToolUse',
    '        pi:',
    `          command: ${command}`,
  ].join('\n');

let home = '';
let repoRoot = '';

function writeRegistry(directory: string, contents: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'hooks.yaml');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function writeRepositoryRegistry(contents: string): string {
  return writeRegistry(path.join(repoRoot, '.doom'), contents);
}

/** The global registry lives beside the rest of the user's Pi configuration. */
function writeGlobalRegistry(contents: string): string {
  return writeRegistry(path.join(home, '.pi', '.doom'), contents);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-hook-repo-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('registry documents', () => {
  it('reads the repository registry from disk', async () => {
    writeRepositoryRegistry(REGISTRY('guard'));
    const reader = createHookDocumentReader({ homeDirectory: home });

    const read = await reader.registry(repoRoot);

    expect(read.failure).toBeUndefined();
    expect(read.entries.map((entry) => entry.command)).toEqual(['guard']);
    expect(read.entries[0]?.baseDirectory).toBe(repoRoot);
  });

  it('layers the global registry under the repository one', async () => {
    writeGlobalRegistry(
      'groups:\n  global:\n    hooks:\n      - event: Stop\n        pi:\n          command: global\n',
    );
    writeRepositoryRegistry(REGISTRY('guard'));
    const reader = createHookDocumentReader({ homeDirectory: home });

    const read = await reader.registry(repoRoot);

    expect(read.entries.map((entry) => entry.command)).toEqual(['global', 'guard']);
  });

  it('treats a registry absent from both locations as no hooks rather than a failure', async () => {
    const reader = createHookDocumentReader({ homeDirectory: home });

    expect(await reader.registry(repoRoot)).toEqual({ entries: [] });
  });

  it('reports a registry that exists but cannot be parsed', async () => {
    const registryPath = writeRepositoryRegistry('groups:\n  core:\n   - : :\n');
    const warnings: string[] = [];
    const { telemetry, records } = recordingTelemetry();
    const reader = createHookDocumentReader({ homeDirectory: home, telemetry, warn: (m) => warnings.push(m) });

    const read = await reader.registry(repoRoot);

    expect(read.entries).toEqual([]);
    expect(read.failure?.reason).toBe('registry_read');
    expect(read.failure?.command).toContain(registryPath);
    expect(records).toEqual([
      {
        level: 'error',
        event: HOOK_TELEMETRY_EVENT.hookRegistryReadFailed,
        attributes: { 'hook.registry.source': 'repository' },
      },
    ]);
    expect(warnings[0]).toContain('[pi-hook] could not read');
  });

  it('reports a registry that exists but cannot be read', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const reader = createHookDocumentReader({
      homeDirectory: home,
      warn: () => undefined,
      readFile: () => Promise.reject(failure),
    });

    expect((await reader.registry(repoRoot)).failure?.message).toBe('permission denied');
  });

  it('parses once while the registry is unchanged and again after it is rewritten', async () => {
    writeRepositoryRegistry(REGISTRY('cache-probe'));
    const reader = createHookDocumentReader({ homeDirectory: home });

    const first = await reader.registry(repoRoot);
    const second = await reader.registry(repoRoot);
    writeRepositoryRegistry(REGISTRY('cache-probe-replaced'));
    const third = await reader.registry(repoRoot);

    expect(second.entries).toBe(first.entries);
    expect(third.entries).not.toBe(first.entries);
    expect(third.entries.map((entry) => entry.command)).toEqual(['cache-probe-replaced']);
  });
});

describe('plugin documents', () => {
  it('parses each plugin config and tags it with its plugin root', async () => {
    const configPath = path.join(repoRoot, 'hooks.json');
    fs.writeFileSync(configPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'audit' }] }] } }));
    const reader = createHookDocumentReader({ homeDirectory: home });

    const read = await reader.plugins([{ pluginRoot: repoRoot, configPath }]);

    expect(read.failures).toEqual([]);
    expect(read.documents).toEqual([
      { pluginRoot: repoRoot, config: { hooks: { PreToolUse: [{ hooks: [{ command: 'audit' }] }] } } },
    ]);
  });

  it('reuses the last parse of identical content and reparses a rewrite', async () => {
    const configPath = path.join(repoRoot, 'hooks.json');
    fs.writeFileSync(configPath, JSON.stringify({ hooks: {} }));
    const reader = createHookDocumentReader({ homeDirectory: home });
    const sources = [{ pluginRoot: repoRoot, configPath }];

    const first = await reader.plugins(sources);
    const second = await reader.plugins(sources);
    fs.writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [] } }));
    const third = await reader.plugins(sources);

    expect(second.documents[0]?.config).toBe(first.documents[0]?.config);
    expect(third.documents[0]?.config).not.toBe(first.documents[0]?.config);
  });

  it('reports one failure per unreadable config and keeps the readable ones', async () => {
    const broken = path.join(repoRoot, 'broken.json');
    const working = path.join(repoRoot, 'working.json');
    fs.writeFileSync(broken, '{invalid');
    fs.writeFileSync(working, JSON.stringify({ hooks: {} }));
    const reader = createHookDocumentReader({ homeDirectory: home });

    const read = await reader.plugins([
      { pluginRoot: repoRoot, configPath: broken },
      { pluginRoot: repoRoot, configPath: path.join(repoRoot, 'missing.json') },
      { pluginRoot: repoRoot, configPath: working },
    ]);

    expect(read.documents).toHaveLength(1);
    expect(read.failures.map((failure) => failure.reason)).toEqual(['plugin_config', 'plugin_config']);
    expect(read.failures[0]?.command).toBe(broken);
  });

  it('writes registry read failures to stderr when no warn sink is supplied', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRepositoryRegistry('groups:\n  core:\n   - : :\n');
    const reader = createHookDocumentReader({ homeDirectory: home });

    await reader.registry(repoRoot);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[pi-hook] could not read'));
    stderr.mockRestore();
  });
});
