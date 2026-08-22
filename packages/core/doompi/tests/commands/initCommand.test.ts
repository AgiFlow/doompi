import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piExtensionAliasPath } from '../../src/adapters/piExtensionAlias.ts';
import { AMBIENT_EXTENSION_FILTER, DOOM_EXTENSION, readPiSettings } from '../../src/adapters/piSettings.ts';
import { InitCommand } from '../../src/commands/initCommand.ts';

const temporaryRoots: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-init-command-'));
  temporaryRoots.push(home);
  return home;
}

function streamedText(output: { write: ReturnType<typeof vi.fn> }): string {
  return output.write.mock.calls.flat().join('');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('InitCommand', () => {
  it('matches only the literal init first token', () => {
    const command = new InitCommand();

    expect(command.matches(['init'])).toBe(true);
    expect(command.matches(['init', '--force'])).toBe(true);
    expect(command.matches(['initialize'])).toBe(false);
    expect(command.matches([])).toBe(false);
  });

  it('streams a branded setup, initializes Pi, and explains the next steps', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn() };
    const command = new InitCommand();
    const doomDirectory = path.join(home, '.pi', '.doom');
    const agentDirectory = path.join(home, '.pi', 'agent');

    await expect(command.execute(['init'], home, output, {})).resolves.toBe(0);

    const text = streamedText(output);
    expect(output.write.mock.calls.length).toBeGreaterThan(5);
    expect(text).not.toContain('\u001B[');
    expect(text).toContain('BOOT / INIT');
    expect(text).toContain('DOOM PI  INITIALIZE');
    expect(text).toContain('[1/2] WRITE CONFIGURATION');
    expect(text).toContain(`[2/2] REGISTER WITH PI`);
    expect(text).toContain(`TARGET  ${doomDirectory}`);
    expect(text).toContain(`TARGET  ${agentDirectory}`);
    expect(text).toContain(`PI GLOBAL SETTINGS\n  ${path.join(agentDirectory, 'settings.json')}`);
    expect(text.indexOf('PI GLOBAL SETTINGS')).toBeLessThan(text.lastIndexOf('\nDOOMPI CONFIGURATION\n'));
    expect(text).toMatch(/CREATED\s+config\.yaml\s+— project trust and optional voice defaults/);
    expect(text).toMatch(/CREATED\s+modes\.yaml\s+— layers, packages, and the default major mode/);
    expect(text).toMatch(/CREATED\s+domains\.yaml\s+— plugin catalog, domain groups, and aliases/);
    expect(text).toMatch(/CREATED\s+profiles\.yaml\s+— profile roots, personas, and string environment defaults/);
    expect(text).toContain(`01  Open ${doomDirectory}.`);
    expect(text).toContain('doompi sync');
    expect(text).toContain('━━━━━━━━ READY  Edit your config, then sync it.');

    expect(readPiSettings(agentDirectory)).toEqual({
      quietStartup: true,
      extensions: [DOOM_EXTENSION, AMBIENT_EXTENSION_FILTER],
      themes: ['themes/doom-pi-dark.json'],
      theme: 'doom-pi-dark',
    });
    expect(fs.lstatSync(piExtensionAliasPath(agentDirectory)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(agentDirectory, 'themes', 'doom-pi-dark.json'))).toBe(true);
    expect(fs.existsSync(path.join(doomDirectory, 'hooks.yaml'))).toBe(false);
    const domainsTemplate = fs.readFileSync(path.join(doomDirectory, 'domains.yaml'), 'utf8');
    expect(domainsTemplate).toContain('plugins:\n  roots: []\n  entries: {}');
    expect(domainsTemplate).toContain('description: Shared skills and repository MCP only.');
    expect(domainsTemplate).toContain('#     - development');
    expect(domainsTemplate).toContain('#     - name: remote-review');

    output.write.mockClear();
    await expect(command.execute(['init'], home, output, {})).resolves.toBe(0);

    const repeatedText = streamedText(output);
    expect(repeatedText).toContain('No settings edits were needed; DoomPi entries were already current.');
    expect(repeatedText).toContain('KEPT     config.yaml');
    expect(repeatedText).toContain('KEPT     modes.yaml');
    expect(repeatedText).toContain('KEPT     domains.yaml');
    expect(repeatedText).toContain('KEPT     profiles.yaml');
    expect(repeatedText).toContain('KEPT files retain your existing edits.');
  });

  it('preserves unrelated Pi settings and an existing theme selection', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn() };
    const command = new InitCommand();
    const agentDirectory = path.join(home, 'custom-pi');
    fs.mkdirSync(agentDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(agentDirectory, 'settings.json'),
      `${JSON.stringify({
        defaultProvider: 'anthropic',
        quietStartup: false,
        extensions: ['./mine.ts'],
        themes: ['./mine.json'],
        theme: 'light',
        subagents: { agentOverrides: {} },
      })}\n`,
    );

    await expect(command.execute(['init'], home, output, { PI_CODING_AGENT_DIR: '~/custom-pi' })).resolves.toBe(0);

    expect(readPiSettings(agentDirectory)).toEqual({
      defaultProvider: 'anthropic',
      quietStartup: true,
      extensions: [DOOM_EXTENSION, AMBIENT_EXTENSION_FILTER, './mine.ts'],
      themes: ['themes/doom-pi-dark.json', './mine.json'],
      theme: 'light',
      subagents: { agentOverrides: {} },
    });
    const text = streamedText(output);
    expect(text).toContain(`PI GLOBAL SETTINGS\n  ${path.join(agentDirectory, 'settings.json')}`);
    expect(text).toContain('Updated 3 managed keys. Unrelated settings were preserved.');
    expect(text).toMatch(/READY\s+theme:\s+kept your existing selection "light"/);
  });

  it('uses the Doom One palette for an interactive terminal', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn(), isTTY: true };
    const command = new InitCommand();

    await expect(command.execute(['init'], home, output, { TERM: 'xterm-256color' })).resolves.toBe(0);

    const text = streamedText(output);
    expect(text).toContain('\u001B[38;2;81;175;239m');
    expect(text).toContain('48;2;81;175;239m PI ');
    expect(text).toContain('\u001B[1;38;2;198;120;221m');
    expect(text).toContain('\u001B[1;38;2;152;190;101m');
    expect(text).toContain('\u001B[38;2;70;217;255m');
    expect(text).toContain('\u001B[0m');
  });

  it('honors NO_COLOR even for an interactive terminal', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn(), isTTY: true };
    const command = new InitCommand();

    await expect(command.execute(['init'], home, output, { NO_COLOR: '1', TERM: 'xterm-256color' })).resolves.toBe(0);

    expect(streamedText(output)).not.toContain('\u001B[');
  });

  it('rejects unknown arguments before writing output or touching the home directory', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn() };
    const command = new InitCommand();

    await expect(command.execute(['init', '--wipe'], home, output, {})).rejects.toThrow(
      'doompi init does not accept --wipe',
    );
    expect(output.write).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.pi'))).toBe(false);
  });

  it('leaves hand-edited config alone until --force is passed', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn() };
    const command = new InitCommand();
    const configPath = path.join(home, '.pi', '.doom', 'config.yaml');

    await expect(command.execute(['init'], home, output, {})).resolves.toBe(0);
    fs.writeFileSync(configPath, 'projectTrust: never\n');

    await expect(command.execute(['init'], home, output, {})).resolves.toBe(0);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('projectTrust: never\n');

    output.write.mockClear();
    await expect(command.execute(['init', '--force'], home, output, {})).resolves.toBe(0);

    expect(fs.readFileSync(configPath, 'utf8')).not.toBe('projectTrust: never\n');
    const text = streamedText(output);
    expect(text).toContain('REPLACED config.yaml');
    expect(text).toContain('REPLACED modes.yaml');
    expect(text).toContain('REPLACED domains.yaml');
    expect(text).toContain('REPLACED profiles.yaml');
    expect(text).toContain('because --force was used');
  });

  it('reports the failed configuration stage and does not begin Pi registration', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn() };
    const directory = path.join(home, '.pi', '.doom');
    fs.mkdirSync(path.join(directory, 'modes.yaml'), { recursive: true });
    const command = new InitCommand();

    await expect(command.execute(['init'], home, output, {})).rejects.toThrow(
      `doompi init failed while writing configuration at ${directory}`,
    );

    const text = streamedText(output);
    expect(text).toContain('● FAILED Configuration setup failed.');
    expect(text).not.toContain('[2/2]');
    expect(fs.existsSync(path.join(home, '.pi', 'agent', 'settings.json'))).toBe(false);
  });

  it('reports Pi registration failures while retaining generated configuration', async () => {
    const home = temporaryHome();
    const output = { write: vi.fn(), isTTY: true };
    const command = new InitCommand();
    const doomDirectory = path.join(home, '.pi', '.doom');
    const agentDirectory = path.join(home, '.pi', 'agent');
    fs.mkdirSync(piExtensionAliasPath(agentDirectory), { recursive: true });

    await expect(command.execute(['init'], home, output, { TERM: 'xterm-256color' })).rejects.toThrow(
      `doompi init failed while registering with Pi at ${agentDirectory}`,
    );

    const text = streamedText(output);
    expect(text).toContain('Pi integration failed.');
    expect(text).toContain('\u001B[1;38;2;255;108;107m● FAILED\u001B[0m');
    expect(text).toContain(`Your DoomPi configuration remains at ${doomDirectory}.`);
    expect(fs.existsSync(path.join(doomDirectory, 'modes.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentDirectory, 'settings.json'))).toBe(false);
  });
});
