import {
  type EditToolDetails,
  type EditToolInput,
  type FindToolInput,
  type GrepToolInput,
  getLanguageFromPath,
  highlightCode,
  type LsToolInput,
  type ReadToolInput,
  type Theme,
  type WriteToolInput,
} from '@earendil-works/pi-coding-agent';
import { type Component, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { gutterWidth, renderLineNumber } from './codeGutter.ts';
import { renderDoomDiff } from './diffRender.ts';
import { DoomToolCall, frameDoomToolResult, previousDoomToolResult, renderToolHeading } from './toolChrome.ts';

const COLLAPSED_FILE_LINES = 10;

type Highlighter = (code: string, language?: string) => string[];
type LanguageResolver = (path: string) => string | undefined;

export interface ToolPreviewOptions {
  expanded?: boolean;
  isError?: boolean;
}

export interface WritePreviewOptions extends ToolPreviewOptions {
  argsStreaming?: boolean;
}

export interface TextToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

export interface EditToolResult extends TextToolResult {
  details?: EditToolDetails;
}

/** Self-owned result shell shared by Pi's native file and search tools. */
class BuiltinToolContent implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    if (width <= 0 || this.text.length === 0) return [];
    return wrapTextWithAnsi(this.text, width);
  }

  invalidate(): void {
    // Content is immutable and reflows from the current width on every render.
  }
}

/** Recover the native renderer's component from the shell returned on its previous pass. */
export function previousBuiltinResult(component: Component | undefined): Component | undefined {
  return previousDoomToolResult(component);
}

/** Reuse the shell while allowing Pi's native renderer to reuse its own inner component. */
export function frameBuiltinResult(content: Component, theme: Theme, previous: Component | undefined): Component {
  return frameDoomToolResult(content, theme, previous);
}

function renderCall(label: string, primary: string, details: readonly string[], theme: Theme): Component {
  let text = renderToolHeading(label, primary, theme);
  if (details.length > 0) text += ` ${theme.fg('muted', `· ${details.join(' · ')}`)}`;
  return new DoomToolCall(text);
}

function optionalCount(value: number | undefined, unit: string): string | undefined {
  return value === undefined ? undefined : `${value} ${unit}`;
}

function compactDetails(values: ReadonlyArray<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined && value.length > 0);
}

export function renderReadCall(args: ReadToolInput, theme: Theme): Component {
  return renderCall(
    'read',
    args.path,
    compactDetails([args.offset === undefined ? undefined : `from ${args.offset}`, optionalCount(args.limit, 'lines')]),
    theme,
  );
}

export function renderEditCall(args: EditToolInput, theme: Theme): Component {
  const count = args.edits.length;
  return renderCall('edit', args.path, [`${count} edit${count === 1 ? '' : 's'}`], theme);
}

/**
 * Read appends a bracketed pagination note after a blank line. Detach it so the
 * gutter numbers file content only, and mutate the caller's line list to match.
 */
function takeTrailingNote(lines: string[]): string | undefined {
  const last = lines.at(-1);
  if (last === undefined || !last.startsWith('[') || !last.endsWith(']')) return undefined;

  lines.pop();
  while (lines.at(-1) === '') lines.pop();
  return last;
}

function textContent(result: TextToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .replaceAll('\t', '  ')
    .replaceAll('\r\n', '\n');
}

export function renderEditResult(
  args: EditToolInput,
  result: EditToolResult,
  options: ToolPreviewOptions,
  theme: Theme,
  highlight: Highlighter = highlightCode,
  resolveLanguage: LanguageResolver = getLanguageFromPath,
): Component {
  if (options.isError) return new BuiltinToolContent(theme.fg('error', textContent(result)));

  const diff = result.details?.diff;
  // A successful edit whose details never arrived has nothing worth a frame.
  if (diff === undefined || diff.length === 0) return new BuiltinToolContent('');
  return renderDoomDiff(diff, theme, resolveLanguage(args.path), highlight);
}

