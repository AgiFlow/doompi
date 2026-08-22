/**
 * Runner Space: the `SPC r l` overlay.
 *
 * Two modes behind one component. The list shows every runner in this worktree
 * and can stop them; attaching to an interactive runner renders its live
 * terminal and forwards keystrokes to it, which is the whole reason PTY runs
 * exist. Rendering is pure, so the surface can be asserted as text.
 */

import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { PtyRun } from '../types/ptyHost';
import type { RunnerRecord } from '../types/runnerRegistry';
import { toRunnerRows } from './format.ts';

export const RUNNER_SPACE_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;

const KEY_ENTER = '\r';
const KEY_NEWLINE = '\n';
const TITLE = 'RUNNER SPACE';
const EMPTY_MESSAGE = 'No background runners. bash backgrounds anything that outlives the threshold.';
const LIST_FOOTER = `${DOOM_NAVIGATION_KEYS.list} select · enter open · s stop · r reason · esc close`;
const ATTACH_FOOTER = 'esc back · everything else goes to the runner';
const LOG_FOOTER = 'esc back · live stdout/stderr';
const LOG_REFRESH_MS = 250;
const ELLIPSIS = '…';

export interface RunnerSpaceOptions {
  getRunners: () => readonly RunnerRecord[];
  /** The hosted terminal for a runner, when this session owns one. */
  getPtyRun: (name: string) => PtyRun | undefined;
  readLog: (logPath: string) => string;
  stopRunner: (id: string, reason?: string) => Promise<void>;
}

