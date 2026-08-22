import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_THEME, DEFAULT_THEME_NAME, writeDefaultTheme } from '@agimon-ai/doompi-ui/theme';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('agent harness theme', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-theme-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defines the Doom-inspired default theme', () => {
    expect(DEFAULT_THEME.name).toBe(DEFAULT_THEME_NAME);
    expect(DEFAULT_THEME.colors.accent).toBe('blue');
  });

  // Pi rejects a theme whose color points at a variable that was never
  // declared, and silently keeps dead entries. Individual hues are a matter of
  // taste and are deliberately not pinned; resolvability is not.
  it('resolves every color and export to a declared variable or a hex literal', () => {
    const vars: Record<string, string> = DEFAULT_THEME.vars;
    const hex = /^#[0-9a-f]{6}$/;
    const entries = [...Object.entries(DEFAULT_THEME.colors), ...Object.entries(DEFAULT_THEME.export)];

    for (const [key, value] of entries) {
      if (hex.test(value)) continue;
      expect(vars, `color "${key}" references an undeclared variable "${value}"`).toHaveProperty(value);
    }

    for (const [name, value] of Object.entries(vars)) {
      expect(value, `variable "${name}" is not a #rrggbb literal`).toMatch(hex);
    }

    const referenced = new Set<string>(entries.map(([, value]) => value));
    expect(Object.keys(vars).filter((name) => !referenced.has(name))).toEqual([]);
  });

  it('writes the default theme into a temporary directory', async () => {
    const themePath = await writeDefaultTheme(root);
    const parsed = JSON.parse(fs.readFileSync(themePath, 'utf8')) as typeof DEFAULT_THEME;

    expect(themePath).toBe(path.join(root, `${DEFAULT_THEME_NAME}.json`));
    expect(parsed.name).toBe(DEFAULT_THEME_NAME);
    expect(fs.statSync(themePath).mode & 0o777).toBe(0o600);
  });
});
