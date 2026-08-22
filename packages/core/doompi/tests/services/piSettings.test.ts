import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AMBIENT_EXTENSION_FILTER,
  mergePiSettings,
  piAgentDirectory,
  piSettingsPath,
  readPiSettings,
  writePiSettings,
} from '../../src/exports/services/piSettings';

const UPDATE = {
  themePath: '/agent/themes/doom-pi-dark.json',
  themeName: 'doom-pi-dark',
};

const temporaryRoots: string[] = [];

function updateFor(agentDirectory: string): typeof UPDATE {
  return {
    themePath: path.join(agentDirectory, 'themes', 'doom-pi-dark.json'),
    themeName: UPDATE.themeName,
  };
}

function makeDirectory(settings?: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-settings-')));
  temporaryRoots.push(directory);
  if (settings !== undefined) fs.writeFileSync(piSettingsPath(directory), settings);
  return directory;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('piAgentDirectory', () => {
  it('uses Pi user configuration and honors its environment override', () => {
    expect(piAgentDirectory({}, '/home/test')).toBe(path.join('/home/test', '.pi', 'agent'));
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: '~' }, '/home/test')).toBe('/home/test');
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: '~/custom' }, '/home/test')).toBe(path.join('/home/test', 'custom'));
    expect(piAgentDirectory({ PI_CODING_AGENT_DIR: '/var/pi' }, '/home/test')).toBe('/var/pi');
  });
});

describe('mergePiSettings', () => {
  it('writes the stable package entry and a portable user-theme path', () => {
    const merged = mergePiSettings({}, '/agent', UPDATE);

    expect(merged.quietStartup).toBe(true);
    expect(merged.extensions).toEqual(['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER]);
    expect(merged.themes).toEqual(['themes/doom-pi-dark.json']);
  });

  it('keeps an absolute theme path outside the Pi agent directory', () => {
    const merged = mergePiSettings({}, '/agent', {
      themePath: '/shared/themes/doom-pi-dark.json',
      themeName: UPDATE.themeName,
    });

    expect(merged.themes).toEqual(['/shared/themes/doom-pi-dark.json']);
  });

  it('enables quiet startup while leaving unrelated hand-written keys alone', () => {
    const merged = mergePiSettings({ quietStartup: false, subagents: { agentOverrides: {} } }, '/agent', UPDATE);

    expect(merged.quietStartup).toBe(true);
    expect(merged.subagents).toEqual({ agentOverrides: {} });
  });

  it('adds its stable entry without classifying other extension paths', () => {
    const existing = ['../repo/local-doompi.mjs', './mine.ts'];
    const merged = mergePiSettings(
      { extensions: existing, themes: ['/repo/.pi/doom/doom-pi-dark.json', './mine.json'] },
      '/agent',
      UPDATE,
    );

    expect(merged.extensions).toEqual(['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER, ...existing]);
    expect(merged.themes).toEqual(['themes/doom-pi-dark.json', './mine.json']);
  });

  it('loads first without duplicating its package entry or ambient-discovery filter', () => {
    const merged = mergePiSettings(
      { extensions: ['./mine.ts', AMBIENT_EXTENSION_FILTER, '@agimon-ai/doompi'] },
      '/agent',
      UPDATE,
    );

    expect(merged.extensions).toEqual(['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER, './mine.ts']);
  });

  it('keeps a theme the user picked rather than reimposing the Doom one', () => {
    expect(mergePiSettings({ theme: 'light' }, '/agent', UPDATE).theme).toBe('light');
    expect(mergePiSettings({}, '/agent', UPDATE).theme).toBe('doom-pi-dark');
  });
});

describe('writePiSettings', () => {
  it('treats non-object Pi settings as empty', () => {
    const agentDirectory = makeDirectory('[]\n');

    expect(readPiSettings(agentDirectory)).toEqual({});
  });

  it('creates the user file without replacing unrelated settings', () => {
    const agentDirectory = makeDirectory('{"defaultProvider":"anthropic"}\n');

    const settingsPath = writePiSettings(agentDirectory, updateFor(agentDirectory));

    expect(settingsPath).toBe(piSettingsPath(agentDirectory));
    expect(readPiSettings(agentDirectory)).toMatchObject({
      defaultProvider: 'anthropic',
      quietStartup: true,
      extensions: ['@agimon-ai/doompi', AMBIENT_EXTENSION_FILTER],
      themes: ['themes/doom-pi-dark.json'],
    });
  });

  it('is repeatable, so a second sync produces the same file', () => {
    const agentDirectory = makeDirectory('{\n  "quietStartup": true\n}\n');

    writePiSettings(agentDirectory, updateFor(agentDirectory));
    const first = fs.readFileSync(piSettingsPath(agentDirectory), 'utf8');
    writePiSettings(agentDirectory, updateFor(agentDirectory));

    expect(fs.readFileSync(piSettingsPath(agentDirectory), 'utf8')).toBe(first);
  });
});
