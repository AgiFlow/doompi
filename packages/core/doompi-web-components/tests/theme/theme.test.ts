import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  BUILTIN_THEMES,
  builtinTheme,
  DEFAULT_THEME,
  DEFAULT_THEME_NAME,
  derivedFallback,
  parseThemeConfig,
  readThemePreference,
  THEME_STORAGE_KEY,
  themeCssText,
  themeCssVariables,
  themeVariable,
  writeThemePreference,
} from '../../src/exports/theme.ts';
import { PALETTE_TOKENS, THEME_TOKENS } from '../../src/types/theme.ts';

describe('shipped themes', () => {
  it('ships the Doom One dark palette as the default', () => {
    expect(DEFAULT_THEME_NAME).toBe('doom-one-dark');
    expect(DEFAULT_THEME.tokens.bg).toBe('#282c34');
    expect(DEFAULT_THEME.tokens.blue).toBe('#51afef');
    expect(builtinTheme('doom-one-dark')).toBe(DEFAULT_THEME);
    expect(builtinTheme('nope')).toBeUndefined();
  });

  it('has unique names and a complete palette in every theme', () => {
    const names = BUILTIN_THEMES.map((theme) => theme.name);
    expect(new Set(names).size).toBe(names.length);
    for (const theme of BUILTIN_THEMES) {
      for (const token of PALETTE_TOKENS)
        expect(theme.tokens[token], `${theme.name}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('parseThemeConfig', () => {
  const valid = { ...DEFAULT_THEME, tokens: { ...DEFAULT_THEME.tokens } };

  it('accepts a complete config and trims values', () => {
    const parsed = parseThemeConfig({ ...valid, tokens: { ...valid.tokens, bg: ' #101010 ' } });
    expect(parsed?.tokens.bg).toBe('#101010');
  });

  it('rejects a missing palette token, a bad name, and a bad scheme', () => {
    const { bg: _bg, ...withoutBg } = valid.tokens;
    expect(parseThemeConfig({ ...valid, tokens: withoutBg })).toBeNull();
    expect(parseThemeConfig({ ...valid, name: 'Not Kebab' })).toBeNull();
    expect(parseThemeConfig({ ...valid, scheme: 'sepia' })).toBeNull();
    expect(parseThemeConfig(null)).toBeNull();
    expect(parseThemeConfig({ ...valid, tokens: { ...valid.tokens, bg: 'url(x)' } })).toBeNull();
  });

  it('accepts colour functions and rejects an empty derived token', () => {
    expect(
      parseThemeConfig({ ...valid, tokens: { ...valid.tokens, deep: 'color-mix(in srgb, #000 50%, #fff)' } }),
    ).not.toBeNull();
    expect(parseThemeConfig({ ...valid, tokens: { ...valid.tokens, 'tint-blue': '' } })).toBeNull();
  });
});

describe('theme variables', () => {
  it('publishes every token, deriving tints and edges a theme leaves out', () => {
    const light = builtinTheme('doom-one-light');
    expect(light).toBeDefined();
    const variables = themeCssVariables(light!);
    for (const token of THEME_TOKENS) expect(variables[themeVariable(token)]).toBeTruthy();
    expect(variables['--doom-tint-yellow']).toBe(derivedFallback('tint-yellow'));
    expect(variables['--doom-tint-yellow']).toContain('var(--doom-yellow)');
    expect(variables['--doom-edge-red']).toContain('var(--doom-border)');
    expect(variables['--doom-font-mono']).toContain('JetBrains Mono');
  });

  it('keeps the pinned tints of the shipped dark theme', () => {
    expect(themeCssVariables(DEFAULT_THEME)['--doom-tint-yellow']).toBe('#312a1c');
  });

  it('renders a stylesheet rule and applies to a root', () => {
    const css = themeCssText(DEFAULT_THEME);
    expect(css).toContain(':root {');
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('--doom-bg: #282c34;');

    const set: Record<string, string> = {};
    const attributes: Record<string, string> = {};
    const root = {
      style: { setProperty: (name: string, value: string) => (set[name] = value), colorScheme: '' },
      setAttribute: (name: string, value: string) => (attributes[name] = value),
    };
    applyTheme(builtinTheme('doom-one-light')!, root);
    expect(set['--doom-bg']).toBe('#fafafa');
    expect(root.style.colorScheme).toBe('light');
    expect(attributes['data-theme']).toBe('doom-one-light');
  });
});

describe('theme preference', () => {
  it('reads, writes and forgets through a storage, swallowing failures', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
    expect(readThemePreference(storage)).toBeNull();
    writeThemePreference(storage, 'doom-nord-dark');
    expect(map.get(THEME_STORAGE_KEY)).toBe('doom-nord-dark');
    expect(readThemePreference(storage)).toBe('doom-nord-dark');
    writeThemePreference(storage, null);
    expect(readThemePreference(storage)).toBeNull();
    expect(readThemePreference(undefined)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readThemePreference(broken)).toBeNull();
    expect(() => writeThemePreference(broken, 'x')).not.toThrow();
  });
});
