import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'tsdown';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultPluginId, generateExtension } from '../src/services/generate';
import { doompiExtension } from '../src/services/tsdownPreset';
import { StaleGeneratedError, writeGenerated } from '../src/services/writeGenerated';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const EMPTY = 'export default {};\n';

function packageWith(files: Record<string, string>, name = '@agimon-ai/doompi-plan', manifest: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-generate-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, name }));
  for (const relative of Object.keys(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, files[relative] as string);
  }
  return dir;
}

const read = (dir: string, relative: string): string => fs.readFileSync(path.join(dir, relative), 'utf8');
const exists = (dir: string, relative: string): boolean => fs.existsSync(path.join(dir, relative));

describe('defaultPluginId', () => {
  it('strips the scope and the doompi prefix', () => {
    expect(defaultPluginId('@agimon-ai/doompi-plan')).toBe('plan');
    expect(defaultPluginId('@acme/my-extension')).toBe('my-extension');
    expect(defaultPluginId('doompi-grep')).toBe('grep');
  });
});

describe('generateExtension', () => {
  it('writes an entry for each host the tree contributes to', () => {
    const dir = packageWith({
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      'src/extensions/(backend)/tool/grep.server.ts': EMPTY,
      'src/extensions/(frontend)/tool/grep.web.tsx': EMPTY,
    });
    const result = generateExtension({ packageDir: dir });

    expect(result.targets).toEqual(['cli', 'server', 'web']);
    for (const entry of ['pi.ts', 'server.ts', 'web.ts']) expect(exists(dir, `generated/${entry}`)).toBe(true);
  });

  it('writes no cockpit entry for a package with no browser half', () => {
    const dir = packageWith({
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      'src/extensions/(backend)/tool/grep.server.ts': EMPTY,
    });
    const result = generateExtension({ packageDir: dir });

    expect(result.targets).toEqual(['cli', 'server']);
    expect(exists(dir, 'generated/web.ts')).toBe(false);
  });

  it('writes a host entry when the host has only a scope root', () => {
    const dir = packageWith({ 'src/extensions/workspaces/sessions/(backend)/root.cli.ts': EMPTY });
    const result = generateExtension({ packageDir: dir });

    expect(result.targets).toEqual(['cli']);
    expect(exists(dir, 'generated/pi.ts')).toBe(true);
    expect(exists(dir, 'generated/server.ts')).toBe(false);
  });

  it('admits a template-only package through Pi without adding agent capabilities', () => {
    const route = 'src/extensions/(frontend)/template/example-layout.web.tsx';
    const dir = packageWith({ [route]: EMPTY }, '@example/independent-template');
    const result = generateExtension({ packageDir: dir });
    expect(result.targets).toEqual(['cli', 'web']);
    expect(result.notices).toEqual([]);
    expect(read(dir, 'generated/web.ts')).toContain("get templates(): WebPluginContributions['templates']");
    expect(read(dir, 'generated/web.ts')).toContain("id: 'example-layout'");
    const pi = read(dir, 'generated/pi.ts');
    expect(pi).toContain("definePiExtension('@example/independent-template'");
    expect(pi).not.toMatch(/tools:|minorModes:|templateExampleLayout/);
    expect(exists(dir, 'generated/server.ts')).toBe(false);
    fs.rmSync(path.join(dir, route));
    generateExtension({ packageDir: dir });
    expect(exists(dir, 'generated/pi.ts')).toBe(false);
  });
  it('writes no backend entries for a cockpit-only package', () => {
    const dir = packageWith({ 'src/extensions/(frontend)/tab/Panel.web.tsx': EMPTY });
    const result = generateExtension({ packageDir: dir });

    expect(result.targets).toEqual(['web']);
    expect(exists(dir, 'generated/pi.ts')).toBe(false);
    expect(exists(dir, 'generated/server.ts')).toBe(false);
  });

  it('takes the package name and plugin id from package.json', () => {
    const dir = packageWith({ 'src/extensions/(frontend)/tab/Panel.web.tsx': EMPTY }, '@agimon-ai/doompi-task');
    const result = generateExtension({ packageDir: dir });

    expect(result.packageName).toBe('@agimon-ai/doompi-task');
    expect(result.pluginId).toBe('task');
    expect(read(dir, 'generated/web.ts')).toContain("id: 'task',");
  });

  it('reports a second run as unchanged, so a watcher is not retriggered', () => {
    const dir = packageWith({
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      'src/extensions/(backend)/tool/grep.server.ts': EMPTY,
    });
    expect(generateExtension({ packageDir: dir }).changed).toHaveLength(2);
    expect(generateExtension({ packageDir: dir }).changed).toEqual([]);
  });

  it('gathers scan and resolution notices instead of throwing', () => {
    const dir = packageWith({
      'src/extensions/(frontend)/tabs/Panel.tsx': EMPTY,
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
    });
    const result = generateExtension({ packageDir: dir });

    expect(result.notices).toHaveLength(1);
    expect(exists(dir, 'generated/pi.ts')).toBe(true);
  });

  it('reports a platform this build has no host for, once, without dropping the rest', () => {
    const dir = packageWith({
      'src/extensions/(frontend)/tab/Panel.ios.tsx': EMPTY,
      'src/extensions/(frontend)/tab/Panel.web.tsx': EMPTY,
    });
    const result = generateExtension({ packageDir: dir });

    expect(result.notices).toEqual([
      {
        path: 'src/extensions/(frontend)/tab/Panel.ios.tsx',
        message:
          "'ios' is a forward-looking platform with no build target; this file is not emitted for cli, server, web or mcp",
      },
    ]);
    expect(read(dir, 'generated/web.ts')).not.toContain('Panel.ios');
  });

  it('does nothing at all for a package with no routing root', () => {
    const dir = packageWith({ 'src/services/thing/index.ts': EMPTY });
    const result = generateExtension({ packageDir: dir });

    expect(result.targets).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('removes an obsolete generated target when its last contribution disappears', () => {
    const dir = packageWith({ 'src/extensions/(frontend)/tab/Panel.web.tsx': EMPTY });
    generateExtension({ packageDir: dir });
    expect(exists(dir, 'generated/web.ts')).toBe(true);

    fs.rmSync(path.join(dir, 'src/extensions/(frontend)/tab/Panel.web.tsx'));
    const result = generateExtension({ packageDir: dir });

    expect(result.changed).toEqual(['generated/web.ts']);
    expect(exists(dir, 'generated/web.ts')).toBe(false);
  });

  it('removes a stale MCP entry when the package no longer has an MCP build', () => {
    const dir = packageWith({
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      'generated/mcp.ts': EMPTY,
    });

    generateExtension({ packageDir: dir });

    expect(exists(dir, 'generated/mcp.ts')).toBe(false);
  });
});

describe('doompiExtension', () => {
  it('removes the final MCP target without passing an empty entry to tsdown', async () => {
    const file = 'src/extensions/workspaces/sessions/(backend)/tool/example.mcp.ts';
    const dir = packageWith({
      [file]: EMPTY,
      'dist/extensions/mcp.mjs': EMPTY,
      'dist/extensions/mcp.cjs.map': EMPTY,
      'dist/extensions/mcp.d.mts': EMPTY,
      'dist/extensions/mcp.d.cts.map': EMPTY,
      'dist/extensions/pi.mjs': EMPTY,
      'generated/pi.ts': EMPTY,
    });
    const config = doompiExtension({ packageDir: dir, target: 'mcp' });
    expect(Array.isArray(config)).toBe(false);
    if (Array.isArray(config)) throw new Error('expected MCP config');
    config.hooks?.['build:done']();
    expect(JSON.parse(read(dir, 'package.json')).doompiMcp).toBeDefined();
    // Simulate the artifacts emitted by the first build.
    for (const suffix of ['mjs', 'cjs.map', 'd.mts', 'd.cts.map']) {
      fs.writeFileSync(path.join(dir, `dist/extensions/mcp.${suffix}`), EMPTY);
    }
    fs.rmSync(path.join(dir, file));
    const empty = doompiExtension({ packageDir: dir, target: 'mcp' });
    expect(Array.isArray(empty)).toBe(false);
    if (Array.isArray(empty)) throw new Error('expected no-op MCP config');
    expect(empty.write).toBe(false);
    await build({ ...empty, cwd: dir, config: false, logLevel: 'silent' });
    expect(JSON.parse(read(dir, 'package.json')).doompiMcp).toBeUndefined();
    expect(exists(dir, 'generated/mcp.ts')).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'dist/extensions'))).toEqual(['pi.mjs']);
    expect(read(dir, 'generated/pi.ts')).toBe(EMPTY);
  });

  it('keeps normal unbundled modules after an MCP-only build', async () => {
    const dir = packageWith({
      'src/exports/index.ts': "export { cliValue } from '../services/shared';\n",
      'src/services/shared.ts': "export const cliValue = 'cli';\nexport const mcpValue = 'mcp';\n",
      'src/extensions/workspaces/sessions/(backend)/tool/example.mcp.ts':
        "import { mcpValue } from '../../../../../services/shared';\nexport default mcpValue;\n",
    });
    const normal = doompiExtension({ packageDir: dir });
    const mcp = doompiExtension({ packageDir: dir, target: 'mcp' });
    expect(Array.isArray(normal)).toBe(false);
    expect(Array.isArray(mcp)).toBe(false);
    if (Array.isArray(normal) || Array.isArray(mcp)) throw new Error('expected node configs');

    await build({ ...normal, cwd: dir, config: false, dts: false, logLevel: 'silent' });
    await build({ ...mcp, cwd: dir, config: false, dts: false, logLevel: 'silent' });

    expect(exists(dir, 'dist/extensions/mcp.mjs')).toBe(true);
    await expect(import(pathToFileURL(path.join(dir, 'dist/index.mjs')).href)).resolves.toMatchObject({
      cliValue: 'cli',
    });
  });

  it('cleans renamed MCP modules and maps while preserving normal build outputs', () => {
    const dir = packageWith({
      'src/extensions/workspaces/sessions/(backend)/tool/renamed.mcp.ts': EMPTY,
      'dist/extensions/mcp.mjs': EMPTY,
      'dist/tool/deleted.mcp.mjs': EMPTY,
      'dist/tool/deleted.mcp.mjs.map': EMPTY,
      'dist/tool/deleted.mcp.d.mts': EMPTY,
      'dist/tool/deleted.mcp.d.mts.map': EMPTY,
      'dist/tool/deleted.mcp.cjs': EMPTY,
      'dist/tool/deleted.mcp.d.cts': EMPTY,
      'dist/tool/normal.server.mjs': EMPTY,
      'dist/tool/mcp.mjs': EMPTY,
      'dist/tool/deleted.mcp.json': EMPTY,
      'dist/index.mjs': EMPTY,
    });
    const config = doompiExtension({ packageDir: dir, target: 'mcp' });
    expect(Array.isArray(config)).toBe(false);
    expect(read(dir, 'generated/mcp.ts')).toContain('renamed.mcp');
    expect(fs.readdirSync(path.join(dir, 'dist/tool')).sort()).toEqual([
      'deleted.mcp.json',
      'mcp.mjs',
      'normal.server.mjs',
    ]);
    expect(read(dir, 'dist/index.mjs')).toBe(EMPTY);
  });

  it('exports root skills and theme resources without treating them as build entries', () => {
    const dir = packageWith({
      'src/exports/index.ts': EMPTY,
      'skills/workflow-recovery/SKILL.md': '# Recovery\n',
      'themes/doom-pi-dark.json': '{}\n',
    });
    const config = doompiExtension({ packageDir: dir });
    expect(Array.isArray(config)).toBe(false);
    if (Array.isArray(config) || typeof config.exports === 'boolean') throw new Error('expected generated exports');

    expect(config.exports.customExports({ '.': { import: './dist/index.mjs' } })).toMatchObject({
      './skills/workflow-recovery/SKILL.md': './skills/workflow-recovery/SKILL.md',
      './themes/doom-pi-dark.json': './themes/doom-pi-dark.json',
    });
  });

  it('does not clean outputs or change metadata in check mode', () => {
    const dir = packageWith({ 'dist/extensions/mcp.mjs': EMPTY });
    const manifest = read(dir, 'package.json');
    expect(doompiExtension({ packageDir: dir, target: 'mcp', check: true })).toMatchObject({ write: false });
    expect(read(dir, 'dist/extensions/mcp.mjs')).toBe(EMPTY);
    expect(read(dir, 'package.json')).toBe(manifest);
  });

  it('generates ignored entries during CI builds unless check mode is explicit', () => {
    const dir = packageWith({
      'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      'src/extensions/(backend)/tool/grep.server.ts': EMPTY,
    });
    const previous = process.env.CI;
    process.env.CI = '1';
    try {
      expect(() => doompiExtension({ packageDir: dir })).not.toThrow();
      expect(exists(dir, 'generated/pi.ts')).toBe(true);
      expect(exists(dir, 'generated/server.ts')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CI;
      else process.env.CI = previous;
    }
  });
});

