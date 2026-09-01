import type { ToolResultView } from '@agimon-ai/doompi-web-contracts';

/** The TUI's collapsed budgets: ten preview lines for a write, twenty for a listing. */
export const WRITE_COLLAPSED_LINES = 10;
export const LIST_COLLAPSED_LINES = 20;
/** Pi's default output cap, the size its truncation warning names when details omit one. */
const DEFAULT_MAX_BYTES = 50 * 1024;
const KIBIBYTE = 1024;

export interface NumberedLine {
  readonly number: number;
  readonly text: string;
}

export interface WriteCallView {
  readonly path: string;
  /** `N chars`, the size the TUI's call heading shows. */
  readonly size: string;
  readonly preview: readonly NumberedLine[];
  readonly hidden: number;
  /** Widest shown line number, in characters. */
  readonly gutter: number;
}

export interface SearchCallView {
  readonly primary: string;
  readonly details: readonly string[];
}

export interface ListResultView {
  readonly lines: readonly string[];
  readonly hidden: number;
  /** Pi's `[Truncated: ...]` warning, when the listing hit a limit. */
  readonly truncated: string | undefined;
}

function compactDetails(values: ReadonlyArray<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined && value.length > 0);
}

function optionalCount(value: unknown, unit: string): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ${unit}` : undefined;
}

function pathOrDot(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '.';
}

/** Pi's size formatter, so the web warning names the same figure the TUI does. */
export function formatSize(bytes: number): string {
  if (bytes < KIBIBYTE) return `${bytes}B`;
  if (bytes < KIBIBYTE * KIBIBYTE) return `${(bytes / KIBIBYTE).toFixed(1)}KB`;
  return `${(bytes / (KIBIBYTE * KIBIBYTE)).toFixed(1)}MB`;
}

/** What the write call shows: the path, the content size, and a numbered preview of the file. */
export function writeCallView(args: Readonly<Record<string, unknown>>, expanded: boolean): WriteCallView {
  const content = typeof args.content === 'string' ? args.content : '';
  const path = typeof args.path === 'string' ? args.path : '';
  const size = `${content.length.toLocaleString('en-US')} chars`;
  if (content.length === 0) return { path, size, preview: [], hidden: 0, gutter: 1 };
  const lines = content.replaceAll('\t', '  ').replaceAll('\r\n', '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  const visible = expanded ? lines : lines.slice(0, WRITE_COLLAPSED_LINES);
  const preview = visible.map((text, index) => ({ number: index + 1, text }));
  return { path, size, preview, hidden: lines.length - visible.length, gutter: String(visible.length).length };
}

/** `pattern · path · N results`, as the find call heading lists them. */
export function findCallView(args: Readonly<Record<string, unknown>>): SearchCallView {
  return {
    primary: typeof args.pattern === 'string' ? args.pattern : '',
    details: compactDetails([pathOrDot(args.path), optionalCount(args.limit, 'results')]),
  };
}

/** `path · N entries`, as the ls call heading lists them. */
export function lsCallView(args: Readonly<Record<string, unknown>>): SearchCallView {
  return { primary: pathOrDot(args.path), details: compactDetails([optionalCount(args.limit, 'entries')]) };
}

/** The result's text, from its blocks when the view exists and from the joined output otherwise. */
export function resultText(result: ToolResultView | null, output: string): string {
  if (result === null) return output;
  return result.content
    .flatMap((block) => {
      const record = typeof block === 'object' && block !== null ? (block as { type?: unknown; text?: unknown }) : {};
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

/**
 * A find or ls listing the way Pi's own renderer shows it: the lines,
 * collapsed to twenty, and the limit warning its details carry. `limitKey`
 * names the per-tool counter (resultLimitReached, entryLimitReached).
 */
export function listResultView(
  result: ToolResultView | null,
  output: string,
  expanded: boolean,
  limitKey: string,
  limitUnit: string,
): ListResultView {
  const text = resultText(result, output).trim();
  const all = text.length === 0 ? [] : text.split('\n');
  const lines = expanded ? all : all.slice(0, LIST_COLLAPSED_LINES);
  const details =
    typeof result?.details === 'object' && result.details !== null ? (result.details as Record<string, unknown>) : {};
  const limit = details[limitKey];
  const truncation =
    typeof details.truncation === 'object' && details.truncation !== null
      ? (details.truncation as Record<string, unknown>)
      : undefined;
  const warnings: string[] = [];
  if (typeof limit === 'number' && limit > 0) warnings.push(`${limit} ${limitUnit} limit`);
  if (truncation?.truncated === true) {
    warnings.push(
      `${formatSize(typeof truncation.maxBytes === 'number' ? truncation.maxBytes : DEFAULT_MAX_BYTES)} limit`,
    );
  }
  return {
    lines,
    hidden: all.length - lines.length,
    truncated: warnings.length > 0 ? `[Truncated: ${warnings.join(', ')}]` : undefined,
  };
}
