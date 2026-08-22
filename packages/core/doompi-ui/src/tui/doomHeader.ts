import path from 'node:path';
import { type ExtensionContext, type Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { type DoomHarnessMetadata, readDoomHarnessMetadata } from '../types/harnessMetadata.ts';
import { alignLine, fitLine, padLine } from './rendering.ts';

const WIDE_HEADER_WIDTH = 90;
const FULL_STARTUP_MIN_ROWS = 24;
// Rows Pi renders below the header: the four-line editor frame, the modeline,
// and the spacing around them. Under-reserving scrolls the dashboard off the top.
const RESERVED_INTERFACE_ROWS = 8;
const MIN_EMPTY_STATE_HEIGHT = 3;
const IDENTITY_COLUMN_WIDTH = 30;
const COLUMN_GAP = 3;
const MIN_RENDER_WIDTH = 4;
const SECTION_SEPARATOR_ROWS = 2;
/** Breathing room between the shell prompt Pi launched from and the dashboard. */
const TOP_PADDING_ROWS = 2;
const CONTEXT_LABEL_WIDTH = 12;
const SESSION_ID_PREVIEW_LENGTH = 6;
const EMPTY_STATE_RULE_LENGTH = 8;
const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_METADATA_LABEL = 'default';
const DEFAULT_MODEL_LABEL = 'no-model';
const DEFAULT_THINKING_LABEL = 'off';
const DEFAULT_LAYERS_LABEL = 'core';
const DEFAULT_SESSION_LABEL = 'new';
const BOOT_LABEL = 'BOOT / 01';
const READY_STATUS = '● READY';
const ACTIVE_STATUS = '● ACTIVE';
const EMPTY_STATE_LABEL = 'NO TRANSCRIPT YET';
const EMPTY_STATE_GUIDANCE = 'Describe the work below. Pi keeps your existing config and session history.';
const PRODUCT_DESCRIPTOR = 'Pi, configured for focus.';
const SEGMENT_SEPARATOR = ' · ';
const DISPLAY_SEPARATOR = ' / ';
const LIST_SEPARATOR = ', ';
const MESSAGE_ENTRY_TYPE = 'message';
const TIME_LOCALE = 'en-GB';
const HOME_ENV = 'HOME';
const CLAUDE_MODEL_PREFIX = /^claude-/;
const REPOSITORY_LABEL = 'REPOSITORY';
const PROFILE_LABEL = 'PROFILE';
const DOMAINS_LABEL = 'DOMAINS';
const LAYERS_LABEL = 'LAYERS';
const MODE_LABEL = 'MODE';
const MODEL_LABEL = 'MODEL';
const HORIZONTAL_BORDER = '─';
const IDENTITY_ACCENT_BAR = '▌';
const READY_RULE = '━━━━━━━━';
const EMPTY_STATE_RULE = HORIZONTAL_BORDER.repeat(EMPTY_STATE_RULE_LENGTH);
const DIM_COLOR: ThemeColor = 'dim';
const ACCENT_COLOR: ThemeColor = 'accent';
const SUCCESS_COLOR: ThemeColor = 'success';
const MUTED_COLOR: ThemeColor = 'muted';
const TEXT_COLOR: ThemeColor = 'text';
const CODE_COLOR: ThemeColor = 'mdCode';
const WARNING_COLOR: ThemeColor = 'warning';
const HEADING_COLOR: ThemeColor = 'mdHeading';
const SELECTED_BG_COLOR = 'selectedBg';
const MUTED_BORDER_COLOR: ThemeColor = 'borderMuted';

type MetadataReader = () => DoomHarnessMetadata;
type TerminalRowsReader = () => number;
type HeaderRuntime = Pick<ExtensionContext, 'isIdle' | 'model' | 'sessionManager' | 'thinkingLevel'>;

export class DoomHeader implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly cwd: string,
    private readonly readMetadata: MetadataReader = readDoomHarnessMetadata,
    private readonly runtime?: HeaderRuntime,
    private readonly getTerminalRows: TerminalRowsReader = () => DEFAULT_TERMINAL_ROWS,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < MIN_RENDER_WIDTH) return [this.hairline(width)];

    const metadata = this.readMetadata();
    const hasTranscript =
      this.runtime?.sessionManager.getEntries().some((entry) => entry.type === MESSAGE_ENTRY_TYPE) ?? false;
    if (hasTranscript) return [];

    const terminalRows = this.getTerminalRows();
    if (terminalRows < FULL_STARTUP_MIN_ROWS) return this.renderCompact(width, metadata);

    const dashboard =
      width < WIDE_HEADER_WIDTH
        ? this.renderNarrowDashboard(width, metadata)
        : this.renderWideDashboard(width, metadata);
    const hints = this.renderHints(width);
    const fixedHeaderRows = TOP_PADDING_ROWS + dashboard.length + hints.length + SECTION_SEPARATOR_ROWS;
    const emptyStateHeight = Math.max(MIN_EMPTY_STATE_HEIGHT, terminalRows - RESERVED_INTERFACE_ROWS - fixedHeaderRows);
    const topPadding = Array.from({ length: TOP_PADDING_ROWS }, () => '');

    return [...topPadding, ...dashboard, '', ...hints, '', ...this.renderEmptyState(width, emptyStateHeight)];
  }

  private renderWideDashboard(width: number, metadata: DoomHarnessMetadata): string[] {
    const contextWidth = Math.max(1, width - IDENTITY_COLUMN_WIDTH - COLUMN_GAP);
    const contextHeading = alignLine(
      this.theme.bold(this.theme.fg(HEADING_COLOR, 'SESSION CONTEXT')),
      this.theme.fg(
        DIM_COLOR,
        `${new Date().toLocaleTimeString(TIME_LOCALE, { hour12: false })}${DISPLAY_SEPARATOR}local`,
      ),
      contextWidth,
    );
    const repository = this.compactPath(metadata.root ?? this.cwd);
    const profile = metadata.profile ?? DEFAULT_METADATA_LABEL;
    const domains = metadata.domains.join(LIST_SEPARATOR) || DEFAULT_METADATA_LABEL;
    const layers = metadata.layers.join(SEGMENT_SEPARATOR) || DEFAULT_LAYERS_LABEL;
    const model = this.runtime?.model?.id ?? DEFAULT_MODEL_LABEL;
    const thinking = this.runtime?.thinkingLevel ?? DEFAULT_THINKING_LABEL;
    const ready = `${this.theme.fg(SUCCESS_COLOR, READY_RULE)} ${this.theme.bold(
      this.theme.fg(SUCCESS_COLOR, 'READY'),
    )}`;
    const rows = [
      this.columns(this.identityCell(this.theme.fg(DIM_COLOR, BOOT_LABEL)), contextHeading, width),
      this.columns(
        this.identityCell(this.wordmark()),
        this.contextRow(REPOSITORY_LABEL, repository, TEXT_COLOR),
        width,
      ),
      this.columns(
        this.identityCell(this.theme.fg(MUTED_COLOR, PRODUCT_DESCRIPTOR)),
        this.contextRow(PROFILE_LABEL, profile, CODE_COLOR),
        width,
      ),
      this.columns(this.identityCell(ready), this.contextRow(DOMAINS_LABEL, domains, ACCENT_COLOR), width),
      this.columns(this.identityCell(''), this.contextRow(LAYERS_LABEL, layers, MUTED_COLOR), width),
      this.columns(this.identityCell(''), this.contextRow(MODE_LABEL, metadata.majorMode, SUCCESS_COLOR), width),
      this.columns(
        this.identityCell(''),
        this.contextRow(MODEL_LABEL, `${model}${DISPLAY_SEPARATOR}${thinking}`, WARNING_COLOR),
        width,
      ),
    ];

    return [...rows, this.hairline(width)];
  }

  private renderNarrowDashboard(width: number, metadata: DoomHarnessMetadata): string[] {
    const repository = path.basename(metadata.root ?? this.cwd) || this.cwd;
    const profile = metadata.profile ?? DEFAULT_METADATA_LABEL;
    const domains = metadata.domains.join(LIST_SEPARATOR) || DEFAULT_METADATA_LABEL;
    const session =
      this.runtime?.sessionManager.getSessionId().slice(0, SESSION_ID_PREVIEW_LENGTH) ?? DEFAULT_SESSION_LABEL;
    const layers = metadata.layers.join(SEGMENT_SEPARATOR) || DEFAULT_LAYERS_LABEL;
    const model = this.compactModel(this.runtime?.model?.id ?? DEFAULT_MODEL_LABEL);
    const thinking = this.runtime?.thinkingLevel ?? DEFAULT_THINKING_LABEL;
    const ready = this.theme.bold(this.theme.fg(SUCCESS_COLOR, READY_STATUS));
    const rows = [
      alignLine(this.identityCell(`${this.theme.fg(DIM_COLOR, BOOT_LABEL)}  ${this.wordmark()}`), ready, width),
      this.identityCell(this.contextRow(REPOSITORY_LABEL, repository, TEXT_COLOR)),
      this.identityCell(
        this.contextRow(
          PROFILE_LABEL,
          `${profile}${DISPLAY_SEPARATOR}${domains}${DISPLAY_SEPARATOR}${session}`,
          CODE_COLOR,
        ),
      ),
      this.identityCell(this.contextRow(LAYERS_LABEL, layers, MUTED_COLOR)),
      this.identityCell(this.contextRow(MODE_LABEL, metadata.majorMode, SUCCESS_COLOR)),
      this.identityCell(this.contextRow(MODEL_LABEL, `${model}${DISPLAY_SEPARATOR}${thinking}`, WARNING_COLOR)),
    ].map((row) => fitLine(row, width));

    return [...rows, this.hairline(width)];
  }

  private renderCompact(width: number, metadata: DoomHarnessMetadata): string[] {
    const repository = path.basename(metadata.root ?? this.cwd) || this.cwd;
    const profile = metadata.profile ?? DEFAULT_METADATA_LABEL;
    const domains = metadata.domains.join(',') || DEFAULT_METADATA_LABEL;
    const model = this.compactModel(this.runtime?.model?.id ?? DEFAULT_MODEL_LABEL);
    const thinking = this.runtime?.thinkingLevel ?? DEFAULT_THINKING_LABEL;
    const activity = this.runtime?.isIdle() === false ? ACTIVE_STATUS : READY_STATUS;
    const rows = [
      alignLine(
        `${this.wordmark()}  ${this.theme.bold(this.theme.fg(TEXT_COLOR, repository))}`,
        this.theme.fg(SUCCESS_COLOR, activity),
        width,
      ),
      fitLine(`${profile}${DISPLAY_SEPARATOR}${domains}${DISPLAY_SEPARATOR}${metadata.majorMode}`, width),
      alignLine(
        this.theme.fg(WARNING_COLOR, `${model}${DISPLAY_SEPARATOR}${thinking}`),
        this.theme.fg(DIM_COLOR, 'CTRL+SPACE leader · SPC when empty'),
        width,
      ),
    ];

    return [...rows, this.hairline(width)];
  }

  private renderHints(width: number): string[] {
    const content = [
      this.keyHint('CTRL+SPACE', 'leader anywhere'),
      this.keyHint('SPC', 'when empty'),
      this.keyHint('/', 'commands'),
      this.keyHint('!', 'shell'),
    ].join('   ');
    return [fitLine(content, width)];
  }

  private renderEmptyState(width: number, height: number): string[] {
    const lines = Array.from({ length: Math.max(MIN_EMPTY_STATE_HEIGHT, height) }, () => '');
    const rule = this.theme.fg(MUTED_BORDER_COLOR, EMPTY_STATE_RULE);
    const label = `${rule} ${this.theme.fg(DIM_COLOR, EMPTY_STATE_LABEL)} ${rule}`;
    const guidance = this.theme.fg(MUTED_COLOR, EMPTY_STATE_GUIDANCE);
    const labelIndex = Math.max(0, Math.floor(lines.length / SECTION_SEPARATOR_ROWS) - 1);
    lines[labelIndex] = this.centerLine(label, width);
    if (lines.length > labelIndex + 1) lines[labelIndex + 1] = this.centerLine(guidance, width);

    return lines;
  }

  private hairline(width: number): string {
    return this.theme.fg(MUTED_BORDER_COLOR, HORIZONTAL_BORDER.repeat(Math.max(0, width)));
  }

  private centerLine(content: string, width: number): string {
    const fitted = fitLine(content, width);
    const leftPadding = ' '.repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / SECTION_SEPARATOR_ROWS)));
    return fitLine(`${leftPadding}${fitted}`, width);
  }

  private identityCell(content: string): string {
    const bar = this.theme.fg(ACCENT_COLOR, IDENTITY_ACCENT_BAR);
    return content ? `${bar} ${content}` : bar;
  }

  private columns(left: string, right: string, width: number): string {
    const rightWidth = Math.max(0, width - IDENTITY_COLUMN_WIDTH - COLUMN_GAP);
    return fitLine(
      `${padLine(left, IDENTITY_COLUMN_WIDTH)}${' '.repeat(COLUMN_GAP)}${fitLine(right, rightWidth)}`,
      width,
    );
  }

  private contextRow(label: string, value: string, color: ThemeColor): string {
    return `${this.theme.fg(DIM_COLOR, label.padEnd(CONTEXT_LABEL_WIDTH))}${this.theme.fg(color, value)}`;
  }

  private keyHint(key: string, label: string): string {
    const badge = this.theme.bg(SELECTED_BG_COLOR, this.theme.fg(ACCENT_COLOR, ` ${key} `));
    return `${badge} ${this.theme.fg(DIM_COLOR, label)}`;
  }

  private wordmark(): string {
    return `${this.theme.bold(this.theme.fg(ACCENT_COLOR, 'DOOM'))} ${this.theme.inverse(
      this.theme.bold(this.theme.fg(TEXT_COLOR, ' PI ')),
    )}`;
  }

  private compactModel(model: string): string {
    return model.split('/').at(-1)?.replace(CLAUDE_MODEL_PREFIX, '') ?? model;
  }

  private compactPath(value: string): string {
    const home = process.env[HOME_ENV];
    return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  }
}
