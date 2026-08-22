import path from 'node:path';
import {
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { FileDiff, FileEditEntry, FileEditState, ResolvedEditor } from '../types/domain';

export type FileEditOverlayAction = 'close' | 'copy' | 'refresh' | 'open';

export interface FileEditOverlayResult {
  action: FileEditOverlayAction;
  index: number;
}

export interface FileEditOverlayView {
  cwd: string;
  entries: FileEditEntry[];
  diffs: FileDiff[];
  editor: ResolvedEditor | undefined;
  configPath: string;
}

const MIN_WIDTH = 60;
const LEFT_RATIO = 0.55;
const EDITOR_ROWS = 5;
const ENTRY_ROWS = 2;

/** The palette names are not exported, so take the union from the method. */
type ThemeColor = Parameters<Theme['fg']>[0];

const DIM: ThemeColor = 'dim';
const ACCENT: ThemeColor = 'accent';
const ADDED: ThemeColor = 'success';
const REMOVED: ThemeColor = 'error';
const CHANGED: ThemeColor = 'warning';
const BODY: ThemeColor = 'text';
const RULE: ThemeColor = 'borderMuted';

/**
 * The states this surface branches on. `external` is the fallback for an entry
 * with no diff, so it is named here rather than repeated as a literal.
 */
const STATE = { added: 'added', deleted: 'deleted', external: 'external' } as const satisfies Record<
  string,
  FileEditState
>;

/** Diff-hunk prefixes, which decide a line's colour. */
const HUNK_PREFIX = '@@';
const ADDED_PREFIX = '+';
const REMOVED_PREFIX = '-';

function pad(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible > width ? truncateToWidth(text, width) : text + ' '.repeat(width - visible);
}

function time(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

export class FileEditOverlayComponent extends DoomOverlay {
  private selected = 0;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly view: FileEditOverlayView,
    private readonly done: (result: FileEditOverlayResult) => void,
  ) {
    super(tui, theme);
  }

  protected getChrome(): DoomOverlayChrome {
    const totalEdits = this.view.entries.reduce((sum, entry) => sum + entry.count, 0);
    return {
      title: 'FILE EDITS',
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: 'SPC › e / editor › f / files',
      headerRight: `${this.view.entries.length} files · ${totalEdits} edits · this session`,
      footer: '↑↓ select · enter open · y copy path · r refresh · esc close',
      footerHints: [
        ['↑↓', 'select'],
        ['enter', 'open'],
        ['y', 'copy path'],
        ['r', 'refresh'],
        ['esc', 'close'],
      ],
      footerRight: this.view.entries.length > 0 ? `${this.selected + 1}/${this.view.entries.length}` : 'empty',
    };
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') return this.finish('close');
    if (matchesKey(data, 'up')) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down')) this.selected = Math.min(this.view.entries.length - 1, this.selected + 1);
    else if (matchesKey(data, 'enter') && this.view.entries.length > 0) return this.finish('open');
    else if (data.toLowerCase() === 'y' && this.view.entries.length > 0) return this.finish('copy');
    else if (data.toLowerCase() === 'r') return this.finish('refresh');
    this.tui.requestRender();
  }

  protected renderBody(width: number, height: number): string[] {
    if (width < MIN_WIDTH) {
      const leftHeight = Math.max(1, Math.floor((height - 1) / 2));
      const rightHeight = Math.max(0, height - leftHeight - 1);
      return [
        ...this.leftColumn(width, leftHeight),
        this.theme.fg(RULE, '─'.repeat(width)),
        ...this.rightColumn(width, rightHeight),
      ];
    }

    const leftWidth = Math.floor(width * LEFT_RATIO);
    const rightWidth = width - leftWidth - 1;
    // A blank column each side of the divider: flush columns let a long path in
    // one pane run straight into the other pane's heading.
    const leftContent = Math.max(1, leftWidth - 1);
    const rightContent = Math.max(1, rightWidth - 1);
    const left = this.leftColumn(leftContent, height);
    const right = this.rightColumn(rightContent, height);
    const divider = this.theme.fg(RULE, '│');
    return Array.from(
      { length: height },
      (_, index) => `${pad(left[index] ?? '', leftContent)} ${divider} ${pad(right[index] ?? '', rightContent)}`,
    );
  }

  private finish(action: FileEditOverlayAction): void {
    this.done({ action, index: this.selected });
  }

  private leftColumn(width: number, height: number): string[] {
    const lines = [this.theme.fg(DIM, ' EDITED THIS SESSION · most recent first')];
    if (this.view.entries.length === 0) {
      lines.push('', this.theme.fg(DIM, ' No files edited in this session yet.'));
    }

    const editorRows = height >= EDITOR_ROWS + ENTRY_ROWS ? EDITOR_ROWS : 0;
    const availableEntryRows = Math.max(0, height - lines.length - editorRows);
    const visibleEntries = Math.max(1, Math.floor(availableEntryRows / ENTRY_ROWS));
    const maxStart = Math.max(0, this.view.entries.length - visibleEntries);
    const start = Math.min(maxStart, Math.max(0, this.selected - visibleEntries + 1));
    const entries = this.view.entries.slice(start, start + visibleEntries);
    for (const [offset, entry] of entries.entries()) {
      const index = start + offset;
      const diff = this.view.diffs[index];
      const selected = index === this.selected ? this.theme.fg(ACCENT, '▌') : ' ';
      const relative = path.relative(this.view.cwd, entry.path) || path.basename(entry.path);
      const state = diff?.state ?? STATE.external;
      lines.push(`${selected}${time(entry.at)}  ${entry.count}x  ${entry.tool.padEnd(5)}  ${relative}`);
      lines.push(
        `  ${this.theme.fg(state === STATE.deleted ? REMOVED : state === STATE.added ? ADDED : CHANGED, state)}`,
      );
    }
    if (editorRows > 0) {
      lines.push('', this.theme.fg(DIM, ' EDITOR LAUNCH'));
      lines.push(` ${this.view.editor?.template ?? 'no command available'}`);
      lines.push(` ${this.theme.fg(DIM, this.view.editor?.source ?? this.view.configPath)}`);
      lines.push(this.theme.fg(DIM, ' configured → VISUAL → EDITOR → fallback; TUI suspends for terminal editors'));
      // Changing it lives in the config panel now, which this overlay cannot open
      // without depending on the package that depends on it.
      lines.push(this.theme.fg(DIM, ' SPC e c to change'));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }

  private rightColumn(width: number, height: number): string[] {
    const entry = this.view.entries[this.selected];
    const diff = this.view.diffs[this.selected];
    if (!entry || !diff) return [this.theme.fg(DIM, ' Select a file to review its diff.')];
    const name = path.basename(entry.path);
    const base = diff.tracked ? 'vs git HEAD' : 'full add';
    const lines = [` ${name}  ${this.theme.fg(DIM, base)}`];
    lines.push(
      ` ${this.theme.fg(ADDED, `+${diff.additions}`)} ${this.theme.fg(REMOVED, `-${diff.removals}`)} · ${entry.count} edits · ${diff.state}`,
    );
    for (const line of diff.lines) {
      const color = line.startsWith(HUNK_PREFIX)
        ? ACCENT
        : line.startsWith(ADDED_PREFIX)
          ? ADDED
          : line.startsWith(REMOVED_PREFIX)
            ? REMOVED
            : BODY;
      lines.push(this.theme.fg(color, line));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}
