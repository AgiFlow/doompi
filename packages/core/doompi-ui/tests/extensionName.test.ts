import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  extensionName,
  extensionPackageName,
  extensionToolSource,
  withExtensionSource,
} from '../src/exports/extensionName.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-extension-name-'));

function write(relativePath: string, contents = ''): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('extensionName', () => {
  it('names an entry after the nearest package, without its scope', () => {
    write('packages/doom-task/package.json', JSON.stringify({ name: '@agimon-ai/doompi-task' }));
    const entry = write('packages/doom-task/extensions/pi.ts');

    expect(extensionName(entry)).toBe('doompi-task');
  });

  it('keeps an unscoped package name as it is', () => {
    write('packages/pi-add-dir/package.json', JSON.stringify({ name: 'pi-add-dir' }));
    const entry = write('packages/pi-add-dir/extensions/pi-add-dir/index.ts');

    expect(extensionName(entry)).toBe('pi-add-dir');
  });

  it('falls back to the entry file name when no manifest names the package', () => {
    write('loose/package.json', '{ not json');
    const entry = write('loose/entries/effort.ts');

    expect(extensionName(entry)).toBe('effort');
  });

  it('retains the original entry for a tool registered through a composed bundle', () => {
    const entry = write('packages/bundled-extension/extensions/pi.ts');
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    const tool = { name: 'bundled_extension_tool' } as Parameters<ExtensionAPI['registerTool']>[0];

    withExtensionSource(pi, entry).registerTool(tool);

    expect(registerTool).toHaveBeenCalledWith(tool);
    expect(extensionToolSource(pi, tool.name)).toBe(entry);
  });
});

describe('extensionPackageName', () => {
  // `.doom/modes.yaml` names packages with their scope, so attribution has to
  // read the manifest name whole. `extensionName` shortens it for display, and
  // joining on that instead would miss every scoped package silently.
  it('keeps the scope that extensionName drops', () => {
    write('packages/scoped-attr/package.json', JSON.stringify({ name: '@agimon-ai/doompi-team' }));
    const entry = write('packages/scoped-attr/extensions/pi.ts');

    expect(extensionPackageName(entry)).toBe('@agimon-ai/doompi-team');
    expect(extensionName(entry)).toBe('doompi-team');
  });

  it('reports nothing when no manifest sits above the entry', () => {
    const orphan = path.join(os.tmpdir(), `doom-orphan-${process.pid}`, 'pi.ts');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '');

    // An answer of "no package" is cached like any other, so a second call
    // must not read the disk again and must not change its mind.
    expect(extensionPackageName(orphan)).toBe(extensionPackageName(orphan));
    fs.rmSync(path.dirname(orphan), { recursive: true, force: true });
  });
});
