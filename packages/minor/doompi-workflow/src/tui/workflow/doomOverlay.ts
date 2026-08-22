import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { fitLine, frameLine, padLine } from './rendering.ts';

const DEFAULT_TERMINAL_ROWS = 24;
const FULL_CHROME_ROWS = 6;
/** Two frame columns and two gutter columns, leaving content worth framing. */
const MIN_FRAMED_WIDTH = 8;
const GUTTER = ' ';
const GUTTER_COLUMNS = 2;
/** Blank columns kept between a row's left cluster and its right-aligned status. */
const ROW_GAP = 2;
/** A secondary segment thinner than this is dropped rather than shredded into a stub. */
const MIN_SEGMENT_WIDTH = 8;
const ELLIPSIS = '…';
const BORDER_COLOR = 'borderMuted';
const TEXT_COLOR = 'text';
/** Filled key caps read as pressable, matching the doom mockups' footers. */
const HINT_CAP_BACKGROUND = 'selectedBg';
const HINT_SEPARATOR = '   ';
/** A cap's two pad columns plus the space before its label. */
const HINT_CHROME_COLUMNS = 6;
const TITLE_COLOR = 'accent';
const SECONDARY_COLOR = 'dim';
const HORIZONTAL_BORDER = '─';
const VERTICAL_BORDER = '│';
const TOP_CORNERS = ['╭', '╮'] as const;
const DIVIDER_JOINTS = ['├', '┤'] as const;
const BOTTOM_CORNERS = ['╰', '╯'] as const;

export interface DoomOverlayTui {
  terminal?: {
    rows: number;
    columns?: number;
  };
  requestRender(force?: boolean): void;
}

export interface DoomOverlayChrome {
  title: string;
  breadcrumb?: string;
  headerRight?: string;
  footer: string;
  footerRight?: string;
  /**
   * Key/label pairs rendered as filled caps, e.g. `[ enter ] edit subject`.
   * Takes precedence over `footer`, which stays for surfaces that want a plain
   * sentence rather than a key legend.
   */
  footerHints?: readonly (readonly [string, string])[];
  /**
   * Signature colour for the surface. When set, the frame takes it and the
   * title renders as a filled badge rather than plain accent text, matching the
   * doom mockups. Left unset, the frame stays muted and the title plain.
   */
  accent?: Parameters<Theme['fg']>[0];
}

/**
 * One signature colour for every doom overlay: the frame and the title badge.
 * Per-surface colours were tried and read as arbitrary, and they also borrowed
 * tokens that mean something else (`warning`, `syntaxNumber`), so a theme edit
 * elsewhere would have repainted a frame. Change it here to change them all.
 */
export const DOOM_OVERLAY_ACCENT = 'mdHeading' satisfies DoomOverlayChrome['accent'];

export const DOOM_FULLSCREEN_UI_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: 'top-left',
    width: '100%',
    maxHeight: '100%',
    margin: 0,
  },
} as const;

/**
 * Fits a secondary segment into `budget`, or drops it entirely when too few
 * columns remain for it to stay readable. Truncating everything to fit is what
 * makes a tight header read as one run-on string.
 */
function fitSegment(text: string | undefined, budget: number): string {
  if (!text || budget <= 0) return '';
  return budget < Math.min(visibleWidth(text), MIN_SEGMENT_WIDTH) ? '' : truncateToWidth(text, budget, ELLIPSIS);
}

export abstract class DoomOverlay implements Component {
  protected constructor(
    protected readonly tui: DoomOverlayTui,
    protected readonly theme: Theme,
  ) {}

