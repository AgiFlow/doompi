export interface Selection {
  /** Empty when the session runs without a profile, which is a valid choice. */
  profile: string;
  majorMode: string;
  domains: string[];
  /** True while a mode switch is journaled but not yet applied. */
  pending: boolean;
}

export const emptySelection: Selection = { profile: '', majorMode: '', domains: [], pending: false };

interface Segment {
  text: string;
  rgb: [number, number, number] | null;
}

// The escape is the point of this parser, so the control character is
// deliberate; spelled as a Unicode escape to keep it readable.
// oxlint-disable-next-line no-control-regex
const SGR = /\u001B\[([0-9;]*)m/gu;

/** Splits an ANSI string into runs of text carrying the truecolor in force. */
export function ansiSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  let current: [number, number, number] | null = null;
  let index = 0;

  SGR.lastIndex = 0;
  for (let match = SGR.exec(input); match !== null; match = SGR.exec(input)) {
    const text = input.slice(index, match.index);
    if (text) segments.push({ text, rgb: current });
    const codes = match[1].split(';').map((code) => Number.parseInt(code, 10));
    if (codes[0] === 38 && codes[1] === 2) current = [codes[2], codes[3], codes[4]];
    else if (codes[0] === 39 || codes[0] === 0 || Number.isNaN(codes[0])) current = null;
    index = match.index + match[0].length;
  }
  const tail = input.slice(index);
  if (tail) segments.push({ text: tail, rgb: current });
  return segments;
}

export function stripAnsi(input: string): string {
  return input.replace(SGR, '');
}

// The values doom-pi-dark.json binds to `warning` and `accent`. DoomPi ships one
// theme, so comparing against both and taking the nearer one reports pending
// accurately, and falls back to "not pending" when it cannot tell.
const WARNING: [number, number, number] = [236, 190, 123];
const ACCENT: [number, number, number] = [81, 175, 239];

function distance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/**
 * Reads DoomPi's footer status line.
 *
 * The line is the only place the session publishes its selection, so this
 * parses the shape `*profile*:[major-mode]:domains` structurally and uses the
 * colour of the mode segment solely to tell a pending switch from a settled one.
 */
export function parseSelection(statusText: string): Selection {
  const segments = ansiSegments(statusText);
  const plain = stripAnsi(statusText).trim();
  if (!plain) return emptySelection;

  const profileMatch = /\*([^*]+)\*/u.exec(plain);
  const modeMatch = /\[([^\]]+)\]/u.exec(plain);

  const afterMode = modeMatch ? plain.slice(plain.indexOf(modeMatch[0]) + modeMatch[0].length) : '';
  const domains = afterMode
    .replace(/^:/u, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const modeSegment = segments.find((segment) => segment.text.includes('['));
  const pending =
    modeSegment?.rgb !== undefined && modeSegment?.rgb !== null
      ? distance(modeSegment.rgb, WARNING) < distance(modeSegment.rgb, ACCENT)
      : false;

  return {
    profile: profileMatch ? profileMatch[1] : '',
    majorMode: modeMatch ? modeMatch[1] : '',
    domains,
    pending,
  };
}
