import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type { ExtensionContext, Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { GoalHistoryEntry, GoalHistoryStatus } from '../types/history.ts';

interface GoalHistoryManager {
  listHistory(context: ExtensionContext): Promise<GoalHistoryEntry[]>;
  restartFromHistory(id: string, context: ExtensionContext): Promise<void>;
  removeHistory(id: string, context: ExtensionContext): Promise<void>;
}

const EMPTY_MESSAGE = 'No archived Goals for this repository.';

const HISTORY_STATUS: Record<GoalHistoryStatus, { glyph: string; color: ThemeColor }> = {
  active: { glyph: '◐', color: 'warning' },
  queued: { glyph: '○', color: 'muted' },
  paused: { glyph: '■', color: 'muted' },
  blocked: { glyph: '!', color: 'error' },
  usage_limited: { glyph: '◆', color: 'warning' },
  budget_limited: { glyph: '◆', color: 'warning' },
  complete: { glyph: '✓', color: 'success' },
};

export class GoalHistoryOverlay extends DoomOverlay {
  private entries: GoalHistoryEntry[] = [];
  private selected = 0;
  private loading = true;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly manager: GoalHistoryManager,
    private readonly context: ExtensionContext,
    private readonly done: (result: undefined) => void,
  ) {
    super(tui, theme);
    void this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') {
      this.move(1);
      return;
    }
    if (matchesKey(data, 'enter') || data === '\r' || data === '\n') {
      void this.restartSelected();
      return;
    }
    if (data === 'x') void this.removeSelected();
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: 'GOAL HISTORY',
      breadcrumb: 'SPC › g / goal › p / history',
      headerRight: `${this.entries.length} archived`,
      footer: `${DOOM_NAVIGATION_KEYS.list} move · enter restart · x remove · esc close`,
      footerHints: [
        [DOOM_NAVIGATION_KEYS.list, 'move'],
        ['enter', 'restart'],
        ['x', 'remove'],
        ['esc', 'close'],
      ],
      accent: DOOM_OVERLAY_ACCENT,
    };
  }

  protected renderBody(width: number): string[] {
    if (this.loading) return [this.theme.fg('dim', 'Loading Goal history…')];
    if (this.entries.length === 0) return [this.theme.fg('dim', EMPTY_MESSAGE)];
    return this.entries.flatMap((entry, index) => {
      const marker = index === this.selected ? this.theme.fg('accent', '▸') : ' ';
      const objective = truncateToWidth(`${marker} ${entry.objective}`, width);
      const status = HISTORY_STATUS[entry.status];
      const statusText = this.theme.fg(status.color, `${status.glyph} ${entry.status}`);
      const archivedAt = this.theme.fg('dim', ` · ${new Date(entry.archivedAt).toLocaleString()}`);
      return [objective, truncateToWidth(`    ${statusText}${archivedAt}`, width)];
    });
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return;
    this.selected = Math.max(0, Math.min(this.selected + delta, this.entries.length - 1));
    this.invalidate();
  }

  private async refresh(): Promise<void> {
    try {
      this.entries = (await this.manager.listHistory(this.context)).toSorted(
        (left, right) => Date.parse(right.archivedAt) - Date.parse(left.archivedAt),
      );
      this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
    } catch {
      this.entries = [];
    } finally {
      this.loading = false;
      this.invalidate();
    }
  }

  private async restartSelected(): Promise<void> {
    const entry = this.entries[this.selected];
    if (!entry) return;
    await this.manager.restartFromHistory(entry.id, this.context);
    this.done(undefined);
  }

  private async removeSelected(): Promise<void> {
    const entry = this.entries[this.selected];
    if (!entry) return;
    const accepted = await this.context.ui.confirm('Remove Goal history?', entry.objective);
    if (!accepted) return;
    await this.manager.removeHistory(entry.id, this.context);
    await this.refresh();
  }
}

export async function openGoalHistoryOverlay(ctx: ExtensionContext, manager: GoalHistoryManager): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') {
    ctx.ui.notify('Goal history is available in the Doom TUI.', 'warning');
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new GoalHistoryOverlay(tui, theme, manager, ctx, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
