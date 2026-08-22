import type {
  AppliedHashlineEdits,
  FileHeader,
  HashlineRangeInput,
  LineAnchor,
  ParsedTaggedLine,
  PreparedHashlineEdit,
  TaggedLineMarker,
  TaggedLinePrefix,
} from '../types/hashline.ts';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const ANCHOR_SPACE = 26n * 26n * 26n;
const ASCII_A = 97;
const FILE_TAG_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const FILE_HEADER_PATTERN = /^@file (.+)#([A-Za-z0-9_-]{8})$/u;
const TAGGED_LINE_PATTERN = /^(>> | {3})?(\d+)#[a-z]{3}\|(.*)$/u;
const ANCHOR_PATTERN = /^\s*[>+-]*\s*(\d+)\s*[:#]\s*([a-zA-Z]{3})(?:\s*\|.*)?\s*$/u;
const ASCII_WHITESPACE = /[ \t\n\r\v\f]/gu;

/**
 * Return Phi's three-letter whitespace-insensitive FNV-1a64 line anchor.
 * Adapted from pulseaiclub/phi writetool under the MIT license.
 */
export function hashLine(line: string): string {
  const bytes = new TextEncoder().encode(line.replace(ASCII_WHITESPACE, ''));
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }

  let value = hash % ANCHOR_SPACE;
  const letters = Array.from({ length: 3 }, () => '');
  for (let index = letters.length - 1; index >= 0; index -= 1) {
    letters[index] = String.fromCharCode(ASCII_A + Number(value % 26n));
    value /= 26n;
  }
  return letters.join('');
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitLines(text: string): string[] {
  return normalizeToLf(stripBom(text)).split('\n');
}

export function normalizeFileTag(value: string): string {
  const trimmed = value.trim();
  const hashIndex = trimmed.lastIndexOf('#');
  const tag = hashIndex === -1 ? trimmed : trimmed.slice(hashIndex + 1);
  if (!FILE_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid file hash: ${value}. Expected the eight-character tag from @file path#HASH.`);
  }
  return tag;
}

export function formatFileHeader(path: string, tag: string): string {
  if (path.length === 0 || path.includes('\n') || path.includes('\r')) {
    throw new Error('Invalid file header path. Expected one non-empty path without line breaks.');
  }
  return `@file ${path}#${normalizeFileTag(tag)}`;
}

export function parseFileHeader(value: string): FileHeader | undefined {
  const match = FILE_HEADER_PATTERN.exec(value);
  const path = match?.[1];
  const tag = match?.[2];
  return path === undefined || tag === undefined ? undefined : { path, tag };
}

export function formatTaggedLine(
  line: string,
  lineNumber: number,
  prefix: TaggedLinePrefix = '',
  anchorSource = line,
): string {
  assertLineNumber(lineNumber);
  return `${prefix}${lineNumber}#${hashLine(anchorSource)}|${line}`;
}

export function formatTaggedLines(lines: readonly string[], firstLine = 1): string {
  return lines.map((line, index) => formatTaggedLine(line, firstLine + index)).join('\n');
}

export function parseTaggedLine(value: string): ParsedTaggedLine | undefined {
  const match = TAGGED_LINE_PATTERN.exec(value);
  const lineText = match?.[2];
  const content = match?.[3];
  if (lineText === undefined || content === undefined) return undefined;

  const line = Number.parseInt(lineText, 10);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;

  const marker = taggedLineMarker(match?.[1]);
  return marker === undefined ? { content, line } : { content, line, marker };
}

export function parseLineAnchor(value: string): LineAnchor {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`Invalid line anchor: ${value}. Expected one anchor such as 5#abc, not a pasted multiline block.`);
  }

  const match = ANCHOR_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `Invalid line anchor: ${value}. Expected one anchor such as 5#abc from the latest read or grep result.`,
    );
  }

  const line = Number.parseInt(match[1] ?? '', 10);
  const hash = match[2]?.toLowerCase();
  if (!Number.isSafeInteger(line) || line < 1 || hash === undefined) {
    throw new Error(`Invalid line anchor: ${value}. Expected a positive line number and three letters, such as 5#abc.`);
  }
  return { line, hash };
}

export function applyHashlineEdits(
  originalContent: string,
  requestedEdits: readonly HashlineRangeInput[],
): AppliedHashlineEdits {
  const lines = splitLines(originalContent);
  const validated = requestedEdits.map((edit) => validateEdit(edit, lines));
  const edits = deduplicateEdits(validated).sort(compareEdits);
  validateNoOverlaps(edits);

  const result = [...lines];
  for (const edit of [...edits].reverse()) {
    const deleteCount = edit.to.line - edit.from.line + 1;
    const replacements = edit.content === null || edit.content === '' ? [] : splitReplacement(edit.content);
    result.splice(edit.from.line - 1, deleteCount, ...replacements);
  }
  return { content: result.join('\n'), edits };
}

function taggedLineMarker(prefix: string | undefined): TaggedLineMarker | undefined {
  if (prefix === '>> ') return 'match';
  if (prefix === '   ') return 'context';
  return undefined;
}

function assertLineNumber(line: number): void {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`Invalid tagged line number: ${String(line)}. Expected a positive safe integer.`);
  }
}

function validateEdit(edit: HashlineRangeInput, lines: readonly string[]): PreparedHashlineEdit {
  const from = parseLineAnchor(edit.from);
  const to = parseLineAnchor(edit.to);
  if (from.line > to.line) {
    throw new Error(`Invalid edit range ${edit.from} to ${edit.to}: the starting line follows the ending line.`);
  }
  if (to.line > lines.length) {
    throw new Error(`Invalid edit range ${edit.from} to ${edit.to}: the file has ${lines.length} lines.`);
  }

  validateAnchor(from, lines);
  validateAnchor(to, lines);
  return { from, to, content: edit.content ?? null, source: edit };
}

function validateAnchor(anchor: LineAnchor, lines: readonly string[]): void {
  const line = lines[anchor.line - 1];
  if (line === undefined) throw new Error(`Line ${anchor.line} is outside the current file.`);
  const currentHash = hashLine(line);
  if (currentHash !== anchor.hash) {
    throw new Error(
      `Stale line anchor ${anchor.line}#${anchor.hash}. Current anchor is ${anchor.line}#${currentHash}. Re-read the file and retry.`,
    );
  }
}

function deduplicateEdits(edits: readonly PreparedHashlineEdit[]): PreparedHashlineEdit[] {
  const unique = new Map<string, PreparedHashlineEdit>();
  for (const edit of edits) {
    const key = JSON.stringify([edit.from.line, edit.from.hash, edit.to.line, edit.to.hash, edit.content]);
    if (!unique.has(key)) unique.set(key, edit);
  }
  return [...unique.values()];
}

function compareEdits(left: PreparedHashlineEdit, right: PreparedHashlineEdit): number {
  return left.from.line - right.from.line || left.to.line - right.to.line;
}

function validateNoOverlaps(edits: readonly PreparedHashlineEdit[]): void {
  for (let index = 1; index < edits.length; index += 1) {
    const previous = edits[index - 1];
    const current = edits[index];
    if (previous !== undefined && current !== undefined && current.from.line <= previous.to.line) {
      throw new Error(
        `Overlapping edit ranges ${previous.from.line}-${previous.to.line} and ${current.from.line}-${current.to.line}. Merge them and retry.`,
      );
    }
  }
}

function splitReplacement(content: string): string[] {
  const normalized = normalizeToLf(content);
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed === '' ? [] : trimmed.split('\n');
}