describe('the staleness contract', () => {
  it('throws under check when a generated entry is out of date, and writes nothing', () => {
    const dir = packageWith({ 'src/extensions/(backend)/tool/grep.cli.ts': EMPTY });
    generateExtension({ packageDir: dir });

    fs.writeFileSync(path.join(dir, 'generated/pi.ts'), '// hand-edited\n');
    expect(() => generateExtension({ packageDir: dir, check: true })).toThrow(StaleGeneratedError);
    expect(read(dir, 'generated/pi.ts')).toBe('// hand-edited\n');
  });

  it('passes under check when the committed entries match the tree', () => {
    const dir = packageWith({ 'src/extensions/(backend)/tool/grep.cli.ts': EMPTY });
    generateExtension({ packageDir: dir });
    expect(() => generateExtension({ packageDir: dir, check: true })).not.toThrow();
  });

  it('names every stale file so the message is actionable', () => {
    const dir = packageWith({ 'src/extensions/(backend)/tool/grep.cli.ts': EMPTY });
    try {
      writeGenerated(
        dir,
        new Map([
          ['a.ts', 'x'],
          ['b.ts', 'y'],
        ]),
        true,
      );
      expect.unreachable('expected a StaleGeneratedError');
    } catch (error) {
      expect((error as StaleGeneratedError).stale).toEqual(['a.ts', 'b.ts']);
    }
  });

  it('creates missing directories when it writes', () => {
    const dir = packageWith({});
    writeGenerated(dir, new Map([['deep/nested/file.ts', 'contents']]));
    expect(read(dir, 'deep/nested/file.ts')).toBe('contents');
  });
});
