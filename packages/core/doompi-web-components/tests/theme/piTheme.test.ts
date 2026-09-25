import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME, themeFromPiTheme } from '../../src/exports/theme';

const TUI_THEME = fileURLToPath(new URL('../../../../foundations/doompi-ui/themes/doom-pi-dark.json', import.meta.url));

describe('themeFromPiTheme', () => {
  it('preserves the shipped TUI palette while deriving web surfaces', () => {
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
    // Imported Pi palettes retain their dim value; web built-ins raise it for text contrast.
    expect(theme?.tokens.faint).toBe('#5b6268');
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
