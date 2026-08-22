/**
 * Run panel: the live view of one run's job tree and its terminal.
 *
 * A doom overlay rather than the bare header/body/footer it used to draw, so the
 * one surface a user sits inside for minutes at a time carries the same frame,
 * breadcrumb and key legend as every other. The base class owns the chrome and
 * hands the body an exact height, which also retires the hand-rolled row
 * arithmetic that existed only to stop Pi clipping the footer.
 *
 * Key routing is the reason this is a component rather than a renderer: a
 * focused panel receives input before Pi's global dispatcher, so the view
 * controls have to be handled here or the run's TTY swallows them.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { type KeyId, matchesKey } from '@earendil-works/pi-tui';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import { fit, fitTerminalLine } from './overlayText';
import { DoubleEscapeDetector } from './workflowOverlay';

const TITLE = 'WORKFLOW RUN';
const VIEW_ONLY = 'view only · this run is hosted natively';
const OUTPUT_HEADING = 'OUTPUT · newest last';
const WAITING = 'Waiting for output…';
/** A divider and its heading earn their rows only when output sits beneath them. */
const OUTPUT_CHROME_ROWS = 2;

export interface WorkflowRunPanelSnapshot {
  /** Job tree lines, already themed by the caller. */
  progress: string[];
  /** Recent terminal output for the running step. */
  output: string[];
}

export interface WorkflowRunPanelOptions {
  runKey: string;
  /** Full run label for the header, e.g. `name · workspace/runKey`. */
  label: string;
  breadcrumb: string;
  /** False for a natively hosted run, which has no terminal to type into. */
  interactive: boolean;
  /** Plain-sentence footer, used when the terminal cannot fit the key caps. */
  footer: string;
  /** Key legend, which differs between a typeable panel and a view. */
  hints: readonly (readonly [string, string])[];
  /** Given the body width, because the job tree is fitted as it is built. */
  snapshot: (width: number) => WorkflowRunPanelSnapshot;
  /**
   * The columns and rows the output pane can actually show, reported on each
   * paint so a launcher that supports resizing can match the run to them.
   * Called from render, so an implementation must not do the work inline: the
   * run's geometry changes out of band and the next poll picks up the reflow.
   */
  onViewport?: (columns: number, rows: number) => void;
  /** Hand typing back to the session, leaving the panel open. */
  onUnfollow: () => void;
  onClose: () => void;
  /** Forward a keystroke to the run. */
  sendInput: (data: string) => void;
  /**
   * Send whatever is buffered before the panel goes away, or the Escape that
   * closed it dies with the batcher.
   */
  flushInput: () => void;
  unfollowShortcut: KeyId;
  closeShortcut: KeyId;
  onDispose: () => void;
}

export class WorkflowRunPanelComponent extends DoomOverlay {
  private readonly escapes = new DoubleEscapeDetector();

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly options: WorkflowRunPanelOptions,
  ) {
    super(tui, theme);
  }

  /**
   * The chords are matched against the whole chunk, as Pi delivers one per key
   * event. A chord buried in a coalesced burst therefore misses, which is
   * acceptable now that double-Escape guarantees an exit: scanning for the bytes
   * anywhere in a chunk would instead eat legitimate input, since `\x1b\x17` is
   * also a valid Escape-then-ctrl+w for the run's own editor.
   */
  handleInput(data: string): void {
    if (matchesKey(data, this.options.unfollowShortcut)) {
      this.options.onUnfollow();
      return;
    }
    if (matchesKey(data, this.options.closeShortcut)) {
      this.options.onClose();
      return;
    }
    // The failsafe. The first Escape falls through to the run, so interrupting
    // the step is as fast as it ever was; only the second one inside the window
    // is consumed.
    if (this.escapes.observe(data) === 'close') {
      this.options.flushInput();
      this.options.onClose();
      return;
    }
    this.options.sendInput(data);
  }

  protected getChrome(): DoomOverlayChrome {
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: this.options.breadcrumb,
      headerRight: this.options.interactive ? this.options.label : `${this.options.label} · ${VIEW_ONLY}`,
      footer: this.options.footer,
      footerHints: this.options.hints,
      footerRight: this.options.interactive ? 'typing goes to the run' : 'typing stays here',
    };
  }

  /**
   * The tree is never truncated: knowing which job is running matters more than
   * seeing another line of output, so the terminal pane absorbs whatever the
   * tree does not use.
   */
  protected renderBody(width: number, height: number): string[] {
    const { progress, output } = this.options.snapshot(width);
    const tree = progress.slice(0, height).map((line) => fit(line, width));

    const spare = height - tree.length;
    if (spare <= OUTPUT_CHROME_ROWS) return tree.slice(0, height);

    const rows = spare - OUTPUT_CHROME_ROWS;
    this.options.onViewport?.(width, rows);
    // Output keeps its own colour, so it is fitted by the escape-preserving
    // path rather than the themed-row one; see `fitTerminalLine`.
    const tail = output.slice(-rows).map((line) => fitTerminalLine(line, width));
    return [
      ...tree,
      '',
      this.theme.fg('dim', OUTPUT_HEADING),
      ...(tail.length > 0 ? tail : [this.theme.fg('dim', WAITING)]),
    ].slice(0, height);
  }

  dispose(): void {
    this.options.onDispose();
  }
}

/**
 * A panel whose keys cannot reach anything must never take them. Pi focuses an
 * overlay on show unless told otherwise, which for a native run would swallow
 * the user's typing into a run with no terminal to receive it.
 */
export function runPanelUiOptions(interactive: boolean): Record<string, unknown> {
  return {
    ...DOOM_FULLSCREEN_UI_OPTIONS,
    overlayOptions: {
      ...DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions,
      ...(interactive ? {} : { nonCapturing: true }),
    },
  };
}

export type WorkflowRunPanelHost = Pick<ExtensionContext['ui'], 'custom'>;