  invalidate(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.tui.terminal?.rows ?? DEFAULT_TERMINAL_ROWS));
    if (safeWidth === 0 || height === 0) return [];

    const chrome = this.getChrome();
    if (height < FULL_CHROME_ROWS || safeWidth < MIN_FRAMED_WIDTH) {
      return this.renderCompact(chrome, safeWidth, height);
    }

    const innerWidth = safeWidth - GUTTER_COLUMNS;
    const contentWidth = innerWidth - GUTTER_COLUMNS;
    const bodyHeight = height - FULL_CHROME_ROWS;
    const body = this.renderBody(contentWidth, bodyHeight).slice(0, bodyHeight);
    while (body.length < bodyHeight) body.push('');

    const frame = chrome.accent ?? BORDER_COLOR;
    return [
      this.borderRow(TOP_CORNERS, innerWidth, frame),
      this.contentRow(this.headerRow(chrome, contentWidth), contentWidth, safeWidth, frame),
      this.borderRow(DIVIDER_JOINTS, innerWidth, frame, BORDER_COLOR),
      ...body.map((line) => this.contentRow(line, contentWidth, safeWidth, frame)),
      this.borderRow(DIVIDER_JOINTS, innerWidth, frame, BORDER_COLOR),
      this.contentRow(this.footerRow(chrome, contentWidth), contentWidth, safeWidth, frame),
      this.borderRow(BOTTOM_CORNERS, innerWidth, frame),
    ].map((line) => padLine(line, safeWidth));
  }

  protected abstract getChrome(): DoomOverlayChrome;

  protected abstract renderBody(width: number, height: number): string[];

  /**
   * Edge glyphs and the rule between them are coloured separately: the outer
   * rectangle carries the signature colour while an internal separator stays
   * muted, meeting the frame at accent-coloured junctions.
   */
  private borderRow(
    [left, right]: readonly [string, string],
    innerWidth: number,
    edge: DoomOverlayChrome['accent'] = BORDER_COLOR,
    fill: DoomOverlayChrome['accent'] = edge,
  ): string {
    const edgeColour = edge ?? BORDER_COLOR;
    return [
      this.theme.fg(edgeColour, left),
      this.theme.fg(fill ?? edgeColour, HORIZONTAL_BORDER.repeat(innerWidth)),
      this.theme.fg(edgeColour, right),
    ].join('');
  }

  private contentRow(
    content: string,
    contentWidth: number,
    width: number,
    colour: DoomOverlayChrome['accent'] = BORDER_COLOR,
  ): string {
    const edge = this.theme.fg(colour ?? BORDER_COLOR, VERTICAL_BORDER);
    return frameLine(`${GUTTER}${padLine(content, contentWidth)}${GUTTER}`, width, edge, edge);
  }

  private headerRow(chrome: DoomOverlayChrome, width: number): string {
    // A signature colour turns the title into a filled badge, as the mockups
    // show; without one it stays plain accent text.
    const accent = chrome.accent;
    const titleBudget = accent ? width - GUTTER_COLUMNS : width;
    const title = truncateToWidth(chrome.title, Math.max(0, titleBudget), ELLIPSIS);
    let left = accent
      ? this.theme.inverse(this.theme.bold(this.theme.fg(accent, ` ${title} `)))
      : this.theme.bold(this.theme.fg(TITLE_COLOR, title));
    let leftWidth = visibleWidth(title) + (accent ? GUTTER_COLUMNS : 0);

    // The breadcrumb claims room before the right status: it says where you are,
    // which outranks ambient context when the terminal is narrow.
    const breadcrumb = fitSegment(chrome.breadcrumb, width - leftWidth - ROW_GAP);
    if (breadcrumb) {
      left += `${' '.repeat(ROW_GAP)}${this.theme.fg(SECONDARY_COLOR, breadcrumb)}`;
      leftWidth += ROW_GAP + visibleWidth(breadcrumb);
    }
    return this.withRightStatus(left, leftWidth, chrome.headerRight, width);
  }

  private footerRow(chrome: DoomOverlayChrome, width: number): string {
    const footer = chrome.footerHints?.length
      ? this.hintLegend(chrome.footerHints, width)
      : this.theme.fg(SECONDARY_COLOR, truncateToWidth(chrome.footer, width, ELLIPSIS));
    return this.withRightStatus(footer, visibleWidth(footer), chrome.footerRight, width);
  }

  /**
   * Key legend with each key in a filled cap. Every segment sets its own colour
   * so the caps survive: a cap's reset would otherwise strip the surrounding
   * dim from the labels that follow it.
   */
  private hintLegend(hints: readonly (readonly [string, string])[], width: number): string {
    let legend = '';
    let used = 0;
    for (const [key, label] of hints) {
      const segmentWidth = visibleWidth(key) + visibleWidth(label) + HINT_CHROME_COLUMNS;
      if (used + segmentWidth > width) break;
      const cap = this.theme.bg(HINT_CAP_BACKGROUND, this.theme.fg(TEXT_COLOR, ` ${key} `));
      legend += `${legend ? HINT_SEPARATOR : ''}${cap}${this.theme.fg(SECONDARY_COLOR, ` ${label}`)}`;
      used += segmentWidth;
    }
    return legend;
  }

  /**
   * Right-aligns a status cluster, dropping it whole when the row cannot spare
   * the columns. A clipped status reads as a stub (`doom-log…`) that carries
   * less than the blank space it costs.
   */
  private withRightStatus(left: string, leftWidth: number, right: string | undefined, width: number): string {
    const statusWidth = right ? visibleWidth(right) : 0;
    if (!right || statusWidth === 0 || leftWidth + ROW_GAP + statusWidth > width) return left;
    return `${left}${' '.repeat(width - leftWidth - statusWidth)}${this.theme.fg(SECONDARY_COLOR, right)}`;
  }

  private renderCompact(chrome: DoomOverlayChrome, width: number, height: number): string[] {
    const lines = Array.from({ length: height }, () => '');
    lines[0] = this.theme.bold(this.theme.fg(TITLE_COLOR, chrome.title));
    if (height > 1) lines[height - 1] = this.theme.fg(SECONDARY_COLOR, chrome.footer);
    return lines.map((line) => padLine(fitLine(line, width), width));
  }
}
