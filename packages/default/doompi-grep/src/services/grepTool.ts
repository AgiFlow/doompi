import { basename, resolve } from 'node:path';
import { computeFileTag, decodeUtf8, displayPath, resolveInputPath } from '@agimon-ai/doompi-hashline/files';
import { formatFileHeader, formatTaggedLine, splitLines } from '@agimon-ai/doompi-hashline';
import type { GrepParams } from '../schemas/grepTool.ts';

const MATCH_DELIMITER = /:(\d+): /gu;
const CONTEXT_DELIMITER = /-(\d+)- /gu;
const NO_MATCHES = 'No matches found';

export interface GrepRow {
  readonly path: string;
  readonly line: number;
  readonly match: boolean;
  readonly native?: string;
}

export interface GrepGroup {
  readonly path: string;
  readonly absolutePath: string;
  readonly nativeRows: string[];
  readonly rows: Map<number, boolean>;
}

export interface GrepResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: {
    readonly linesTruncated?: boolean;
    readonly truncation?: GrepTruncation;
    readonly [key: string]: unknown;
  };
}

export interface GrepFileStats {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface GrepFileSystem {
  stat(path: string): Promise<GrepFileStats>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface GrepTruncation {
  readonly content: string;
  readonly truncated: boolean;
  readonly truncatedBy: 'lines' | 'bytes' | null;
  readonly outputLines: number;
}

export interface GrepOutputOperations {
  readonly maxBytes: number;
  formatSize(bytes: number): string;
  truncateHead(content: string, options: { readonly maxLines?: number }): GrepTruncation;
  truncateLine(line: string): { readonly text: string; readonly wasTruncated: boolean };
}
export function parseGrepRow(value: string): GrepRow[] {
  return grepRowCandidates(value)
    .slice(0, 1)
    .map(({ line, match, path }) => ({ line, match, path }));
}

export async function tagGrepResult(
  nativeResult: GrepResult,
  params: GrepParams,
  cwd: string,
  signal: AbortSignal | undefined,
  writable: (path: string) => Promise<boolean>,
  filesystem: GrepFileSystem,
  outputOperations: GrepOutputOperations,
): Promise<GrepResult> {
  const textPart = nativeResult.content.find((part) => part.type === 'text');
  if (!textPart || textPart.text === NO_MATCHES) return nativeResult;

  const noticeIndex = textPart.text.lastIndexOf('\n\n[');
  const rowsText = noticeIndex === -1 ? textPart.text : textPart.text.slice(0, noticeIndex);
  const notice = noticeIndex === -1 ? '' : textPart.text.slice(noticeIndex);
  const searchPath = resolveInputPath(params.path ?? '.', cwd);
  const searchStats = await filesystem.stat(searchPath);
  assertNotAborted(signal);
  const rows = await parseValidatedGrepRows(rowsText, searchPath, searchStats.isDirectory(), signal, filesystem);
  if (rows.length === 0) return nativeResult;

  const groups = groupGrepRows(rows, searchPath, searchStats.isDirectory(), cwd);
  const blocks: string[] = [];
  let taggedFiles = 0;
  let linesTruncated = nativeResult.details?.linesTruncated ?? false;

  for (const group of groups.values()) {
    assertNotAborted(signal);
    const canEdit = await writable(group.absolutePath);
    assertNotAborted(signal);
    if (!canEdit) {
      blocks.push(group.nativeRows.join('\n'));
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await filesystem.readFile(group.absolutePath);
    } catch {
      blocks.push(group.nativeRows.join('\n'));
      continue;
    }
    assertNotAborted(signal);
    const lines = splitLines(decodeUtf8(bytes, group.path));
    const output = [formatFileHeader(group.path, computeFileTag(bytes))];
    for (const [lineNumber, isMatch] of [...group.rows].sort(([left], [right]) => left - right)) {
      const line = lines[lineNumber - 1];
      if (line === undefined) continue;
      const compact = outputOperations.truncateLine(line);
      if (compact.wasTruncated) linesTruncated = true;
      output.push(formatTaggedLine(compact.text, lineNumber, isMatch ? '>> ' : '   ', line));
    }
    if (output.length > 1) {
      blocks.push(output.join('\n'));
      taggedFiles++;
    } else {
      blocks.push(group.nativeRows.join('\n'));
    }
  }

  if (blocks.length === 0 || taggedFiles === 0) return nativeResult;
  const truncation = outputOperations.truncateHead(blocks.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  const extraNotice = truncation.truncated
    ? `\n\n[${outputOperations.formatSize(outputOperations.maxBytes)} tagged output limit reached]`
    : '';
  const details = {
    ...nativeResult.details,
    ...(truncation.truncated ? { truncation } : {}),
    ...(linesTruncated ? { linesTruncated: true } : {}),
  };
  assertNotAborted(signal);
  return {
    ...nativeResult,
    content: [{ type: 'text', text: `${truncation.content}${notice}${extraNotice}` }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

export function groupGrepRows(
  rows: readonly GrepRow[],
  searchPath: string,
  directory: boolean,
  cwd: string,
): Map<string, GrepGroup> {
  const groups = new Map<string, GrepGroup>();
  for (const row of rows) {
    const absolutePath = directory ? resolve(searchPath, row.path) : searchPath;
    let group = groups.get(absolutePath);
    if (!group) {
      group = { path: displayPath(absolutePath, cwd), absolutePath, nativeRows: [], rows: new Map() };
      groups.set(absolutePath, group);
    }
    if (row.native !== undefined) group.nativeRows.push(row.native);
    group.rows.set(row.line, row.match || group.rows.get(row.line) === true);
  }
  return groups;
}

async function parseValidatedGrepRows(
  rowsText: string,
  searchPath: string,
  directory: boolean,
  signal: AbortSignal | undefined,
  filesystem: GrepFileSystem,
): Promise<GrepRow[]> {
  const pathCache = new Map<string, boolean>();
  const rows: GrepRow[] = [];
  for (const value of rowsText.split('\n')) {
    assertNotAborted(signal);
    let resolvedCandidate: GrepRow | undefined;
    for (const candidate of grepRowCandidates(value)) {
      if (!directory) {
        if (candidate.path === basename(searchPath)) rows.push({ ...candidate, native: value });
        break;
      }
      const absolutePath = resolve(searchPath, candidate.path);
      let exists = pathCache.get(absolutePath);
      if (exists === undefined) {
        exists = await filesystem
          .stat(absolutePath)
          .then((value) => value.isFile())
          .catch(() => false);
        assertNotAborted(signal);
        pathCache.set(absolutePath, exists);
      }
      if (exists) resolvedCandidate = { ...candidate, native: value };
    }
    if (resolvedCandidate) rows.push(resolvedCandidate);
  }
  return rows;
}

function grepRowCandidates(value: string): GrepRow[] {
  const candidates: Array<{ readonly index: number; readonly row: GrepRow }> = [];
  for (const match of value.matchAll(MATCH_DELIMITER)) {
    candidates.push({
      index: match.index,
      row: { path: value.slice(0, match.index), line: Number.parseInt(match[1] ?? '', 10), match: true },
    });
  }
  for (const match of value.matchAll(CONTEXT_DELIMITER)) {
    candidates.push({
      index: match.index,
      row: { path: value.slice(0, match.index), line: Number.parseInt(match[1] ?? '', 10), match: false },
    });
  }
  return candidates.sort((left, right) => left.index - right.index).map(({ row }) => row);
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
