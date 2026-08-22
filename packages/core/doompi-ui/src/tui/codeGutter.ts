import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';

/** Doom Emacs recesses `line-number` and brightens `line-number-current-line`. */
const CONTEXT_LINE_NUMBER_COLOR: ThemeColor = 'dim';
const CHANGED_LINE_NUMBER_COLOR: ThemeColor = 'muted';

/** Right-align every number in a block so the code column never goes ragged. */
export function gutterWidth(highestLineNumber: number): number {
  return String(Math.max(1, highestLineNumber)).length;
}

/** Recessive right-aligned line number; blank numbers keep the column reserved. */
export function renderLineNumber(value: number | string, width: number, theme: Theme, changed = false): string {
  const color = changed ? CHANGED_LINE_NUMBER_COLOR : CONTEXT_LINE_NUMBER_COLOR;
  return theme.fg(color, String(value).padStart(width, ' '));
}
