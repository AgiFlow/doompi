import { type AppKeybinding, CustomEditor, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import { type EditorOptions, type EditorTheme, parseKey, type TUI } from '@earendil-works/pi-tui';
import { type DoomLeaderAction, type DoomLeaderGroup, DoomLeaderRegistry } from '../services/leader/leaderRegistry.ts';
import { type DoomUiState, type LeaderSnapshot } from '../services/state/uiState.ts';
import { readDoomHarnessMetadata } from '../types/harnessMetadata.ts';
import { alignLine, fitLine, frameLine, padLine } from './rendering.ts';

export interface DoomEditorLeaderOptions {
  /** Overrides the harness major mode shown while the leader is inactive. */
  majorMode?: string;
  registry?: DoomLeaderRegistry;
  isCommandAvailable?: (commandName: string) => boolean;
  onUnavailableCommand?: (commandName: string) => void;
  onUnavailableAction?: (action: string) => void;
  onLeaderAction?: (source: string, actionName: string) => void;
}

type SnapshotHandler = (snapshot: LeaderSnapshot) => void;
type ChromeTheme = Pick<Theme, 'bg' | 'bold' | 'fg' | 'inverse'>;

const MIN_CHROME_WIDTH = 12;
const EDITOR_CHROME_INSET = 4;
const FRAME_OVERHEAD = 2;
const BORDER_THRESHOLD_INSET = 10;
const MIN_BORDER_SEGMENTS = 1;
const APP_EXIT_ACTION = 'app.exit';
const ESCAPE_KEY = 'escape';
const BACKSPACE_KEY = 'backspace';
const SPACE_KEY = 'space';
const GLOBAL_LEADER_KEY = 'ctrl+space';
const LEADER_PREFIX = 'SPC';
const BORDER_COLOR = 'borderAccent';
const DIM_COLOR = 'dim';
const ACCENT_COLOR = 'accent';
const HEADING_COLOR = 'mdHeading';
const MUTED_BORDER_COLOR = 'borderMuted';
/** Between mode names in the badge row. */
const MODE_SEPARATOR = ' · ';
const DOMAIN_SEPARATOR = ', ';
const VERTICAL_BORDER = '│';
const HORIZONTAL_BORDER = '─';
const PLAIN_CHROME_THEME: ChromeTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
  inverse: (text) => text,
};
const INACTIVE_SNAPSHOT: LeaderSnapshot = {
  active: false,
  prefix: [],
  label: '',
  options: [],
};

