import { parseFileHeader, parseTaggedLine } from '@agimon-ai/doompi-hashline';
import {
  getLanguageFromPath,
  highlightCode,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { type Component, Text } from '@earendil-works/pi-tui';
import { renderLineNumber } from './codeGutter.ts';
import { renderDoomDiff } from './diffRender.ts';
import { DoomToolCall, DoomToolResult, frameDoomToolResult, renderToolHeading } from './toolChrome.ts';

export const READ_COLLAPSED_LINES = 10;
export const GREP_COLLAPSED_LINES = 15;

type HashlineResultKind = 'read' | 'grep' | 'plain';
type Highlighter = (code: string, language?: string) => string[];
type LanguageResolver = (path: string) => string | undefined;

interface TaggedLine {
  readonly content: string;
  readonly hasMarker: boolean;
  readonly line: number;
  readonly match: boolean;
}

type PresentedLine =
  | { readonly path: string; readonly type: 'file' }
  | { readonly type: 'tagged'; readonly value: TaggedLine }
  | { readonly styled: boolean; readonly text: string; readonly type: 'plain' };

interface HashlineResultContext {
  readonly args?: { readonly path?: unknown };
  readonly isError: boolean;
  readonly lastComponent?: Component;
}

export function renderHashlineCall(name: string, primary: string, details: readonly string[], theme: Theme): Component {
  let text = renderToolHeading(name, primary, theme);
  if (details.length > 0) text += ` ${theme.fg('muted', `· ${details.join(' · ')}`)}`;
  return new DoomToolCall(text);
}

export function renderHashlineResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: HashlineResultContext,
  kind: HashlineResultKind,
  highlight: Highlighter = highlightCode,
  resolveLanguage: LanguageResolver = getLanguageFromPath,
): Component {
  const lines = textLines(result);
  if (context.isError) {
    return new DoomToolResult(
      lines.map((line) => theme.fg('error', line)),
      theme,
      { wrap: true },
    );
  }

  const notice = takeTrailingNotice(lines);
  const readPath = kind === 'read' && typeof context.args?.path === 'string' ? context.args.path : undefined;
  const presented = presentLines(lines, kind, theme, highlight, resolveLanguage, readPath);
  const collapsedLines = kind === 'read' ? READ_COLLAPSED_LINES : GREP_COLLAPSED_LINES;
  const shown = options.expanded ? presented : presented.slice(0, collapsedLines);
  const tagged = shown.flatMap((line) => (line.type === 'tagged' ? [line.value] : []));
  const gutter = tagged.reduce((widest, line) => Math.max(widest, String(line.line).length), 1);
  const body = shown.map((line) => renderPresentedLine(line, gutter, theme));
  const hidden = presented.length - shown.length;
  if (hidden > 0) body.push(theme.fg('dim', `… ${hidden} more lines · ctrl+o expand`));
  if (notice !== undefined) body.push(theme.fg('muted', notice));
  return new DoomToolResult(body, theme, { wrap: options.expanded });
}

export function renderHashlineEditResult(
  path: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: HashlineResultContext,
): Component {
  if (context.isError) return renderHashlineResult(result, options, theme, context, 'plain');

  const details = result.details as { diff?: string } | undefined;
  if (!details?.diff) return new Text('', 0, 0);
  const diff = renderDoomDiff(details.diff, theme, getLanguageFromPath(path));
  return frameDoomToolResult(diff, theme, context.lastComponent);
}

function presentLines(
  lines: readonly string[],
  kind: HashlineResultKind,
  theme: Theme,
  highlight: Highlighter,
  resolveLanguage: LanguageResolver,
  readPath: string | undefined,
): PresentedLine[] {
  if (readPath !== undefined && !lines.some((line) => parseFileHeader(line) !== undefined)) {
    const language = resolveLanguage(readPath);
    if (language !== undefined) {
      const highlighted = highlight(lines.join('\n'), language);
      if (highlighted.length === lines.length) {
        return highlighted.map((text) => ({ styled: true, text, type: 'plain' }));
      }
    }
  }

  const presented: PresentedLine[] = [];
  let path: string | undefined;
  let pending: TaggedLine[] = [];
  const flushTagged = (): void => {
    if (pending.length === 0) return;
    const language = path === undefined ? undefined : resolveLanguage(path);
    const fallback = pending.map((line) => theme.fg('toolOutput', line.content));
    const highlighted =
      language === undefined ? fallback : highlight(pending.map((line) => line.content).join('\n'), language);
    const contents = highlighted.length === pending.length ? highlighted : fallback;
    presented.push(
      ...pending.map((line, index): PresentedLine => ({
        type: 'tagged',
        value: { ...line, content: contents[index] ?? fallback[index] ?? '' },
      })),
    );
    pending = [];
  };

  for (const line of lines) {
    const header = parseFileHeader(line);
    if (header !== undefined) {
      flushTagged();
      path = header.path;
      if (kind !== 'read') presented.push({ type: 'file', path });
      continue;
    }

    const tagged = parseTaggedLine(line);
    if (tagged !== undefined) {
      pending.push({
        content: tagged.content,
        hasMarker: tagged.marker !== undefined,
        line: tagged.line,
        match: tagged.marker === 'match',
      });
      continue;
    }

    flushTagged();
    presented.push({ styled: false, text: line, type: 'plain' });
  }
  flushTagged();
  return presented;
}

function renderPresentedLine(line: PresentedLine, gutter: number, theme: Theme): string {
  if (line.type === 'file') return theme.fg('muted', line.path);
  if (line.type === 'plain') return line.styled ? line.text : theme.fg('toolOutput', line.text);

  const marker = line.value.hasMarker ? `${line.value.match ? theme.fg('accent', '>>') : '  '} ` : '';
  const number = renderLineNumber(line.value.line, gutter, theme);
  return `${marker}${number} ${line.value.content}`;
}

function textLines(result: AgentToolResult<unknown>): string[] {
  const text = result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');
  if (text.length === 0) return ['[Image attached]'];
  const lines = text.replaceAll('\t', '  ').replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

function takeTrailingNotice(lines: string[]): string | undefined {
  const last = lines.at(-1);
  if (last === undefined || !last.startsWith('[') || !last.endsWith(']')) return undefined;
  lines.pop();
  while (lines.at(-1) === '') lines.pop();
  return last;
}
