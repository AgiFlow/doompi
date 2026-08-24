/**
 * The web theme contract: the named colours every cockpit surface is built
 * from. Palette tokens are the hand-picked values a theme must supply; the
 * derived tokens (tinted backgrounds, accented borders) are computed from the
 * palette unless a theme pins them, which is how the shipped dark theme keeps
 * its exact mockup values while a third-party theme needs only the palette.
 */
export const PALETTE_TOKENS = [
  'bg',
  'rail',
  'panel',
  'deep',
  'border',
  'border-soft',
  'hi',
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
  'orange',
  'teal',
  'selected',
] as const;

export const ACCENT_TOKENS = ['blue', 'green', 'yellow', 'red', 'magenta', 'violet', 'cyan'] as const;

export const DERIVED_TOKENS = [
  'tint-blue',
  'tint-green',
  'tint-yellow',
  'tint-red',
  'tint-magenta',
  'tint-violet',
  'tint-cyan',
  'edge-blue',
  'edge-green',
  'edge-yellow',
  'edge-red',
  'edge-magenta',
  'edge-violet',
  'edge-cyan',
  'font-mono',
] as const;

export const THEME_TOKENS = [...PALETTE_TOKENS, ...DERIVED_TOKENS] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number];
export type AccentToken = (typeof ACCENT_TOKENS)[number];
export type DerivedToken = (typeof DERIVED_TOKENS)[number];
export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ThemeScheme = 'dark' | 'light';

/** A theme config as written in JSON: identity, colour scheme, and the token values. */
export interface ThemeConfig {
  /** Stable id, kebab-case; the `data-theme` attribute and the stored preference. */
  name: string;
  /** What a picker shows. */
  label: string;
  /** Drives `color-scheme` so native controls and scrollbars match. */
  scheme: ThemeScheme;
  tokens: Record<PaletteToken, string> & Partial<Record<DerivedToken, string>>;
}

/** The CSS custom property a token is published as. */
export function themeVariable(token: ThemeToken): `--doom-${ThemeToken}` {
  return `--doom-${token}`;
}
