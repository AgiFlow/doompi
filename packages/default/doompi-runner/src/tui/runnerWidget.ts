import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, truncateToWidth } from '@earendil-works/pi-tui';
import type { RunnerRecord } from '../types/runnerRegistry';
import { formatWidgetHeading, formatWidgetLine, WIDGET_KEY } from './format.ts';

const MAX_LINES = 8;
const ELLIPSIS = '…';

export interface RunnerWidgetOptions {
  getRunners: () => readonly RunnerRecord[];
}

/**
 * Persistent list of background runners above the editor.
 *
 * Mirrors doom-task's overlay mechanics: registered once per UI context,
 * refreshed with `requestRender()`, and removed entirely when nothing is
 * running so an idle session keeps a clean prompt.
 */
export class RunnerWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private registered = false;
  private tui: TUI | undefined;

  constructor(private readonly options: RunnerWidgetOptions) {}

  /** Identity-compare so repeated session_start handlers stay idempotent. */
  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx === this.uiCtx) return;
    this.uiCtx = ctx;
    this.registered = false;
    this.tui = undefined;
  }

  update(): void {
    if (!this.uiCtx) return;

    if (this.options.getRunners().length === 0) {
      if (this.registered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
      }
      return;
    }

    if (this.registered) {
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
            // Nothing is cached: the next render reads the live theme and list.
          },
        };
      },
      { placement: 'aboveEditor' },
    );
    this.registered = true;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  dispose(): void {
    if (this.registered) this.uiCtx?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const runners = this.options.getRunners();
    if (runners.length === 0) return [];

    const truncate = (line: string): string => truncateToWidth(line, width, ELLIPSIS);
    const now = Date.now();
    const lines = [truncate(theme.fg('accent', `● ${formatWidgetHeading(runners.length)}`))];

    for (const record of runners.slice(0, MAX_LINES)) {
      lines.push(truncate(`${theme.fg('dim', '├─')} ${formatWidgetLine(record, now)}`));
    }

    const hidden = runners.length - Math.min(runners.length, MAX_LINES);
    if (hidden > 0) lines.push(truncate(`${theme.fg('dim', '└─')} ${theme.fg('dim', `+${hidden} more`)}`));
    else {
      const last = lines.length - 1;
      lines[last] = lines[last].replace('├─', '└─');
    }

    // Pi adds a spacer above a widget but none below, which would glue the last
    // row to the input box.
    return [...lines, ''];
  }
}
