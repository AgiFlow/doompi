import { collapseLines } from './collapse.ts';

/**
 * The hashline wire format, parsed the way the TUI's hashlineRendering does:
 * `@file path#tag` opens a file, `N#abc|content` is an anchored line, and a
 * `>> ` or three-space prefix marks grep matches and their context.
 *
 * It lives here rather than in each tool package because the read and grep
 * cards render the same bytes and had drifted into byte-identical copies of
 * this module. The patterns are still a transcription of doompi-hashline: a
 * cockpit plugin may import this library and the web contract, but not a
 * runtime package, so the format is stated twice on purpose and only once per
 * side of that line.
 */
const FILE_HEADER_PATTERN = /^@file (.+)#([A-Za-z0-9_-]{8})$/u;
const TAGGED_LINE_PATTERN = /^(>> | {3})?(\d+)#[a-z]{3}\|(.*)$/u;
const MATCH_PREFIX = '>> ';
const CONTEXT_PREFIX = '   ';
const IMAGE_PLACEHOLDER = '[Image attached]';

export const READ_COLLAPSED_LINES = 10;
export const GREP_COLLAPSED_LINES = 15;

export type HashlineResultKind = 'read' | 'grep';
export type TaggedLineMarker = 'match' | 'context';

/**
 * The part of a tool result this parser reads.
 *
 * Named structurally rather than imported: the component library sits below
 * the web contract and must not depend on it, so it states the shape it needs
 * and any `ToolResultView` satisfies it.
 */
export interface HashlineResult {
  readonly content: readonly unknown[];
}

export interface TaggedLine {
  readonly line: number;
  readonly content: string;
  readonly marker: TaggedLineMarker | undefined;
}

export type PresentedLine =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'tagged'; readonly value: TaggedLine }
  | { readonly type: 'plain'; readonly text: string };

export interface HashlineBody {
  readonly shown: readonly PresentedLine[];
  /** Lines the collapsed view holds back; zero once expanded. */
  readonly hidden: number;
  /** The bracketed pagination or compaction note the tool appends after its lines. */
  readonly notice: string | undefined;
  /** Widest line number among the shown anchored lines, in characters. */
  readonly gutter: number;
}

interface TextBlock {
  readonly type: string;
  readonly text?: string;
}

function isTextBlock(block: unknown): block is TextBlock {
  return typeof block === 'object' && block !== null && typeof (block as TextBlock).type === 'string';
}

/**
 * The result's text as lines: tabs widened, CRLF folded, trailing blanks
 * dropped. A result with no text but an image block reads as the TUI's
 * placeholder. The joined `output` stands in when no result view exists.
 */
export function resultTextLines(result: HashlineResult | null, output: string): string[] {
  const blocks = result?.content.filter(isTextBlock) ?? [];
  const text =
    result === null ? output : blocks.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
  if (text.length === 0) {
    return blocks.some((block) => block.type === 'image') ? [IMAGE_PLACEHOLDER] : [];
  }
  const lines = text.replaceAll('\t', '  ').replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Detaches the tool's trailing `[...]` note so the body numbers file content only. */
export function takeTrailingNotice(lines: string[]): string | undefined {
  const last = lines.at(-1);
  if (last === undefined || !last.startsWith('[') || !last.endsWith(']')) return undefined;
  lines.pop();
  while (lines.at(-1) === '') lines.pop();
  return last;
}

export function parseTaggedLine(value: string): TaggedLine | undefined {
  const match = TAGGED_LINE_PATTERN.exec(value);
  const lineText = match?.[2];
  const content = match?.[3];
  if (lineText === undefined || content === undefined) return undefined;
  const line = Number.parseInt(lineText, 10);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  const prefix = match?.[1];
  const marker = prefix === MATCH_PREFIX ? 'match' : prefix === CONTEXT_PREFIX ? 'context' : undefined;
  return { line, content, marker };
}

export function parseFileHeader(value: string): string | undefined {
  return FILE_HEADER_PATTERN.exec(value)?.[1];
}

/**
 * Lines as the card presents them. A read shows one file, so its header is
 * dropped; a grep groups anchored matches under each file's path.
 */
export function presentHashlineLines(lines: readonly string[], kind: HashlineResultKind): PresentedLine[] {
  const presented: PresentedLine[] = [];
  for (const line of lines) {
    const path = parseFileHeader(line);
    if (path !== undefined) {
      if (kind !== 'read') presented.push({ type: 'file', path });
      continue;
    }
    const tagged = parseTaggedLine(line);
    if (tagged !== undefined) {
      presented.push({ type: 'tagged', value: tagged });
      continue;
    }
    presented.push({ type: 'plain', text: line });
  }
  return presented;
}

/** The body a card shows for one result, collapsed to the kind's line budget unless expanded. */
export function hashlineBody(
  result: HashlineResult | null,
  output: string,
  kind: HashlineResultKind,
  expanded: boolean,
): HashlineBody {
  const lines = resultTextLines(result, output);
  const notice = takeTrailingNotice(lines);
  const presented = presentHashlineLines(lines, kind);
  const budget = kind === 'read' ? READ_COLLAPSED_LINES : GREP_COLLAPSED_LINES;
  const { shown, hidden } = collapseLines(presented, budget, expanded);
  const gutter = shown.reduce(
    (widest, line) => (line.type === 'tagged' ? Math.max(widest, String(line.value.line).length) : widest),
    1,
  );
  return { shown, hidden, notice, gutter };
}

/** The `key · key` detail list beside a call's primary argument, with absent values dropped. */
export function compactDetails(values: ReadonlyArray<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined && value.length > 0);
}
