import fs from 'node:fs';
import path from 'node:path';
import type { FooterTextColor } from '@agimon-ai/doompi-extension-contracts/footer';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';

export const DEFAULT_THEME_NAME = 'doom-pi-dark';

const AGENT_IDENTITY_COLORS = [
  'accent',
  'mdCode',
  'toolDiffAdded',
  'warning',
  'mdHeading',
  'syntaxNumber',
] as const satisfies readonly (FooterTextColor & ThemeColor)[];

function agentIdentityColorIndex(identity: string): number {
  let hash = 2_166_136_261;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % AGENT_IDENTITY_COLORS.length;
}

/** Stable semantic color shared by every UI surface that identifies an agent run. */
export function agentIdentityColor(identity: string): FooterTextColor {
  return AGENT_IDENTITY_COLORS[agentIdentityColorIndex(identity)]!;
}

/**
 * Prefer the identity's stable color, then walk the palette to avoid reusing a
 * color already visible on the same surface. Once every color is occupied,
 * reuse the stable preference rather than changing existing assignments.
 */
export function allocateAgentIdentityColor(identity: string, occupied: ReadonlySet<FooterTextColor>): FooterTextColor {
  const preferredIndex = agentIdentityColorIndex(identity);
  for (let offset = 0; offset < AGENT_IDENTITY_COLORS.length; offset++) {
    const color = AGENT_IDENTITY_COLORS[(preferredIndex + offset) % AGENT_IDENTITY_COLORS.length]!;
    if (!occupied.has(color)) return color;
  }
  return AGENT_IDENTITY_COLORS[preferredIndex]!;
}

export const DEFAULT_THEME = {
  $schema:
    'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json',
  name: DEFAULT_THEME_NAME,
  // Doom One's graphite base and saturated syntax ladder. Variable names are
  // semantic to this package so every TUI surface can share the palette.
  vars: {
    bg: '#282c34',
    bgAlt: '#21242b',
    bgActive: '#3e4451',
    bgHover: '#3e4451',
    fg: '#bbc2cf',
    fgAlt: '#9ca0a4',
    grey: '#3f444a',
    greyAlt: '#5b6268',
    blue: '#51afef',
    darkBlue: '#2257a0',
    cyan: '#46d9ff',
    green: '#98be65',
    lightGreen: '#a8cc8a',
    teal: '#4db5bd',
    orange: '#da8548',
    red: '#ff6c6b',
    violet: '#a9a1e1',
    magenta: '#c678dd',
    yellow: '#ecbe7b',
    lightYellow: '#f0c674',
    comment: '#5b6268',
    // Diff bands sink below `bg` and carry their signal in hue, not lightness,
    // so a banded row reads as a recessed well and syntax highlighting keeps at
    // least the contrast it has off the band. Blending Doom One's pale green and
    // red toward `bg` the way Magit does lightens instead, and `comment` goes.
    diffAddedBg: '#1b2315',
    diffRemovedBg: '#2b1c20',
  },
  colors: {
    accent: 'blue',
    border: 'greyAlt',
    borderAccent: 'blue',
    borderMuted: 'grey',
    success: 'green',
    error: 'red',
    warning: 'yellow',
    muted: 'fgAlt',
    dim: 'comment',
    text: 'fg',
    thinkingText: 'fgAlt',

    selectedBg: 'bgHover',
    userMessageBg: 'bgActive',
    userMessageText: 'fg',
    customMessageBg: '#2d253f',
    customMessageText: 'fg',
    customMessageLabel: 'violet',
    toolPendingBg: 'bgAlt',
    // Doubles as the added/removed band behind a diff row, so it stays a wash
    // rather than a fill: syntax highlighting has to remain legible on top.
    toolSuccessBg: 'diffAddedBg',
    toolErrorBg: 'diffRemovedBg',
    toolTitle: 'blue',
    toolOutput: 'fg',

    mdHeading: 'magenta',
    mdLink: 'blue',
    mdLinkUrl: 'comment',
    mdCode: 'cyan',
    mdCodeBlock: 'lightYellow',
    mdCodeBlockBorder: 'greyAlt',
    mdQuote: 'fgAlt',
    mdQuoteBorder: 'greyAlt',
    mdHr: 'greyAlt',
    mdListBullet: 'blue',

    toolDiffAdded: 'lightGreen',
    toolDiffRemoved: 'red',
    toolDiffContext: 'fgAlt',

    syntaxComment: 'comment',
    syntaxKeyword: 'blue',
    syntaxFunction: 'magenta',
    syntaxVariable: 'violet',
    syntaxString: 'green',
    syntaxNumber: 'orange',
    syntaxType: 'yellow',
    syntaxOperator: 'orange',
    syntaxPunctuation: 'fgAlt',

    // A rising ramp from quiet graphite through the Doom One accent ladder.
    thinkingOff: 'grey',
    thinkingMinimal: 'fgAlt',
    thinkingLow: 'darkBlue',
    thinkingMedium: 'blue',
    thinkingHigh: 'teal',
    thinkingXhigh: 'magenta',
    thinkingMax: 'red',

    bashMode: 'lightGreen',
  },
  export: {
    pageBg: 'bg',
    cardBg: 'bgAlt',
    infoBg: '#343225',
  },
} as const;

export async function writeDefaultTheme(temporaryDirectory: string): Promise<string> {
  const themePath = path.join(temporaryDirectory, `${DEFAULT_THEME_NAME}.json`);
  await fs.promises.writeFile(themePath, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`, { mode: 0o600 });
  return themePath;
}
