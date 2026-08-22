import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
} from '../../src/exports/components/doomOverlay.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

class TestOverlay extends DoomOverlay {
  constructor(
    tui: DoomOverlayTui,
    private readonly body: string[],
    private readonly chrome: DoomOverlayChrome = {
      title: 'TEST',
      breadcrumb: 'scope / item',
      headerRight: 'status',
      footer: 'esc close',
      footerRight: '1/2',
    },
  ) {
    super(tui, theme);
  }

  protected getChrome(): DoomOverlayChrome {
    return this.chrome;
  }

  protected renderBody(_width: number, _height: number): string[] {
    return this.body;
  }
}

describe('DoomOverlay', () => {
  it('exports stable navigation legend tokens', () => {
    expect(DOOM_NAVIGATION_KEYS).toEqual({ list: '↑↓', detail: 'JK' });
  });

  it('uses edge-to-edge Pi overlay geometry', () => {
    expect(DOOM_FULLSCREEN_UI_OPTIONS).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: 'top-left',
        width: '100%',
        maxHeight: '100%',
        margin: 0,
      },
    });
  });

  it('fills the requested width and live terminal height', () => {
    const tui = { terminal: { rows: 12, columns: 40 }, requestRender: vi.fn() };
    const overlay = new TestOverlay(tui, ['first', '\u001b[31mcolored\u001b[0m', 'x'.repeat(100)]);

    const first = overlay.render(40);
    expect(first).toHaveLength(12);
    expect(first.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(first.join('\n')).toContain('TEST');
    expect(first.join('\n')).toContain('esc close');
    expect(first.join('\n')).toContain('colored');

    tui.terminal.rows = 8;
    const resized = overlay.render(24);
    expect(resized).toHaveLength(8);
    expect(resized.every((line) => visibleWidth(line) === 24)).toBe(true);
  });

  it('pads missing body rows and clips excess rows', () => {
    const tui = { terminal: { rows: 9 }, requestRender: vi.fn() };
    const short = new TestOverlay(tui, ['only']).render(20);
    const long = new TestOverlay(tui, ['one', 'two', 'three', 'four']).render(20);

    expect(short).toHaveLength(9);
    expect(long).toHaveLength(9);
    expect(long.join('\n')).not.toContain('four');
  });

  it('uses a full-height compact takeover on tiny terminals', () => {
    const tui = { terminal: { rows: 3 }, requestRender: vi.fn() };
    const lines = new TestOverlay(tui, ['hidden']).render(3);

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => visibleWidth(line) === 3)).toBe(true);
    expect(lines[0]).toContain('TES');
    expect(lines[2]).toContain('esc');
  });

  it('insets content by a gutter on both sides', () => {
    const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
    const [, header, , body] = new TestOverlay(tui, ['body']).render(30);

    // `│ ` then content, and a trailing gutter column before the closing edge.
    expect(header?.startsWith('│ TEST')).toBe(true);
    expect(body?.startsWith('│ body')).toBe(true);
    expect(body?.endsWith(' │')).toBe(true);
  });

  it('drops a right status that cannot fit whole rather than clipping it to a stub', () => {
    const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
    const chrome: DoomOverlayChrome = {
      title: 'TITLE',
      breadcrumb: 'a fairly long breadcrumb trail',
      headerRight: 'a long ambient status',
      footer: 'esc close',
    };

    const wide = new TestOverlay(tui, [], chrome).render(90).join('\n');
    const narrow = new TestOverlay(tui, [], chrome).render(46).join('\n');
    const tight = new TestOverlay(tui, [], chrome).render(30).join('\n');

    expect(wide).toContain('a long ambient status');
    // The breadcrumb outranks ambient status: it still fits whole here, so the
    // status is dropped rather than both being shredded.
    expect(narrow).toContain('a fairly long breadcrumb trail');
    expect(narrow).not.toContain('a long ambient status');
    // Only once the breadcrumb itself cannot fit does it truncate, with an ellipsis.
    expect(tight).toContain('…');
    expect(tight).not.toContain('a long ambient status');
  });

  it('accents only the outer rectangle, leaving internal separators muted', () => {
    // Recording rather than tagging: tag markers count against the fitted width
    // and would be truncated out of the rendered line.
    const painted: [string, string][] = [];
    const tagTheme = {
      fg: (colour: string, text: string) => {
        painted.push([colour, text]);
        return text;
      },
      bold: (text: string) => text,
      inverse: (text: string) => text,
    } as unknown as Theme;
    class Accented extends DoomOverlay {
      constructor(tui: DoomOverlayTui) {
        super(tui, tagTheme);
      }

      protected getChrome(): DoomOverlayChrome {
        return { title: 'TASK SPACE', footer: 'esc close', accent: 'mdHeading' };
      }

      protected renderBody(): string[] {
        return ['body'];
      }
    }
    new Accented({ terminal: { rows: 9 }, requestRender: vi.fn() }).render(40);

    const colourOf = (glyph: string): string[] =>
      painted.filter(([, text]) => text.startsWith(glyph)).map(([colour]) => colour);
    const rules = painted.filter(([, text]) => /^─+$/.test(text)).map(([colour]) => colour);

    // Outer rectangle: corners, vertical edges and junctions all accented.
    expect(colourOf('╭')).toEqual(['mdHeading']);
    expect(colourOf('╰')).toEqual(['mdHeading']);
    expect(colourOf('│')).toEqual(expect.arrayContaining(['mdHeading']));
    expect(colourOf('├')).toEqual(['mdHeading', 'mdHeading']);
    // Rules: the two outer ones accented, the two internal separators muted.
    expect(rules.filter((colour) => colour === 'mdHeading')).toHaveLength(2);
    expect(rules.filter((colour) => colour === 'borderMuted')).toHaveLength(2);
  });

  it('requests a render when invalidated', () => {
    const tui = { terminal: { rows: 8 }, requestRender: vi.fn() };
    new TestOverlay(tui, []).invalidate();
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it('handles zero dimensions, default height, and optional chrome fields', () => {
    const noTerminal = { requestRender: vi.fn() };
    const overlay = new TestOverlay(noTerminal, [], { title: 'MINIMAL', footer: 'close' });

    expect(overlay.render(0)).toEqual([]);
    expect(overlay.render(12)).toHaveLength(24);
    expect(new TestOverlay({ terminal: { rows: 0 }, requestRender: vi.fn() }, []).render(12)).toEqual([]);
    expect(overlay.render(4).every((line) => visibleWidth(line) === 4)).toBe(true);
  });
});
