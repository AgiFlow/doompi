import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, themeFromPiTheme } from '../../src/exports/theme.ts';

const TUI_THEME = fileURLToPath(new URL('../../../doompi-ui/themes/doom-pi-dark.json', import.meta.url));

describe('themeFromPiTheme', () => {
  it('turns the TUI theme DoomPi ships into the web palette the cockpit already uses', () => {
    const pi: unknown = JSON.parse(fs.readFileSync(TUI_THEME, 'utf8'));
    const theme = themeFromPiTheme(pi);
    expect(theme).not.toBeNull();
    expect(theme?.name).toBe('doom-pi-dark');
    expect(theme?.scheme).toBe('dark');
    for (const token of [
      'bg',
      'rail',
      'text',
      'dim',
      'faint',
      'blue',
      'green',
      'yellow',
      'red',
      'magenta',
      'violet',
      'cyan',
      'border',
      'selected',
    ] as const) {
      expect(theme?.tokens[token], token).toBe(DEFAULT_THEME.tokens[token]);
    }
    expect(theme?.tokens.deep).toContain('color-mix');
  });

  it('infers a light scheme from a bright background and honours overrides', () => {
    const theme = themeFromPiTheme(
      { name: 'paper', vars: { bg: '#fafafa', fg: '#383a42' } },
      { label: 'Paper', name: 'paper-light' },
    );
    expect(theme?.scheme).toBe('light');
    expect(theme?.label).toBe('Paper');
    expect(theme?.name).toBe('paper-light');
    expect(themeFromPiTheme({ vars: { bg: '#000' } }, { scheme: 'light' })).toBeNull();
    expect(themeFromPiTheme('nope')).toBeNull();
    expect(themeFromPiTheme({ vars: { bg: '#000000', fg: '#ffffff' } })?.scheme).toBe('dark');
  });
});
