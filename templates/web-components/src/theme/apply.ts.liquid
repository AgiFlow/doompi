import { PALETTE_TOKENS, type ThemeConfig, themeVariable } from '../types/theme.ts';
import { derivedTokens, tokenValue } from './derive.ts';

/** The attribute the active theme's name is stamped on, for CSS that keys off a theme. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Every custom property a theme publishes, keyed by property name. */
export function themeCssVariables(theme: ThemeConfig): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) variables[themeVariable(token)] = theme.tokens[token];
  for (const token of derivedTokens()) variables[themeVariable(token)] = tokenValue(theme, token);
  return variables;
}

/** The theme as a stylesheet rule, for a server that wants to inline it. */
export function themeCssText(theme: ThemeConfig, selector = ':root'): string {
  const declarations = Object.entries(themeCssVariables(theme)).map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n  color-scheme: ${theme.scheme};\n${declarations.join('\n')}\n}\n`;
}

/** The subset of an element the theme touches, so tests can pass a plain object. */
export interface ThemeRoot {
  style: { setProperty(name: string, value: string): void; colorScheme: string };
  setAttribute(name: string, value: string): void;
}

/**
 * Applies a theme to the page: every token becomes a custom property on the
 * root, the colour scheme follows, and the theme name is stamped so a style
 * may key off it. Idempotent and synchronous, so calling it before the first
 * render avoids a flash of the default theme.
 */
export function applyTheme(theme: ThemeConfig, root: ThemeRoot): void {
  for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  root.setAttribute(THEME_ATTRIBUTE, theme.name);
}
