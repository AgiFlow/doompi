/**
 * The escapes a captured terminal screen carries, turned into spans.
 *
 * WHY THIS EXISTS:
 * tmux captures a pane with `-e`, and cmux's render grid is rebuilt into the
 * same escapes, so what arrives at the cockpit is a terminal's own colour. The
 * browser has no terminal, and the cockpit carries no terminal emulator, so
 * the sequences are read here and rendered as ordinary spans.
 *
 * WHAT IT UNDERSTANDS:
 * SGR (`ESC [ … m`) only: the eight base colours and their bright forms, 256
 * colour and truecolour, and bold, faint, italic, underline and inverse. Every
 * other sequence is dropped rather than printed, because a cursor move or a
 * clear that arrives as visible junk is worse than one that arrives as
 * nothing: the screen is a snapshot, and the next one repaints it anyway.
 *
 * The named colours become theme tokens rather than the child's own palette,
 * so a run's output sits in the cockpit's colours instead of fighting them.
 * Only 256-colour and truecolour, which name a colour no token can stand in
 * for, are rendered as themselves.
 */

/** One run of text with the attributes in force when it was printed. */
export interface AnsiSpan {
  text: string;
  /** Theme class for a named colour, absent when the colour is the default. */
  className?: string;
  /** An exact colour the child asked for, as `rgb(r g b)`; only 256/truecolour set this. */
  color?: string;
  bold?: boolean;
  faint?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Foreground and background swapped, which a TUI uses for selection and cursors. */
  inverse?: boolean;
}

// oxlint-disable-next-line no-control-regex -- reading terminal escapes is the point
const ANSI_PATTERN = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[A-Za-z]/g;
const SGR_FINAL = 'm';
const RESET_CODE = 0;
const DEFAULT_FOREGROUND = 39;
const EXTENDED_FOREGROUND = 38;
const EXTENDED_BACKGROUND = 48;
const TRUECOLOR_SELECTOR = 2;
const PALETTE_SELECTOR = 5;
const BASE_FOREGROUND_START = 30;
const BASE_FOREGROUND_END = 37;
const BRIGHT_FOREGROUND_START = 90;
const BRIGHT_FOREGROUND_END = 97;
const BACKGROUND_START = 40;
const BACKGROUND_END = 49;
const BRIGHT_BACKGROUND_START = 100;
const BRIGHT_BACKGROUND_END = 107;
const RGB_CHANNELS = 3;
const PALETTE_SIZE = 256;
const PALETTE_CUBE_START = 16;
const PALETTE_GREY_START = 232;
const CUBE_SIDE = 6;
const CUBE_STEP = 40;
const CUBE_OFFSET = 55;
const GREY_STEP = 10;
const GREY_OFFSET = 8;
const MAX_CHANNEL = 255;

const BOLD = 1;
const FAINT = 2;
const ITALIC = 3;
const UNDERLINE = 4;
const INVERSE = 7;
const NOT_BOLD = 22;
const NOT_ITALIC = 23;
const NOT_UNDERLINE = 24;
const NOT_INVERSE = 27;

/**
 * The eight terminal colours as theme tokens, listed as whole class strings so
 * the host's class scanner can see them.
 */
const FOREGROUND_CLASS: Readonly<Record<number, string>> = {
  30: 'text-doom-faint',
  31: 'text-doom-red',
  32: 'text-doom-green',
  33: 'text-doom-yellow',
  34: 'text-doom-blue',
  35: 'text-doom-magenta',
  36: 'text-doom-cyan',
  37: 'text-doom-text',
  90: 'text-doom-dim',
  91: 'text-doom-red',
  92: 'text-doom-green',
  93: 'text-doom-orange',
  94: 'text-doom-blue',
  95: 'text-doom-violet',
  96: 'text-doom-cyan',
  97: 'text-doom-hi',
};

