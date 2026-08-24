import type { ThemeConfig } from '../types/theme.ts';
import doomNordDark from '../../themes/doom-nord-dark.json' with { type: 'json' };
import doomOneDark from '../../themes/doom-one-dark.json' with { type: 'json' };
import doomOneLight from '../../themes/doom-one-light.json' with { type: 'json' };
import { parseThemeConfig } from './parse.ts';

function shipped(input: unknown, file: string): ThemeConfig {
  const theme = parseThemeConfig(input);
  if (theme === null) throw new Error(`The shipped theme ${file} is malformed.`);
  return theme;
}

/** The theme the cockpit renders with until a preference says otherwise. */
export const DEFAULT_THEME_NAME = 'doom-one-dark';

/** The themes this package ships, default first. */
export const BUILTIN_THEMES: readonly ThemeConfig[] = [
  shipped(doomOneDark, 'doom-one-dark.json'),
  shipped(doomOneLight, 'doom-one-light.json'),
  shipped(doomNordDark, 'doom-nord-dark.json'),
];

export const DEFAULT_THEME: ThemeConfig = BUILTIN_THEMES[0];

/** A shipped theme by name, or undefined for a name nothing shipped under. */
export function builtinTheme(name: string): ThemeConfig | undefined {
  return BUILTIN_THEMES.find((theme) => theme.name === name);
}
