import { DERIVED_TOKENS, PALETTE_TOKENS, type ThemeConfig, type ThemeScheme } from '../types/theme.ts';

const THEME_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A CSS colour as a theme may spell it: hex, a colour function, or a named colour; never a url or an image. */
const CSS_COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\((?:[^()]|\([^()]*\))*\)|[a-z]+)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a theme config read from JSON. Returns null rather than throwing
 * because a bad theme file must never take the cockpit down; the caller falls
 * back to the shipped default and says so.
 */
export function parseThemeConfig(input: unknown): ThemeConfig | null {
  if (!isRecord(input)) return null;
  const { name, label, scheme, tokens } = input;
  if (typeof name !== 'string' || !THEME_NAME.test(name)) return null;
  if (typeof label !== 'string' || label.trim() === '') return null;
  if (scheme !== 'dark' && scheme !== 'light') return null;
  if (!isRecord(tokens)) return null;

  const accepted: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) {
    const value = tokens[token];
    if (typeof value !== 'string' || !CSS_COLOR.test(value.trim())) return null;
    accepted[token] = value.trim();
  }
  for (const token of DERIVED_TOKENS) {
    const value = tokens[token];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') return null;
    accepted[token] = value.trim();
  }
  return { name, label, scheme: scheme as ThemeScheme, tokens: accepted as ThemeConfig['tokens'] };
}
