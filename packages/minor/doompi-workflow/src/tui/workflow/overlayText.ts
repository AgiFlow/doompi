/**
 * Text primitives shared by every doom overlay in this extension.
 *
 * Kept in one place because each of them encodes a decision that has to hold on
 * every surface: how a cell is clipped, which end of a path survives, and what
 * counts as a keystroke that carries text.
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const ELLIPSIS = '…';
export const CURSOR_BLOCK = '█';
export const SELECTION_MARKER = '›';
/** pi-tui brackets a truncation ellipsis with this; see `fit`. */
const HARD_RESET = '\x1b[0m';
const ESCAPE = '\x1b';
const FIRST_PRINTABLE_CODE_POINT = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * Truncates and pads to an exact column count.
 *
 * `truncateToWidth` wraps its ellipsis in a hard `\x1b[0m`, which would strip a
 * row's background for everything after a clipped cell. Nothing here sets a
 * colour that a full reset is the correct end for -- the theme closes its own
 * with `\x1b[39m` and `\x1b[49m` -- so the injected resets are dropped.
 */
export function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), ELLIPSIS).replaceAll(HARD_RESET, '');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Fits a line that carries its own colour, keeping every escape it contains.
 *
 * `fit` above drops hard resets, which is right for a themed row whose
 * background must survive a clipped cell and wrong for captured terminal
 * output: those resets are what END the child's colour runs, and deleting them
 * bleeds a colour through the rest of the panel. This closes the line with a
 * reset instead, before the padding, so no attribute escapes the row.
 */
export function fitTerminalLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const clipped = truncateToWidth(text, safeWidth, ELLIPSIS);
  const padding = ' '.repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
  return clipped.includes(ESCAPE) ? `${clipped}${HARD_RESET}${padding}` : `${clipped}${padding}`;
}

/** Right-aligns a trailing cluster against a left one, both clipped to fit. */
export function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

/**
 * Trims from the front rather than the tail.
 *
 * For a path the file name identifies the thing, while the
 * `automations/marketing-workflows/` prefix every entry shares does not.
 */
export function pathTail(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  return `${ELLIPSIS}${text.slice(text.length - Math.max(0, width - 1))}`;
}

/**
 * Keystrokes that carry no text: escape sequences, control keys, delete.
 *
 * Indexed rather than iterated so surrogate pairs stay intact; both halves sit
 * far above the control range, so no emoji is ever mistaken for one.
 */
export function isControlInput(data: string): boolean {
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) return true;
  }
  return false;
}

/**
 * Whitespace-separated terms, each of which must appear somewhere in the row's
 * searchable text. Splitting on whitespace is what lets `short video` match a
 * row whose words are divided between its title and its file name.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const lowered = haystack.toLowerCase();
  return terms.every((term) => lowered.includes(term));
}
