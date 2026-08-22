import path from 'node:path';
import type { FooterStatusPlacement, FooterTextSegment } from '@agimon-ai/doompi-extension-contracts/footer';
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, visibleWidth } from '@earendil-works/pi-tui';
import type { DoomUiState } from '../services/state/uiState.ts';
import { fitLine, padLine } from './rendering.ts';

const NARROW_FOOTER_WIDTH = 90;
const SEGMENT_SEPARATOR = ' · ';
const DIM_COLOR = 'dim';
const MUTED_COLOR = 'muted';
const TOOL_PENDING_BACKGROUND = 'toolPendingBg';
const DEFAULT_THINKING_LEVEL = 'off';
const MODELINE_PLACEMENT = 'modeline' satisfies FooterStatusPlacement;
const BEFORE_MODEL_PLACEMENT = 'beforeModel' satisfies FooterStatusPlacement;
// The theme ships a rising ramp for effort, ending at red for max.
const THINKING_COLORS: Record<string, ThemeColor> = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
};
const CONTEXT_WARN_PERCENT = 60;
const CONTEXT_CRITICAL_PERCENT = 85;

function normalizeFooterText(text: string): string {
  return text
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .trim();
}

export class DoomFooter implements Component {
  private readonly unsubscribeBranch: () => void;
  private readonly unsubscribeFooterStatuses: () => void;
  private readonly unsubscribeState: () => void;

  constructor(
    tui: TUI,
    private readonly theme: Theme,
    private readonly context: ExtensionContext,
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly footerStatuses: DoomFooterStatusView,
    private readonly uiState: DoomUiState,
  ) {
    this.unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
    this.unsubscribeFooterStatuses = footerStatuses.subscribe(() => tui.requestRender());
    this.unsubscribeState = uiState.subscribe(() => tui.requestRender());
  }

  dispose(): void {
    this.unsubscribeBranch();
    this.unsubscribeFooterStatuses();
    this.unsubscribeState();
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];

    const narrow = width < NARROW_FOOTER_WIDTH;
    const snapshot = this.uiState.getSnapshot();
    const modeText = snapshot.active ? snapshot.prefix.join(' ') : narrow ? 'I' : 'INSERT';
    const mode = snapshot.active
      ? this.theme.inverse(this.theme.bold(this.theme.fg('mdHeading', ` ${modeText} `)))
      : this.theme.inverse(this.theme.bold(this.theme.fg('accent', ` ${modeText} `)));
    const repository = path.basename(this.context.cwd) || this.context.cwd;
    const branch = this.footerData.getGitBranch();
    const location = this.locationSegment(repository, branch, narrow);
    const left = `${mode}${location}`;
    const beforeModel = this.footerStatusSummary(BEFORE_MODEL_PLACEMENT, narrow);
    const baseRuntime = this.runtimeSegment(narrow);
    const runtimeWithBeforeModel = this.runtimeSegment(narrow, beforeModel);
    const runtime =
      beforeModel && visibleWidth(mode) + visibleWidth(runtimeWithBeforeModel) <= width
        ? runtimeWithBeforeModel
        : baseRuntime;

    if (visibleWidth(left) + visibleWidth(runtime) > width) {
      return [fitLine(`${mode}${runtime}`, width)];
    }

    const middleWidth = width - visibleWidth(left) - visibleWidth(runtime);
    const middleText = this.modelineSummary(Math.max(0, middleWidth - 1), narrow);
    const middle = this.theme.bg(TOOL_PENDING_BACKGROUND, padLine(` ${middleText}`, middleWidth));
    return [fitLine(`${left}${middle}${runtime}`, width)];
  }

  private locationSegment(repository: string, branch: string | null, narrow: boolean): string {
    const repositoryPart = this.theme.bg(TOOL_PENDING_BACKGROUND, this.theme.fg('text', ` ${repository}`));
    if (!branch) return `${repositoryPart}${this.theme.bg(TOOL_PENDING_BACKGROUND, ' ')}`;
    const branchPrefix = narrow ? '  ' : '   ';
    return `${repositoryPart}${this.theme.bg(
      TOOL_PENDING_BACKGROUND,
      this.theme.fg('success', `${branchPrefix}${branch} `),
    )}`;
  }

  private runtimeSegment(narrow: boolean, beforeModel = ''): string {
    const contextPercent = this.context.getContextUsage()?.percent;
    const contextUsage =
      contextPercent === null || contextPercent === undefined
        ? narrow
          ? '?'
          : 'ctx ?'
        : narrow
          ? `${Math.round(contextPercent)}%`
          : `ctx ${Math.round(contextPercent)}%`;
    const modelLimit = narrow ? 18 : 30;
    const model = fitLine(this.compactModel(this.context.model?.id ?? 'no-model'), modelLimit);
    const thinking = this.context.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    const content = [
      ...(beforeModel ? [beforeModel] : []),
      this.theme.fg('warning', model),
      this.theme.fg(this.thinkingColor(thinking), thinking),
      this.theme.fg(this.contextColor(contextPercent), contextUsage),
    ].join(SEGMENT_SEPARATOR);
    return this.theme.bg(TOOL_PENDING_BACKGROUND, ` ${content} `);
  }

  /** Effort rides the theme's rising ramp, from grey at off to red at max. */
  private thinkingColor(level: string): ThemeColor {
    return THINKING_COLORS[level] ?? 'thinkingText';
  }

  /** Context usage warms as the window fills, so pressure is visible at a glance. */
  private contextColor(percent: number | null | undefined): ThemeColor {
    if (percent === null || percent === undefined) return MUTED_COLOR;
    if (percent >= CONTEXT_CRITICAL_PERCENT) return 'error';
    if (percent >= CONTEXT_WARN_PERCENT) return 'warning';
    return MUTED_COLOR;
  }

  private modelineSummary(availableWidth: number, compact: boolean): string {
    if (availableWidth <= 0) return '';
    return fitLine(this.footerStatusSummary(MODELINE_PLACEMENT, compact), availableWidth);
  }

  private footerStatusSummary(placement: FooterStatusPlacement, compact: boolean): string {
    return this.footerStatuses
      .getStatuses()
      .filter((status) => (status.placement ?? MODELINE_PLACEMENT) === placement)
      .map((status) => {
        const segments = compact ? status.compactSegments : status.fullSegments;
        if (segments?.length) return this.renderFooterSegments(segments);
        return this.theme.fg(DIM_COLOR, normalizeFooterText(compact ? status.compactText : status.fullText));
      })
      .filter(Boolean)
      .join(this.theme.fg(DIM_COLOR, SEGMENT_SEPARATOR));
  }

  private renderFooterSegments(segments: readonly FooterTextSegment[]): string {
    return segments
      .map((segment) => {
        const text = segment.text.replace(/[\r\n\t]+/gu, ' ');
        return this.theme.fg((segment.color ?? DIM_COLOR) as ThemeColor, text);
      })
      .join('');
  }

  private compactModel(model: string): string {
    const modelId = model.split('/').at(-1) ?? model;
    return modelId.replace(/^claude-/, '');
  }
}

export interface DoomFooterStatusView {
  getStatuses(): readonly {
    source: string;
    id: string;
    fullText: string;
    compactText: string;
    fullSegments?: FooterTextSegment[];
    compactSegments?: FooterTextSegment[];
    placement?: FooterStatusPlacement;
    order: number;
  }[];
  subscribe(listener: () => void): () => void;
}
