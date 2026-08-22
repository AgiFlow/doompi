import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type {
  DoomLoopLaunchersService,
  LoopInstanceSnapshot,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

const EMPTY_MESSAGE = 'No loop instances are active in this session.';
const STOP_SCOPE_MESSAGE = 'Stopping a loop does not cancel detached work already launched.';
const STOP_REASON = 'Stopped from the loop list.';

export class LoopListOverlay extends DoomOverlay {
  private readonly unsubscribe: () => void;
  private instances: readonly LoopInstanceSnapshot[];
  private selected = 0;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly client: DoomLoopLaunchersService,
    private readonly done: (result: undefined) => void,
  ) {
    super(tui, theme);
    this.instances = client.listInstances();
    this.unsubscribe = client.subscribe(() => this.refresh());
  }

  dispose(): void {
    this.unsubscribe();
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
    if (data === 'x') {
      const instance = this.instances[this.selected];
      if (instance) void this.client.stop(instance.instanceId, STOP_REASON);
    }
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: 'LOOPS',
      breadcrumb: 'SPC › l / loops › l / list',
      headerRight: `${this.instances.length} active`,
      footer: `${DOOM_NAVIGATION_KEYS.list} move · x stop · esc close · launched detached work continues`,
      footerHints: [
        [DOOM_NAVIGATION_KEYS.list, 'move'],
        ['x', 'stop scheduling'],
        ['esc', 'close'],
      ],
      accent: DOOM_OVERLAY_ACCENT,
    };
  }

  protected renderBody(width: number): string[] {
    const stopScope = this.theme.fg('dim', truncateToWidth(STOP_SCOPE_MESSAGE, width));
    if (!this.instances.length) return [this.theme.fg('dim', EMPTY_MESSAGE), '', stopScope];
    return [
      stopScope,
      '',
      ...this.instances.flatMap((instance, index) => {
        const marker = index === this.selected ? this.theme.fg('accent', '▸') : ' ';
        const name = instance.label ?? instance.launcherLabel;
        const state = this.theme.fg(instance.state === 'running' ? 'success' : 'warning', instance.state);
        const line = truncateToWidth(`${marker} ${name} · ${state}`, width);
        const detail = instance.detail ?? instance.instanceId;
        return [line, `    ${this.theme.fg('dim', truncateToWidth(detail, Math.max(0, width - 4)))}`];
      }),
    ];
  }

  private refresh(): void {
    this.instances = this.client.listInstances();
    this.selected = Math.min(this.selected, Math.max(0, this.instances.length - 1));
    this.invalidate();
  }

  private move(delta: number): void {
    if (!this.instances.length) return;
    this.selected = Math.max(0, Math.min(this.selected + delta, this.instances.length - 1));
    this.invalidate();
  }
}

export async function openLoopListOverlay(ctx: ExtensionContext, client: DoomLoopLaunchersService): Promise<void> {
  if (ctx.mode !== 'tui') {
    const instances = client.listInstances();
    const labels = instances.map((instance) => `${instance.label ?? instance.launcherLabel} (${instance.instanceId})`);
    const selected = await ctx.ui.select('Stop loop scheduling', labels);
    const instance = instances[labels.indexOf(selected ?? '')];
    if (instance) await client.stop(instance.instanceId, STOP_REASON);
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new LoopListOverlay(tui, theme, client, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
