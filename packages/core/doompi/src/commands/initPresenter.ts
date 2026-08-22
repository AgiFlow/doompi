import { GLOBAL_DOOM_SEED_FILES, type GlobalDoomInitResult } from '@agimon-ai/doompi-config';
import { AMBIENT_EXTENSION_FILTER, DOOM_EXTENSION } from '../adapters/piSettings.ts';
import { DEFAULT_THEME, DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';

const FORCE_COLOR_ENV = 'FORCE_COLOR';
const NO_COLOR_ENV = 'NO_COLOR';
const DUMB_TERMINAL = 'dumb';
const ANSI_PREFIX = '\u001B[';
const ANSI_RESET = `${ANSI_PREFIX}0m`;
const SECTION_RULE = '─'.repeat(72);
const READY_RULE = '━━━━━━━━';
const SETTINGS_KEYS = ['extensions', 'themes', 'theme', 'quietStartup'] as const;

export interface InitOutput {
  write: NodeJS.WritableStream['write'];
  isTTY?: boolean;
}

export interface PiIntegrationSummary {
  settingsPath: string;
  themePath: string;
  aliasPath: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

type SeedFile = (typeof GLOBAL_DOOM_SEED_FILES)[number];
type SeedFileStatus = 'CREATED' | 'KEPT' | 'REPLACED';
type Paint = (text: string) => string;

interface InitPalette {
  accent: Paint;
  badge: Paint;
  error: Paint;
  heading: Paint;
  key: Paint;
  kept: Paint;
  muted: Paint;
  path: Paint;
  strong: Paint;
  success: Paint;
  warning: Paint;
}

interface PaintOptions {
  background?: string;
  bold?: boolean;
}

const SEED_FILE_GUIDANCE: Readonly<Record<SeedFile, string>> = {
  'config.yaml': 'project trust and optional voice defaults',
  'modes.yaml': 'layers, packages, and the default major mode',
  'domains.yaml': 'plugin catalog, domain groups, and aliases',
  'profiles.yaml': 'profile roots, personas, and string environment defaults',
};

function colorEnabled(output: InitOutput, environment: NodeJS.ProcessEnv): boolean {
  const forced = environment[FORCE_COLOR_ENV];
  if (forced === '0') return false;
  if (forced !== undefined) return true;
  if (environment[NO_COLOR_ENV] !== undefined) return false;
  return output.isTTY === true && environment.TERM !== DUMB_TERMINAL;
}

function rgbCode(prefix: 38 | 48, hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `${String(prefix)};2;${String(red)};${String(green)};${String(blue)}`;
}

function painter(enabled: boolean, foreground: string, options: PaintOptions = {}): Paint {
  if (!enabled) return (text) => text;
  const codes = [rgbCode(38, foreground)];
  if (options.background) codes.push(rgbCode(48, options.background));
  if (options.bold) codes.unshift('1');
  const opening = `${ANSI_PREFIX}${codes.join(';')}m`;
  return (text) => `${opening}${text}${ANSI_RESET}`;
}

function createPalette(enabled: boolean): InitPalette {
  const { vars } = DEFAULT_THEME;
  const accent = painter(enabled, vars.blue);
  const badgePaint = painter(enabled, vars.bg, { background: vars.blue, bold: true });
  return {
    accent,
    badge: enabled ? (text) => badgePaint(` ${text} `) : (text) => text,
    error: painter(enabled, vars.red, { bold: true }),
    heading: painter(enabled, vars.magenta, { bold: true }),
    key: painter(enabled, vars.cyan),
    kept: painter(enabled, vars.violet),
    muted: painter(enabled, vars.comment),
    path: painter(enabled, vars.cyan),
    strong: painter(enabled, vars.fg, { bold: true }),
    success: painter(enabled, vars.green, { bold: true }),
    warning: painter(enabled, vars.yellow),
  };
}

function seedFileStatus(result: GlobalDoomInitResult, fileName: SeedFile): SeedFileStatus {
  if (result.created.includes(fileName)) return 'CREATED';
  if (result.replaced.includes(fileName)) return 'REPLACED';
  if (result.preserved.includes(fileName)) return 'KEPT';
  throw new Error(`doompi init did not classify generated file: ${fileName}`);
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((entry): entry is string => typeof entry === 'string');
}

/** Streams the init command using the same Doom One semantic palette as the Pi TUI. */
export class InitPresenter {
  private readonly output: InitOutput;
  private readonly palette: InitPalette;

  constructor(output: InitOutput, environment: NodeJS.ProcessEnv) {
    this.output = output;
    this.palette = createPalette(colorEnabled(output, environment));
  }

  brand(): void {
    const color = this.palette;
    this.write([
      color.muted('BOOT / INIT'),
      `${color.accent('DOOM')} ${color.badge('PI')}  ${color.heading('INITIALIZE')}`,
      color.muted('Pi, configured for focus.'),
      `${color.accent(READY_RULE)} ${color.heading('SETUP')}`,
      '',
    ]);
  }

  stage(step: number, total: number, label: string, target: string): void {
    const color = this.palette;
    this.write([
      `${color.accent(`[${String(step)}/${String(total)}]`)} ${color.strong(label)}`,
      `      ${color.muted('TARGET')}  ${color.path(target)}`,
    ]);
  }

  stageReady(message: string): void {
    this.write([`      ${this.palette.success('● READY')}  ${message}`]);
  }

  stageFailed(message: string, detail: readonly string[]): void {
    this.write([
      `      ${this.palette.error('● FAILED')} ${message}`,
      ...detail.map((line) => `        ${this.palette.warning(line)}`),
    ]);
  }

  complete(config: GlobalDoomInitResult, pi: PiIntegrationSummary): void {
    this.write(['', ...this.formatPiIntegration(pi)]);
    this.write(['', ...this.formatConfigResult(config)]);
    this.write([
      '',
      this.sectionHeading('NEXT'),
      `  ${this.palette.accent('01')}  Open ${this.palette.path(config.directory)}.`,
      `  ${this.palette.accent('02')}  Edit the YAML files to match how you want Pi to work.`,
      `  ${this.palette.accent('03')}  From the repository you want to configure, run:`,
      '',
      `      ${this.palette.badge('doompi sync')}`,
      '',
      `${this.palette.success(READY_RULE)} ${this.palette.success('READY')}  Edit your config, then sync it.`,
    ]);
  }

  private formatPiIntegration(result: PiIntegrationSummary): string[] {
    const changedKeys = SETTINGS_KEYS.filter((key) => this.settingsValueChanged(result, key));
    const selectedTheme = typeof result.after.theme === 'string' ? result.after.theme : DEFAULT_THEME_NAME;
    const themeDescription =
      selectedTheme === DEFAULT_THEME_NAME
        ? `selected ${this.palette.path(`"${DEFAULT_THEME_NAME}"`)} when no prior theme was set`
        : `kept your existing selection ${this.palette.path(`"${selectedTheme}"`)}`;
    const registeredTheme = firstString(result.after.themes) ?? result.themePath;
    const summary =
      changedKeys.length === 0
        ? this.palette.success('No settings edits were needed; DoomPi entries were already current.')
        : `${this.palette.warning(
            `Updated ${String(changedKeys.length)} managed key${changedKeys.length === 1 ? '' : 's'}.`,
          )} ${this.palette.muted('Unrelated settings were preserved.')}`;

    return [
      this.sectionHeading('PI GLOBAL SETTINGS'),
      `  ${this.palette.path(result.settingsPath)}`,
      `  ${this.palette.muted('Pi defaults to ~/.pi/agent/settings.json and honors PI_CODING_AGENT_DIR.')}`,
      `  ${summary}`,
      this.settingLine(
        result,
        'extensions',
        `load ${this.palette.path(`"${DOOM_EXTENSION}"`)} first; ${this.palette.path(
          `"${AMBIENT_EXTENSION_FILTER}"`,
        )} keeps layer loading explicit`,
      ),
      this.settingLine(result, 'themes', `registered ${this.palette.path(`"${registeredTheme}"`)}`),
      this.settingLine(result, 'theme', themeDescription),
      this.settingLine(result, 'quietStartup', 'true for a concise Pi startup'),
      `  ${this.palette.muted('RESOURCES')}`,
      `    ${this.palette.muted('ALIAS'.padEnd(7))}${this.palette.path(result.aliasPath)}`,
      `    ${this.palette.muted('THEME'.padEnd(7))}${this.palette.path(result.themePath)}`,
    ];
  }

  private formatConfigResult(result: GlobalDoomInitResult): string[] {
    const lines = [
      this.sectionHeading('DOOMPI CONFIGURATION'),
      `  ${this.palette.path(result.directory)}`,
      ...GLOBAL_DOOM_SEED_FILES.map((fileName) => {
        const status = seedFileStatus(result, fileName);
        return `  ${this.fileStatus(status)} ${this.palette.key(fileName.padEnd(13))} ${this.palette.muted('—')} ${SEED_FILE_GUIDANCE[fileName]}`;
      }),
    ];
    if (result.preserved.length > 0) {
      lines.push(`  ${this.palette.kept('KEPT')} ${this.palette.muted('files retain your existing edits.')}`);
    }
    if (result.replaced.length > 0) {
      lines.push(
        `  ${this.palette.warning('REPLACED')} ${this.palette.muted(
          'files were restored from the templates because --force was used.',
        )}`,
      );
    }
    return lines;
  }

  private settingLine(result: PiIntegrationSummary, key: (typeof SETTINGS_KEYS)[number], description: string): string {
    const changed = this.settingsValueChanged(result, key);
    const status = changed ? this.palette.warning('UPDATED'.padEnd(8)) : this.palette.success('READY'.padEnd(8));
    return `  ${status} ${this.palette.key(`${key}:`.padEnd(14))}${description}`;
  }

  private settingsValueChanged(result: PiIntegrationSummary, key: (typeof SETTINGS_KEYS)[number]): boolean {
    return JSON.stringify(result.before[key]) !== JSON.stringify(result.after[key]);
  }

  private fileStatus(status: SeedFileStatus): string {
    const padded = status.padEnd(8);
    if (status === 'CREATED') return this.palette.accent(padded);
    if (status === 'REPLACED') return this.palette.warning(padded);
    return this.palette.kept(padded);
  }

  private sectionHeading(title: string): string {
    return `${this.palette.muted(SECTION_RULE)}\n${this.palette.heading(title)}`;
  }

  private write(lines: readonly string[]): void {
    this.output.write(`${lines.join('\n')}\n`);
  }
}