export class DoomEditor extends CustomEditor {
  private readonly chromeTheme: ChromeTheme;
  private readonly leaderRegistry: DoomLeaderRegistry;
  private readonly majorMode: string;
  private readonly isCommandAvailable: (commandName: string) => boolean;
  private readonly onUnavailableCommand: (commandName: string) => void;
  private readonly onUnavailableAction: (action: string) => void;
  private readonly onLeaderAction: ((source: string, actionName: string) => void) | undefined;
  private readonly unsubscribeLeaderRegistry: () => void;
  private readonly unsubscribeUiState: () => void;
  private leaderActive = false;
  private leaderPath: string[] = [];

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly uiState: DoomUiState,
    private readonly onSnapshot: SnapshotHandler,
    options?: EditorOptions,
    chromeTheme: ChromeTheme = PLAIN_CHROME_THEME,
    leaderOptions: DoomEditorLeaderOptions = {},
  ) {
    super(tui, editorTheme, keybindings, options);
    this.chromeTheme = chromeTheme;
    this.leaderRegistry = leaderOptions.registry ?? new DoomLeaderRegistry();
    this.majorMode = leaderOptions.majorMode?.trim() || readDoomHarnessMetadata().majorMode;
    this.isCommandAvailable = leaderOptions.isCommandAvailable ?? (() => true);
    this.onUnavailableCommand = leaderOptions.onUnavailableCommand ?? (() => undefined);
    this.onUnavailableAction = leaderOptions.onUnavailableAction ?? (() => undefined);
    this.onLeaderAction = leaderOptions.onLeaderAction;
    this.unsubscribeLeaderRegistry = this.leaderRegistry.subscribe(() => {
      if (this.leaderActive) this.publishLeader();
    });
    // A mode toggling changes the badge row and nothing else about the editor,
    // so without this the new name waits for the next keystroke to appear.
    this.unsubscribeUiState = this.uiState.subscribe(() => tui.requestRender());
  }

  handleInput(data: string): void {
    const key = parseKey(data);

    if (this.leaderActive) {
      this.handleLeaderInput(key);
      return;
    }

    if ((key === SPACE_KEY && this.getText().length === 0) || key === GLOBAL_LEADER_KEY) {
      this.startLeader();
      return;
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    if (width < MIN_CHROME_WIDTH) return super.render(width);

    const editorWidth = width - EDITOR_CHROME_INSET;
    const base = super.render(editorWidth);
    if (base.length < 3) return base.map((line) => fitLine(line, width));

    const bottomIndex = this.findBottomBorder(base, editorWidth);
    const contentLines = base.slice(1, bottomIndex);
    const autocompleteLines = base.slice(bottomIndex + 1);
    const borderSide = this.chromeTheme.fg(BORDER_COLOR, VERTICAL_BORDER);
    const top = this.chromeTheme.fg(BORDER_COLOR, `╭${HORIZONTAL_BORDER.repeat(width - FRAME_OVERHEAD)}╮`);
    const bottom = this.chromeTheme.fg(BORDER_COLOR, `╰${HORIZONTAL_BORDER.repeat(width - FRAME_OVERHEAD)}╯`);
    const metadata = this.editorLine(
      alignLine(
        ` ${this.modeBadge()}${this.modeNames()}${this.domainNames()}`,
        this.chromeTheme.fg(DIM_COLOR, `${this.editorStatus()} `),
        width - FRAME_OVERHEAD,
      ),
      width,
      borderSide,
    );
    const promptLines = contentLines.map((line, index) => {
      const prompt = index === 0 ? this.chromeTheme.bold(this.chromeTheme.fg(ACCENT_COLOR, '❯ ')) : '  ';
      return this.editorLine(`${prompt}${line}`, width, borderSide);
    });
    // The badge and the prompt are separate registers; a rule separates them
    // without the mode label reading as a caption on the input. Junctions take
    // the frame colour so the border stays unbroken through the row.
    const divider = `${this.chromeTheme.fg(BORDER_COLOR, '├')}${this.chromeTheme.fg(
      MUTED_BORDER_COLOR,
      HORIZONTAL_BORDER.repeat(width - FRAME_OVERHEAD),
    )}${this.chromeTheme.fg(BORDER_COLOR, '┤')}`;

    return [
      top,
      metadata,
      divider,
      ...promptLines,
      bottom,
      ...autocompleteLines.map((line) => fitLine(`  ${line}`, width)),
    ];
  }

  dispose(): void {
    this.unsubscribeLeaderRegistry();
    this.unsubscribeUiState();
    this.cancelLeader();
  }

  private startLeader(): void {
    this.leaderActive = true;
    this.leaderPath = [];
    this.publishLeader();
  }

  private cancelLeader(): void {
    this.leaderActive = false;
    this.leaderPath = [];
    this.publish(INACTIVE_SNAPSHOT);
  }

  private handleLeaderInput(key: string | undefined): void {
    if (key === ESCAPE_KEY) {
      this.cancelLeader();
      return;
    }
    if (key === BACKSPACE_KEY) {
      if (this.leaderPath.length === 0) this.cancelLeader();
      else {
        this.leaderPath.pop();
        this.publishLeader();
      }
      return;
    }
    if (!key || key.length !== 1) {
      this.cancelLeader();
      return;
    }

    const lowerKey = key.toLowerCase();
    const option = this.currentGroup()?.options.find((candidate) => candidate.key === lowerKey);
    if (!option) {
      this.cancelLeader();
      return;
    }
    if (option.hasChildren) {
      this.leaderPath.push(lowerKey);
      this.publishLeader();
      return;
    }
    if (!option.action) {
      this.cancelLeader();
      return;
    }

    this.cancelLeader();
    this.execute(option.action);
  }

  private currentGroup(): DoomLeaderGroup | undefined {
    return this.leaderRegistry.getGroup(this.leaderPath);
  }

  private publishLeader(): void {
    const group = this.currentGroup();
    if (!group) {
      this.cancelLeader();
      return;
    }
    const root = this.leaderRegistry.getGroup([]);
    this.publish({
      active: true,
      prefix: [LEADER_PREFIX, ...this.leaderPath],
      label: group.label,
      options: group.options.map((option) => ({
        key: option.key,
        label: option.label,
        ...(option.detail ? { detail: option.detail } : {}),
        ...(option.tone ? { tone: option.tone } : {}),
      })),
      rootOptions:
        root?.options.map((option) => ({
          key: option.key,
          label: option.label,
          ...(option.detail ? { detail: option.detail } : {}),
        })) ?? [],
    });
  }

  private publish(snapshot: LeaderSnapshot): void {
    this.uiState.setLeader(snapshot);
    this.onSnapshot(snapshot);
    this.tui.requestRender();
  }

  private execute(action: DoomLeaderAction): void {
    if (action.type === 'app') {
      const handler = this.actionHandlers.get(action.action as AppKeybinding);
      if (handler) {
        handler();
        return;
      }
      if (action.action === APP_EXIT_ACTION) {
        this.onCtrlD?.();
        return;
      }
      this.onUnavailableAction(action.action);
      return;
    }
    if (action.type === 'command') {
      this.submitCommand(action.command.name, action.command.args);
      return;
    }
    if (this.onLeaderAction) this.onLeaderAction(action.source, action.action.name);
    else this.onUnavailableAction(`${action.source}:${action.action.name}`);
  }

  private submitCommand(commandName: string, args?: string): void {
    if (!this.isCommandAvailable(commandName)) {
      this.onUnavailableCommand(commandName);
      return;
    }
    const draft = this.getText();
    const command = `/${commandName}${args ? ` ${args}` : ''}`;
    this.setText('');
    try {
      this.onSubmit?.(command);
    } finally {
      this.setText(draft);
    }
  }

  private modeLabel(): string {
    if (this.leaderActive) return `LEADER ${[LEADER_PREFIX, ...this.leaderPath].join(' ')}`;
    return this.majorMode.toUpperCase();
  }

  private modeBadge(): string {
    const label = ` ${this.modeLabel()} `;
    const color = this.leaderActive ? HEADING_COLOR : ACCENT_COLOR;
    return this.chromeTheme.inverse(this.chromeTheme.bold(this.chromeTheme.fg(color, label)));
  }

  /**
   * The enabled modes, names only, beside the editor's own mode badge.
   *
   * Names only because this row is glanced at, not read: which modes are on is
   * the whole question here, and their sub-state belongs where there is room to
   * explain it. The leader panel carries that longer form.
   *
   * Empty when nothing is on, so an ordinary session pays no columns for a
   * feature it is not using.
   */
  private modeNames(): string {
    const modes = this.uiState.getModes();
    if (modes.length === 0) return '';
    const separator = this.chromeTheme.fg(DIM_COLOR, MODE_SEPARATOR);
    const names = modes.map((mode) => this.chromeTheme.fg(ACCENT_COLOR, mode.label.toLowerCase())).join(separator);
    return `  ${names}`;
  }

  private domainNames(): string {
    const domains = readDoomHarnessMetadata().domains;
    if (domains.length === 0) return '';
    return this.chromeTheme.fg(DIM_COLOR, `  ${domains.join(DOMAIN_SEPARATOR)}`);
  }

  private editorStatus(): string {
    if (this.leaderActive) return 'draft preserved · esc cancel';
    const draftLength = this.getText().length;
    return draftLength === 0 ? 'draft 0 · ^SPC leader · SPC shortcut' : `draft ${draftLength} · ^SPC leader`;
  }

  private editorLine(content: string, width: number, side: string): string {
    // No background fill: the frame alone delimits the editor, and a painted
    // interior reads as a shadow behind the prompt.
    return frameLine(padLine(content, width - FRAME_OVERHEAD), width, side, side);
  }

  private findBottomBorder(lines: string[], editorWidth: number): number {
    const threshold = Math.max(MIN_BORDER_SEGMENTS, editorWidth - BORDER_THRESHOLD_INSET);
    const index = lines.findIndex((line, lineIndex) => {
      if (lineIndex === 0) return false;
      return line.split(HORIZONTAL_BORDER).length - MIN_BORDER_SEGMENTS >= threshold;
    });
    return index > 0 ? index : lines.length - 1;
  }
}
