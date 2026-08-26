import type { ThemeConfig, ThemeScheme } from '../types/theme.ts';
import { parseThemeConfig } from './parse.ts';

/**
 * The Pi TUI theme shape (theme-schema.json): a palette of named vars and
 * semantic colours that name a var or spell a colour.
 */
interface PiThemeLike {
  name?: unknown;
  vars?: unknown;
  colors?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hexLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Resolves a Pi colour reference: a var name, or a literal colour. */
function resolve(vars: Record<string, string>, reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  return vars[reference] ?? reference;
}

export interface PiThemeBridgeOptions {
  /** The web theme's id; defaults to the Pi theme's name. */
  name?: string;
  label?: string;
  /** Forced scheme; otherwise inferred from the background luminance. */
  scheme?: ThemeScheme;
}

/**
 * Builds a web theme from a Pi TUI theme, so the palette DoomPi ships for
 * the terminal (doompi-ui/themes/doom-pi-dark.json) drives the browser too.
 * The mapping is by role, not by name: Pi has no cockpit "deep" surface or
 * "border-soft" line, so those are mixed from the nearest vars. Returns null
 * when the input is not a Pi theme with a complete palette.
 */
export function themeFromPiTheme(input: unknown, options: PiThemeBridgeOptions = {}): ThemeConfig | null {
  if (!isRecord(input)) return null;
  const { name, vars, colors } = input as PiThemeLike;
  if (!isRecord(vars)) return null;
  const palette: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) if (typeof value === 'string') palette[key] = value;
  const semantic: Record<string, string> = {};
  if (isRecord(colors))
    for (const [key, value] of Object.entries(colors)) if (typeof value === 'string') semantic[key] = value;

  const bg = palette.bg;
  const bgAlt = palette.bgAlt ?? bg;
  const fg = palette.fg;
  if (bg === undefined || fg === undefined) return null;

  const luminance = hexLuminance(bg);
  const scheme: ThemeScheme = options.scheme ?? (luminance !== null && luminance > 0.5 ? 'light' : 'dark');
  const towards = scheme === 'dark' ? 'black' : 'white';
  const deep = `color-mix(in srgb, ${bgAlt} 84%, ${towards})`;
  const border = resolve(palette, semantic.borderMuted) ?? palette.grey ?? `color-mix(in srgb, ${fg} 25%, ${bg})`;
  const themeName = options.name ?? (typeof name === 'string' ? name : 'pi-theme');

  return parseThemeConfig({
    name: themeName,
    label: options.label ?? themeName,
    scheme,
    tokens: {
      bg,
      rail: bgAlt,
      panel: `color-mix(in srgb, ${bgAlt} 70%, ${bg})`,
      deep,
      border,
      'border-soft': `color-mix(in srgb, ${border} 55%, ${bg})`,
      hi: `color-mix(in srgb, ${fg} 65%, ${scheme === 'dark' ? 'white' : 'black'})`,
      text: fg,
      dim: resolve(palette, semantic.muted) ?? palette.fgAlt ?? fg,
      faint: resolve(palette, semantic.dim) ?? palette.comment ?? palette.greyAlt ?? fg,
      blue: palette.blue ?? resolve(palette, semantic.accent) ?? fg,
      green: palette.green ?? resolve(palette, semantic.success) ?? fg,
      yellow: palette.yellow ?? resolve(palette, semantic.warning) ?? fg,
      red: palette.red ?? resolve(palette, semantic.error) ?? fg,
      magenta: palette.magenta ?? palette.violet ?? fg,
      violet: palette.violet ?? palette.magenta ?? fg,
      cyan: palette.cyan ?? palette.blue ?? fg,
      orange: palette.orange ?? palette.yellow ?? fg,
      teal: palette.teal ?? palette.cyan ?? fg,
      selected: palette.darkBlue ?? palette.blue ?? fg,
    },
  });
}
