/**
 * The tone vocabularies every surface shares.
 *
 * Three of them exist because they answer different questions. A chromatic
 * tone names a colour ("this chip is violet"), a status tone names an outcome
 * ("this run failed"), and a line tone names a role inside a body of text.
 * They live here, not beside the components that draw them, so a consumer can
 * translate between them without importing a component, and so adding a tone
 * to one table without the others fails to compile.
 */

/** The accents a theme supplies; mirrors ACCENT_TOKENS in ./theme.ts. */
export const ACCENT_TONES = ['blue', 'green', 'yellow', 'red', 'magenta', 'violet', 'cyan', 'orange', 'teal'] as const;
export type AccentTone = (typeof ACCENT_TONES)[number];

/** What a chip may be: an accent, or the quiet default. */
export const CHIP_TONES = ['neutral', ...ACCENT_TONES] as const;
export type ChipTone = (typeof CHIP_TONES)[number];

/** A dot adds `muted` for a thing that exists but is not live. */
export const DOT_TONES = ['neutral', 'muted', ...ACCENT_TONES] as const;
export type DotTone = (typeof DOT_TONES)[number];

/** What happened, rather than what colour it is. */
export const STATUS_TONES = ['neutral', 'running', 'ok', 'error', 'info', 'accent'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** The role a single line of a message body plays. */
export const MESSAGE_LINE_TONES = ['hi', 'text', 'dim', 'muted', 'success', 'error', 'warning', 'accent'] as const;
export type MessageLineTone = (typeof MESSAGE_LINE_TONES)[number];