export function renderWriteCall(
  args: WriteToolInput,
  theme: Theme,
  options: WritePreviewOptions = {},
  highlight: Highlighter = highlightCode,
  resolveLanguage: LanguageResolver = getLanguageFromPath,
): Component {
  const heading = renderToolHeading('write', args.path, theme);
  const details = theme.fg('muted', `· ${args.content.length.toLocaleString('en-US')} chars`);
  if (args.content.length === 0) return new DoomToolCall(`${heading} ${details}`);

  const normalizedLines = args.content.replaceAll('\t', '  ').replaceAll('\r\n', '\n').split('\n');
  while (normalizedLines.at(-1) === '') normalizedLines.pop();
  const showLiveTail = options.argsStreaming === true && options.expanded !== true;
  const visibleLines = options.expanded
    ? normalizedLines
    : showLiveTail
      ? normalizedLines.slice(-COLLAPSED_FILE_LINES)
      : normalizedLines.slice(0, COLLAPSED_FILE_LINES);
  const language = resolveLanguage(args.path);
  const highlighted = language
    ? highlight(visibleLines.join('\n'), language)
    : visibleLines.map((line) => theme.fg('toolOutput', line));
  const hiddenLineCount = normalizedLines.length - visibleLines.length;
  // A live tail shows the file's end, so numbering starts where the tail does.
  const firstVisibleLineNumber = showLiveTail ? hiddenLineCount + 1 : 1;
  const numberWidth = gutterWidth(firstVisibleLineNumber + visibleLines.length - 1);
  const preview = highlighted.map(
    (line, index) => `${renderLineNumber(firstVisibleLineNumber + index, numberWidth, theme)} ${line}`,
  );
  const previewLines = showLiveTail
    ? [
        ...(hiddenLineCount > 0 ? [theme.fg('muted', `… ${hiddenLineCount} earlier lines · live tail`)] : []),
        ...preview,
      ]
    : [
        ...preview,
        ...(hiddenLineCount > 0 ? [theme.fg('muted', `… ${hiddenLineCount} more lines · ctrl+o expand`)] : []),
      ];
  return new DoomToolCall([`${heading} ${details}`, '', ...previewLines].join('\n'));
}

export function renderReadResult(
  args: ReadToolInput,
  result: TextToolResult,
  options: ToolPreviewOptions,
  theme: Theme,
  highlight: Highlighter = highlightCode,
  resolveLanguage: LanguageResolver = getLanguageFromPath,
): Component {
  const normalizedLines = textContent(result).split('\n');
  while (normalizedLines.at(-1) === '') normalizedLines.pop();
  if (options.isError) {
    return new BuiltinToolContent(normalizedLines.map((line) => theme.fg('error', line)).join('\n'));
  }

  const note = takeTrailingNote(normalizedLines);
  const visibleLines = options.expanded ? normalizedLines : normalizedLines.slice(0, COLLAPSED_FILE_LINES);
  const language = resolveLanguage(args.path);
  const highlighted = language
    ? highlight(visibleLines.join('\n'), language)
    : visibleLines.map((line) => theme.fg('toolOutput', line));
  // Read starts at `offset`, so the gutter has to agree with the file, not the excerpt.
  const firstLineNumber = args.offset ?? 1;
  const numberWidth = gutterWidth(firstLineNumber + visibleLines.length - 1);
  const preview = highlighted.map(
    (line, index) => `${renderLineNumber(firstLineNumber + index, numberWidth, theme)} ${line}`,
  );
  const remaining = normalizedLines.length - visibleLines.length;
  if (remaining > 0) preview.push(theme.fg('muted', `… ${remaining} more lines · ctrl+o expand`));
  if (note !== undefined) preview.push(theme.fg('muted', note));
  return new BuiltinToolContent(preview.join('\n'));
}

export function renderGrepCall(args: GrepToolInput, theme: Theme): Component {
  return renderCall(
    'grep',
    args.pattern,
    compactDetails([
      args.path ?? '.',
      args.glob,
      args.ignoreCase === true ? 'ignore case' : undefined,
      optionalCount(args.limit, 'matches'),
    ]),
    theme,
  );
}

export function renderFindCall(args: FindToolInput, theme: Theme): Component {
  return renderCall(
    'find',
    args.pattern,
    compactDetails([args.path ?? '.', optionalCount(args.limit, 'results')]),
    theme,
  );
}

export function renderLsCall(args: LsToolInput, theme: Theme): Component {
  return renderCall('ls', args.path ?? '.', compactDetails([optionalCount(args.limit, 'entries')]), theme);
}
