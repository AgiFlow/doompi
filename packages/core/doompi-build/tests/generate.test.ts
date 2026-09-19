import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultPluginId, generateExtension } from '../src/services/generate';
import { doompiExtension } from '../src/services/tsdownPreset';
import { StaleGeneratedError, writeGenerated } from '../src/services/writeGenerated';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const EMPTY = 'export default {};\n';

function packageWith(files: Record<string, string>, name = '@agimon-ai/doompi-plan'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-generate-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
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
});

describe('doompiExtension', () => {
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
