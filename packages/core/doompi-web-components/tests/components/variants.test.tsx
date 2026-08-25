import { describe, expect, it } from 'vitest';
import {
  ACCENT_TONES,
  badgeVariants,
  CHIP_TO_STATUS,
  CHIP_TONES,
  DOT_TONES,
  dotVariants,
  LINE_TONE_TO_STATUS,
  MESSAGE_LINE_TONES,
  messageItemStatusVariants,
  messageItemVariants,
  messageLineVariants,
  STATUS_EDGE,
  STATUS_GLYPH,
  STATUS_LABEL,
  STATUS_TO_CHIP,
  STATUS_TO_DOT,
  STATUS_TONES,
  statusBadgeVariants,
  toastVariants,
} from '../../src/exports/index.ts';

/**
 * The tone unions in src/types/tone.ts are enforced at compile time by the
 * `satisfies Record<Tone, string>` on every table, so a tone added to the
 * union but not to a table fails to build. What a type cannot catch is two
 * tones sharing one class, which is how a copy-pasted row goes unnoticed, so
 * that is what these assert.
 */
function distinct(name: string, tones: readonly string[], render: (tone: string) => string): void {
  const drawn = new Map<string, string>();
  for (const tone of tones) {
    const classes = render(tone);
    expect(classes, `${name}.${tone} draws nothing`).not.toBe('');
    const clash = drawn.get(classes);
    expect(clash, `${name}.${tone} is indistinguishable from ${name}.${String(clash)}`).toBeUndefined();
    drawn.set(classes, tone);
  }
}

describe('tone tables', () => {
  it('give every chip, dot and status tone a look of its own', () => {
    distinct('badge', CHIP_TONES, (tone) => badgeVariants({ tone: tone as never }));
    distinct('dot', DOT_TONES, (tone) => dotVariants({ tone: tone as never }));
    distinct('statusBadge', STATUS_TONES, (tone) => statusBadgeVariants({ tone: tone as never }));
    distinct('messageItem', STATUS_TONES, (tone) => messageItemVariants({ tone: tone as never }));
    distinct('messageItemStatus', STATUS_TONES, (tone) => messageItemStatusVariants({ tone: tone as never }));
    distinct('messageLine', MESSAGE_LINE_TONES, (tone) => messageLineVariants({ tone: tone as never }));
    distinct('toast', STATUS_TONES, (tone) => toastVariants({ tone: tone as never }));
  });

  it('name an edge, a label and a glyph for every status', () => {
    for (const tone of STATUS_TONES) {
      expect(STATUS_EDGE[tone], `no edge for ${tone}`).toMatch(/^border-doom-/);
      expect(STATUS_GLYPH[tone], `no glyph for ${tone}`).not.toBe('');
      expect(STATUS_LABEL, `no label entry for ${tone}`).toHaveProperty(tone);
    }
    // The tone whose card border used to fall back to the plain border.
    expect(STATUS_EDGE.ok).toBe('border-doom-edge-green');
  });

  it('translate between the vocabularies in both directions', () => {
    for (const tone of STATUS_TONES) {
      expect(CHIP_TONES).toContain(STATUS_TO_CHIP[tone]);
      expect(DOT_TONES).toContain(STATUS_TO_DOT[tone]);
    }
    for (const tone of CHIP_TONES) expect(STATUS_TONES).toContain(CHIP_TO_STATUS[tone]);
    for (const tone of MESSAGE_LINE_TONES) expect(STATUS_TONES).toContain(LINE_TONE_TO_STATUS[tone]);
    // Round-tripping a status through its colour and back is the identity for
    // the five that name a colour of their own.
    for (const tone of STATUS_TONES) expect(CHIP_TO_STATUS[STATUS_TO_CHIP[tone]]).toBe(tone);
  });

  it('keeps the accent tones in step with the palette', () => {
    for (const accent of ACCENT_TONES) {
      expect(CHIP_TONES).toContain(accent);
      expect(DOT_TONES).toContain(accent);
    }
  });
});