export class RunnerSpaceComponent extends DoomOverlay {
  private selected = 0;
  private attached: PtyRun | undefined;
  private viewedLog: RunnerRecord | undefined;
  private unsubscribe: (() => void) | undefined;
  private logRefresh: ReturnType<typeof setInterval> | undefined;
  private notice: { text: string; color: 'success' | 'error' } | undefined;
  private stopReason: { runner: RunnerRecord; text: string } | undefined;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly options: RunnerSpaceOptions,
    private readonly done: (result: undefined) => void,
  ) {
    super(tui, theme);
  }

  handleInput(data: string): void {
    if (this.stopReason) {
      this.handleStopReasonInput(data);
      return;
    }
    if (this.attached) {
      this.handleAttachedInput(data);
      return;
    }
    if (this.viewedLog) {
      if (matchesKey(data, 'escape')) this.detach();
      return;
    }
    this.handleListInput(data);
  }

  protected getChrome(): DoomOverlayChrome {
    const runners = this.options.getRunners();
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: 'SPC › r / runners › r / runner space',
      headerRight: this.attached
        ? `attached · ${this.attached.name}`
        : this.viewedLog
          ? `logs · ${this.viewedLog.name}`
          : `${runners.length} runners · this worktree`,
      footer: this.attached ? ATTACH_FOOTER : this.viewedLog ? LOG_FOOTER : LIST_FOOTER,
      footerHints:
        this.attached || this.viewedLog
          ? undefined
          : [
              [DOOM_NAVIGATION_KEYS.list, 'select'],
              ['enter', 'open'],
              ['s', 'stop'],
              ['r', 'reason'],
              ['esc', 'close'],
            ],
      footerRight: this.attached
        ? 'live tty'
        : this.viewedLog
          ? 'live log'
          : runners.length > 0
            ? `${Math.min(this.selected, runners.length - 1) + 1}/${runners.length}`
            : 'empty',
    };
  }

  protected renderBody(width: number, height: number): string[] {
    const truncate = (line: string): string => truncateToWidth(line, width, ELLIPSIS);
    if (this.attached) return this.renderAttached(truncate, height);
    if (this.viewedLog) return this.renderLog(truncate, height);
    return this.renderList(truncate, height);
  }

  private handleAttachedInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.detach();
      return;
    }
    this.attached?.write(data);
  }

  private handleListInput(data: string): void {
    const runners = this.options.getRunners();

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.close();
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') this.move(-1, runners.length);
    else if (matchesKey(data, 'down') || data === 'j') this.move(1, runners.length);
    else if (data === KEY_ENTER || data === KEY_NEWLINE) this.attach(runners);
    else if (data === 's') this.stop(runners);
    else if (data === 'r') this.promptStopReason(runners);
  }

  private move(delta: number, count: number): void {
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    this.notice = undefined;
    this.tui.requestRender();
  }

  private current(runners: readonly RunnerRecord[]): RunnerRecord | undefined {
    if (runners.length === 0) return undefined;
    return runners[Math.min(this.selected, runners.length - 1)];
  }

  private attach(runners: readonly RunnerRecord[]): void {
    const record = this.current(runners);
    if (!record) return;

    const run = record.interactive ? this.options.getPtyRun(record.name) : undefined;
    this.notice = undefined;
    if (run) {
      this.attached = run;
      this.unsubscribe = run.onData(() => this.tui.requestRender());
    } else {
      this.viewedLog = record;
      this.logRefresh = setInterval(() => this.tui.requestRender(true), LOG_REFRESH_MS);
      this.logRefresh.unref?.();
    }
    this.tui.requestRender(true);
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.logRefresh) clearInterval(this.logRefresh);
    this.logRefresh = undefined;
    this.attached = undefined;
    this.viewedLog = undefined;
    this.tui.requestRender(true);
  }

  private stop(runners: readonly RunnerRecord[]): void {
    const record = this.current(runners);
    if (!record) return;

    this.options
      .stopRunner(record.id)
      .then(() => {
        this.notice = { text: `Stopped ${record.name}`, color: 'success' };
        this.tui.requestRender(true);
      })
      .catch((error: unknown) => {
        // Shown rather than swallowed: a failed stop means the process is still
        // running and the operator needs to know.
        this.notice = { text: error instanceof Error ? error.message : String(error), color: 'error' };
        this.tui.requestRender();
      });
  }

  private promptStopReason(runners: readonly RunnerRecord[]): void {
    const runner = this.current(runners);
    if (!runner) return;
    this.stopReason = { runner, text: '' };
    this.tui.requestRender();
  }

  private handleStopReasonInput(data: string): void {
    const prompt = this.stopReason;
    if (!prompt) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.stopReason = undefined;
      this.tui.requestRender();
      return;
    }
    if (data === KEY_ENTER || data === KEY_NEWLINE) {
      this.stopReason = undefined;
      this.options
        .stopRunner(prompt.runner.id, prompt.text.trim() || undefined)
        .then(() => {
          this.notice = { text: `Stopped ${prompt.runner.name}`, color: 'success' };
          this.tui.requestRender(true);
        })
        .catch((error: unknown) => {
          this.notice = { text: error instanceof Error ? error.message : String(error), color: 'error' };
          this.tui.requestRender();
        });
      return;
    }
    if (matchesKey(data, 'backspace')) prompt.text = prompt.text.slice(0, -1);
    else if (!data.includes('\u001b')) prompt.text += data;
    this.tui.requestRender();
  }

  private close(): void {
    this.detach();
    this.done(undefined);
  }

  private renderList(truncate: (line: string) => string, height: number): string[] {
    const runners = this.options.getRunners();
    const rows = toRunnerRows(runners, Date.now());
    const lines: string[] = [];

    if (this.stopReason) {
      return [truncate(`Stop reason for ${this.stopReason.runner.name}: ${this.stopReason.text}`)];
    }

    if (rows.length === 0) lines.push(truncate(this.theme.fg('dim', EMPTY_MESSAGE)));
    else {
      const noticeRows = this.notice ? 2 : 0;
      const capacity = Math.max(1, height - noticeRows);
      const maxStart = Math.max(0, rows.length - capacity);
      const start = Math.min(maxStart, Math.max(0, this.selected - capacity + 1));
      rows.slice(start, start + capacity).forEach((row, offset) => {
        const index = start + offset;
        const marker = index === Math.min(this.selected, rows.length - 1) ? '›' : ' ';
        const tty = row.interactive ? ' [tty]' : '';
        lines.push(truncate(`${marker} ${row.name}${tty}  ${this.theme.fg('dim', row.detail)}`));
      });
    }

    if (this.notice) lines.push('', truncate(this.theme.fg(this.notice.color, this.notice.text)));
    return lines.slice(0, height);
  }

  private renderAttached(truncate: (line: string) => string, height: number): string[] {
    const run = this.attached;
    if (!run) return [];

    return run.screen().split('\n').slice(-height).map(truncate);
  }

  private renderLog(truncate: (line: string) => string, height: number): string[] {
    const record = this.viewedLog;
    if (!record) return [];

    const text = this.options.readLog(record.logPath);
    if (!text) return [truncate(this.theme.fg('dim', 'Waiting for output…'))];
    return text.split('\n').slice(-height).map(truncate);
  }
}

export async function openRunnerSpace(ctx: ExtensionContext, options: RunnerSpaceOptions): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new RunnerSpaceComponent(tui, theme, options, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
