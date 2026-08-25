import {
  ACCENT_TOKENS,
  type AccentToken,
  type DerivedToken,
  type ThemeConfig,
  type ThemeToken,
} from '../types/theme.ts';

/** How much of an accent goes into its tinted background; the rest is the panel. */
const TINT_MIX_PERCENT = 16;
/** How much of an accent goes into its accented border; the rest is the border. */
const EDGE_MIX_PERCENT = 40;
/** How much of the selection tints its foreground; the rest is white, so the label stays legible on it. */
const ON_SELECTED_MIX_PERCENT = 12;

export const DEFAULT_FONT_MONO =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

/**
 * A derived token's fallback: a CSS colour expression over the palette, so a
 * theme that supplies only its palette still gets coherent tints and edges.
 */
export function derivedFallback(token: DerivedToken): string {
  if (token === 'font-mono') return DEFAULT_FONT_MONO;
  if (token === 'on-selected')
    return `color-mix(in srgb, var(--doom-selected) ${String(ON_SELECTED_MIX_PERCENT)}%, white)`;
  const [kind, accent] = token.split('-') as ['tint' | 'edge', AccentToken];
  return kind === 'tint'
    ? `color-mix(in srgb, var(--doom-${accent}) ${String(TINT_MIX_PERCENT)}%, var(--doom-panel))`
    : `color-mix(in srgb, var(--doom-${accent}) ${String(EDGE_MIX_PERCENT)}%, var(--doom-border))`;
}

/** Every derived token, in a stable order. */
export function derivedTokens(): DerivedToken[] {
  const tokens: DerivedToken[] = [];
  for (const accent of ACCENT_TOKENS) tokens.push(`tint-${accent}`);
  for (const accent of ACCENT_TOKENS) tokens.push(`edge-${accent}`);
  tokens.push('on-selected', 'font-mono');
  return tokens;
}

/** The value a theme publishes for a token: its own, or the derived fallback. */
export function tokenValue(theme: ThemeConfig, token: ThemeToken): string {
  const own = (theme.tokens as Partial<Record<ThemeToken, string>>)[token];
  if (own !== undefined) return own;
  return derivedFallback(token as DerivedToken);
}
