import {
  applyTheme,
  BUILTIN_THEMES,
  builtinTheme,
  DEFAULT_THEME,
  readThemePreference,
  type ThemeConfig,
  writeThemePreference,
} from '@agimon-ai/doompi-web-components/theme';
import { Store } from '@tanstack/store';

export interface ThemeState {
  /** The name of the theme on the page. */
  name: string;
}

export const themeStore = new Store<ThemeState>({ name: DEFAULT_THEME.name });

/** The themes the appearance page offers. */
export function availableThemes(): readonly ThemeConfig[] {
  return BUILTIN_THEMES;
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Puts the remembered theme on the page. Called before the first render so
 * the cockpit never flashes the default; a stored name nothing ships under
 * falls back to the default and is forgotten.
 */
export function applyStoredTheme(): void {
  const stored = readThemePreference(storage());
  const theme = (stored === null ? undefined : builtinTheme(stored)) ?? DEFAULT_THEME;
  if (stored !== null && theme.name !== stored) writeThemePreference(storage(), null);
  applyTheme(theme, document.documentElement);
  themeStore.setState(() => ({ name: theme.name }));
}

/** Switches the page to a shipped theme and remembers it. */
export function selectTheme(name: string): void {
  const theme = builtinTheme(name);
  if (theme === undefined) return;
  applyTheme(theme, document.documentElement);
  writeThemePreference(storage(), name);
  themeStore.setState(() => ({ name }));
}