interface Attributes {
  className?: string;
  color?: string;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function blank(): Attributes {
  return { bold: false, faint: false, italic: false, underline: false, inverse: false };
}

/** One of the 256 palette entries as an exact colour, since no token stands for it. */
function paletteColor(index: number): string | undefined {
  if (index < 0 || index >= PALETTE_SIZE) return undefined;
  if (index < PALETTE_CUBE_START) return undefined; // The first sixteen are the named ones.
  if (index >= PALETTE_GREY_START) {
    const level = (index - PALETTE_GREY_START) * GREY_STEP + GREY_OFFSET;
    return rgb(level, level, level);
  }
  const offset = index - PALETTE_CUBE_START;
  const channel = (value: number): number => (value === 0 ? 0 : value * CUBE_STEP + CUBE_OFFSET);
  return rgb(
    channel(Math.floor(offset / (CUBE_SIDE * CUBE_SIDE)) % CUBE_SIDE),
    channel(Math.floor(offset / CUBE_SIDE) % CUBE_SIDE),
    channel(offset % CUBE_SIDE),
  );
}

function rgb(red: number, green: number, blue: number): string {
  const clamp = (value: number): number => Math.max(0, Math.min(MAX_CHANNEL, Math.round(value)));
  return `rgb(${clamp(red)} ${clamp(green)} ${clamp(blue)})`;
}

/** Reads one extended-colour run (`38;5;n` or `38;2;r;g;b`), answering how many codes it ate. */
function extendedColor(codes: readonly number[], index: number): { color?: string; consumed: number } {
  const selector = codes[index + 1];
  if (selector === TRUECOLOR_SELECTOR) {
    const [red, green, blue] = codes.slice(index + 2, index + 2 + RGB_CHANNELS);
    if (red === undefined || green === undefined || blue === undefined) return { consumed: codes.length };
    return { color: rgb(red, green, blue), consumed: 1 + 1 + RGB_CHANNELS };
  }
  if (selector === PALETTE_SELECTOR) {
    const entry = codes[index + 2];
    return { ...(entry === undefined ? {} : { color: paletteColor(entry) }), consumed: 3 };
  }
  return { consumed: 1 };
}

function applySgr(current: Attributes, parameters: string): Attributes {
  // An empty parameter list is a reset, which is what a bare `ESC[m` means.
  const codes = parameters === '' ? [RESET_CODE] : parameters.split(/[;:]/).map((part) => Number(part) || 0);
  let next = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] as number;
    if (code === RESET_CODE) {
      next = blank();
    } else if (code === BOLD) next.bold = true;
    else if (code === FAINT) next.faint = true;
    else if (code === ITALIC) next.italic = true;
    else if (code === UNDERLINE) next.underline = true;
    else if (code === INVERSE) next.inverse = true;
    else if (code === NOT_BOLD) {
      next.bold = false;
      next.faint = false;
    } else if (code === NOT_ITALIC) next.italic = false;
    else if (code === NOT_UNDERLINE) next.underline = false;
    else if (code === NOT_INVERSE) next.inverse = false;
    else if (code === DEFAULT_FOREGROUND) {
      delete next.className;
      delete next.color;
    } else if (code === EXTENDED_FOREGROUND) {
      const { color, consumed } = extendedColor(codes, index);
      delete next.className;
      if (color === undefined) delete next.color;
      else next.color = color;
      index += consumed - 1;
    } else if (code === EXTENDED_BACKGROUND) {
      // Backgrounds are dropped: a child painting its own background over the
      // cockpit's panel is what makes captured output unreadable in a theme.
      index += extendedColor(codes, index).consumed - 1;
    } else if (
      (code >= BASE_FOREGROUND_START && code <= BASE_FOREGROUND_END) ||
      (code >= BRIGHT_FOREGROUND_START && code <= BRIGHT_FOREGROUND_END)
    ) {
      const className = FOREGROUND_CLASS[code];
      delete next.color;
      if (className === undefined) delete next.className;
      else next.className = className;
    }
    // Background and everything else is read and dropped.
    else if (
      (code >= BACKGROUND_START && code <= BACKGROUND_END) ||
      (code >= BRIGHT_BACKGROUND_START && code <= BRIGHT_BACKGROUND_END)
    ) {
      next.inverse = false;
    }
  }
  return next;
}

function spanOf(text: string, attributes: Attributes): AnsiSpan {
  return {
    text,
    ...(attributes.className === undefined ? {} : { className: attributes.className }),
    ...(attributes.color === undefined ? {} : { color: attributes.color }),
    ...(attributes.bold ? { bold: true } : {}),
    ...(attributes.faint ? { faint: true } : {}),
    ...(attributes.italic ? { italic: true } : {}),
    ...(attributes.underline ? { underline: true } : {}),
    ...(attributes.inverse ? { inverse: true } : {}),
  };
}

/** One line of captured screen as spans, with every unreadable sequence dropped. */
export function ansiSpans(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let attributes = blank();
  let cursor = 0;
  ANSI_PATTERN.lastIndex = 0;
  let match = ANSI_PATTERN.exec(line);
  while (match !== null) {
    if (match.index > cursor) spans.push(spanOf(line.slice(cursor, match.index), attributes));
    if (match[2] === SGR_FINAL) attributes = applySgr(attributes, match[1] ?? '');
    cursor = match.index + match[0].length;
    match = ANSI_PATTERN.exec(line);
  }
  if (cursor < line.length) spans.push(spanOf(line.slice(cursor), attributes));
  return spans;
}
