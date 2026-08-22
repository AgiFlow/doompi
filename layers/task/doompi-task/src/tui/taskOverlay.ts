import { allocateAgentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import type { DelegationManager } from '../services/delegation/manager.ts';
import type { Task } from '../services/store/types.ts';
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from '../types/config.ts';
import { formatOverlayTaskLine } from './format.ts';
import { deriveTaskProjection, selectOverlayLayoutFromProjection, visibleTasks } from './selectors.ts';

const WIDGET_KEY = 'doom-tasks';
const OVERLAY_HEADING = 'Tasks';
const PROGRESS_TICK_MS = 1000;

export interface TaskOverlayOptions {
  getTasks: () => readonly Task[];
  delegation: DelegationManager;
}

/**
 * Persistent widget listing tasks above the editor.
 *
 * Registered once per UI context and refreshed with `requestRender()`; it
 * auto-hides when there is nothing to show so an idle session keeps a clean
 * prompt.
 */
export class TaskOverlay {
  private readonly options: TaskOverlayOptions;
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private progressTimer: NodeJS.Timeout | undefined;
  private collapsed = false;

  constructor(options: TaskOverlayOptions) {
    this.options = options;
  }

  /** Identity-compare so repeated session_start handlers stay idempotent. */
  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx === this.uiCtx) return;
    if (this.uiCtx && this.widgetRegistered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.stopProgressTimer();
    this.uiCtx = ctx;
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  update(): void {
    if (!this.uiCtx) {
      this.stopProgressTimer();
      return;
    }
    const tasks = visibleTasks(this.options.getTasks());

    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      this.stopProgressTimer();
      return;
    }

    if (this.widgetRegistered) {
      this.syncProgressTimer(tasks);
      this.tui?.requestRender();
      return;
    }

    this.uiCtx.setWidget(
      WIDGET_KEY,
      (tui, factoryTheme) => {
        this.tui = tui;
        return {
          render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
          invalidate: () => {
            // Nothing is cached: the next render reads the live theme and store.
          },
        };
      },
      { placement: 'aboveEditor' },
    );
    this.widgetRegistered = true;
    this.syncProgressTimer(tasks);
  }

  private syncProgressTimer(tasks: readonly Task[]): void {
    const hasRunningDelegation = tasks.some(
      (task) => task.status !== 'deleted' && task.delegation?.state === 'running',
    );
    if (this.collapsed || !this.widgetRegistered || !hasRunningDelegation) {
      this.stopProgressTimer();
      return;
    }
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => this.tui?.requestRender(), PROGRESS_TICK_MS);
    this.progressTimer.unref?.();
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.syncProgressTimer(this.options.getTasks());
    // Forced redraw: collapsing changes the widget height, not just its content.
    this.tui?.requestRender(true);
  }

  isRegistered(): boolean {
    return this.widgetRegistered;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const projection = deriveTaskProjection(this.options.getTasks());
    if (projection.visible.length === 0) return [];

    const truncate = (line: string): string => truncateToWidth(line, width, '…');
    const headingColor = projection.hasActiveWork ? 'accent' : 'dim';
    const headingIcon = projection.hasActiveWork ? '●' : '○';
    let headingText = `${OVERLAY_HEADING} (${projection.counts.completed}/${projection.counts.total})`;
    if (projection.counts.failed > 0) headingText += ` · ${projection.counts.failed} failed`;
    const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

    if (this.collapsed) {
      const key = resolveCollapseKey();
      const hint = key === COLLAPSE_KEY_OFF ? 'collapsed' : `${key} to expand`;
      return this.withTrailingSpacer([heading, truncate(`${theme.fg('dim', '└─')} ${theme.fg('dim', hint)}`)]);
    }

    const layout = selectOverlayLayoutFromProjection(projection, getMaxWidgetLines() - 1);
    const occupiedColors = new Set<ReturnType<typeof allocateAgentIdentityColor>>();
    const agentColors = new Map<string, ReturnType<typeof allocateAgentIdentityColor>>();
    for (const task of layout.visible) {
      if (task.delegation?.state !== 'running') continue;
      const identity = task.delegation.runId ?? task.delegation.requestId;
      const color = allocateAgentIdentityColor(identity, occupiedColors);
      occupiedColors.add(color);
      agentColors.set(identity, color);
    }

    const nowMs = Date.now();
    const lines = [heading];
    for (const task of layout.visible) {
      const progress = this.options.delegation.progressFor(task);
      const identity = task.delegation?.runId ?? task.delegation?.requestId;
      lines.push(
        truncate(
          `${theme.fg('dim', '├─')} ${formatOverlayTaskLine(
            task,
            theme,
            projection.showIds,
            progress,
            nowMs,
            identity ? agentColors.get(identity) : undefined,
          )}`,
        ),
      );
    }

    const hidden = layout.hiddenCompleted + layout.truncatedTail;
    if (hidden === 0) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace('├─', '└─');
      return this.withTrailingSpacer(lines);
    }

    const parts: string[] = [];
    if (layout.hiddenCompleted > 0) parts.push(`${layout.hiddenCompleted} completed`);
    if (layout.truncatedTail > 0) parts.push(`${layout.truncatedTail} pending`);
    const summary = parts.length > 0 ? `+${hidden} more (${parts.join(', ')})` : `+${hidden} more`;
    lines.push(truncate(`${theme.fg('dim', '└─')} ${theme.fg('dim', summary)}`));
    return this.withTrailingSpacer(lines);
  }

  /** Pi adds a spacer above the widget but none below, which glues the last row to the input box. */
  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    lines.push('');
    return lines;
  }

  dispose(): void {
    this.stopProgressTimer();
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.collapsed = false;
  }
}
