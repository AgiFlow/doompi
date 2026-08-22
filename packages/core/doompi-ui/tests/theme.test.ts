import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentIdentityColor, DEFAULT_THEME, DEFAULT_THEME_NAME, writeDefaultTheme } from '../src/exports/theme.ts';

describe('Doom Pi theme', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-theme-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defines a resolvable Doom One palette', () => {
    const vars: Record<string, string> = DEFAULT_THEME.vars;
    const hex = /^#[0-9a-f]{6}$/;
    const entries = [...Object.entries(DEFAULT_THEME.colors), ...Object.entries(DEFAULT_THEME.export)];

    expect(DEFAULT_THEME.name).toBe(DEFAULT_THEME_NAME);
    expect(DEFAULT_THEME.vars).toMatchObject({
      bg: '#282c34',
      fg: '#bbc2cf',
      blue: '#51afef',
      green: '#98be65',
      orange: '#da8548',
      red: '#ff6c6b',
      magenta: '#c678dd',
      violet: '#a9a1e1',
    });
    expect(DEFAULT_THEME.colors).toMatchObject({
      accent: 'blue',
      success: 'green',
      warning: 'yellow',
      error: 'red',
      syntaxKeyword: 'blue',
      syntaxFunction: 'magenta',
      syntaxVariable: 'violet',
      syntaxString: 'green',
      syntaxOperator: 'orange',
    });
    for (const [key, value] of entries) {
      if (hex.test(value)) continue;
      expect(vars, `color "${key}" references an undeclared variable "${value}"`).toHaveProperty(value);
    }
    for (const [name, value] of Object.entries(vars)) {
      expect(value, `variable "${name}" is not a #rrggbb literal`).toMatch(hex);
    }
  });

  it('assigns stable palette colors to agent identities', () => {
    const allowed = ['accent', 'mdCode', 'toolDiffAdded', 'warning', 'mdHeading', 'syntaxNumber'];
    expect(allowed).toContain(agentIdentityColor('agent-a'));
    expect(agentIdentityColor('agent-a')).toBe(agentIdentityColor('agent-a'));
    expect(allowed).toContain(agentIdentityColor(''));
  });

  it('writes a private theme file', async () => {
    const themePath = await writeDefaultTheme(root);
    const parsed = JSON.parse(fs.readFileSync(themePath, 'utf8')) as typeof DEFAULT_THEME;

    expect(themePath).toBe(path.join(root, `${DEFAULT_THEME_NAME}.json`));
    expect(parsed).toEqual(DEFAULT_THEME);
    expect(fs.statSync(themePath).mode & 0o777).toBe(0o600);
  });
});

/**
 * The theme as a packaged resource.
 *
 * A consumer that installs the package, rather than building from this
 * checkout, discovers the theme through the manifest. That makes the shipped
 * JSON part of the package contract, not a build artifact.
 */
describe('packaged Doom Pi theme resource', () => {
  const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8')) as {
    files?: string[];
    exports?: Record<string, unknown>;
  };
  const themeExport = `./themes/${DEFAULT_THEME_NAME}.json`;

  it('declares the theme as a package export', () => {
    expect(manifest.exports?.[themeExport]).toBe(themeExport);
  });

  it('ships the themes directory in the published files allowlist', () => {
    expect(manifest.files).toContain('themes');
  });

  it('resolves the declared export to a file on disk', () => {
    expect(fs.existsSync(path.join(packageDirectory, themeExport))).toBe(true);
  });

  it('keeps the packaged theme identical to the source of truth', () => {
    // Generated from DEFAULT_THEME, so a palette edit that skips regeneration
    // fails here instead of shipping a stale theme to consumers. There is no
    // generator binary; `writeDefaultTheme` is the one, and it is what a
    // regeneration should go through so the on-disk shape cannot drift.
    const packaged = JSON.parse(fs.readFileSync(path.join(packageDirectory, themeExport), 'utf8')) as unknown;

    expect(packaged, `stale ${themeExport}: regenerate it with writeDefaultTheme()`).toEqual(DEFAULT_THEME);
  });

  it('keeps idea files out of the published allowlist', () => {
    // docs/ideas/** is repository material; an allowlist is what keeps it from
    // reaching a tarball.
    for (const entry of manifest.files ?? []) {
      expect(entry).not.toContain('ideas');
      expect(entry).not.toMatch(/\.pen$/);
    }
  });
});
