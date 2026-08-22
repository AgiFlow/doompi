import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type { LoopLauncherSummary } from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

const EMPTY_MESSAGE = 'No loop launchers are registered for this session.';

export class StartLoopOverlay extends DoomOverlay {
  private selected = 0;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly launchers: readonly LoopLauncherSummary[],
    private readonly done: (result: string | undefined) => void,
  ) {
    super(tui, theme);
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
    if (matchesKey(data, 'enter')) this.done(this.launchers[this.selected]?.id);
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: 'START LOOP',
      breadcrumb: 'SPC › l / loops › s / start',
      footer: `${DOOM_NAVIGATION_KEYS.list} move · enter launch · esc close`,
      footerHints: [
        [DOOM_NAVIGATION_KEYS.list, 'move'],
        ['enter', 'launch'],
        ['esc', 'close'],
      ],
      accent: DOOM_OVERLAY_ACCENT,
    };
  }

  protected renderBody(width: number): string[] {
    if (!this.launchers.length) return [this.theme.fg('dim', EMPTY_MESSAGE)];
    return this.launchers.flatMap((launcher, index) => {
      const selected = index === this.selected;
      const marker = selected ? this.theme.fg('accent', '▸') : ' ';
      const label = selected ? this.theme.bold(launcher.label) : launcher.label;
      const lines = [`${marker} ${truncateToWidth(label, Math.max(0, width - 2))}`];
      if (launcher.description)
        lines.push(`    ${this.theme.fg('dim', truncateToWidth(launcher.description, Math.max(0, width - 4)))}`);
      return lines;
    });
  }

  private move(delta: number): void {
    if (!this.launchers.length) return;
    this.selected = Math.max(0, Math.min(this.selected + delta, this.launchers.length - 1));
    this.invalidate();
  }
}

export async function openStartLoopOverlay(
  ctx: ExtensionContext,
  launchers: readonly LoopLauncherSummary[],
): Promise<string | undefined> {
  if (ctx.mode !== 'tui') {
    const labels = launchers.map((launcher) => launcher.label);
    const selected = await ctx.ui.select('Start loop', labels);
    return launchers[labels.indexOf(selected ?? '')]?.id;
  }
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => new StartLoopOverlay(tui, theme, launchers, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
