import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  displayPath,
  computeFileTag,
  decodeUtf8,
  isWritableFile,
  resolveInputPath,
} from '@agimon-ai/doompi-hashline/files';
import { formatFileHeader, formatTaggedLine, splitLines } from '@agimon-ai/doompi-hashline';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type GrepToolDetails,
} from '@earendil-works/pi-coding-agent';
import { GrepParamsSchema, type GrepParams } from '../../schemas/grepTool.ts';

const MATCH_DELIMITER = /:(\d+): /gu;
const CONTEXT_DELIMITER = /-(\d+)- /gu;
const NO_MATCHES = 'No matches found';

interface GrepRow {
  readonly path: string;
  readonly line: number;
  readonly match: boolean;
  readonly native?: string;
}

interface GrepGroup {
  readonly path: string;
  readonly absolutePath: string;
  readonly nativeRows: string[];
  readonly rows: Map<number, boolean>;
}

type WritableCheck = (path: string) => Promise<boolean>;

/** Register only the snapshot-bound replacement for Pi's grep tool. */
export function registerHashlineGrepTool(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  writable: WritableCheck = isWritableFile,
): void {
  pi.registerTool({
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents using Pi-compatible ripgrep semantics, then add exact-byte file tags and stable line anchors for writable matches. Non-writable matches retain native Pi output. Respects .gitignore.',
    promptSnippet: 'Search file contents and return editable hashline anchors',
    parameters: GrepParamsSchema,
    executionMode: 'parallel',
    renderShell: 'self',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as GrepParams;
      const nativeGrep = createGrepToolDefinition(ctx.cwd);
      const nativeResult = await nativeGrep.execute(toolCallId, input, signal, onUpdate, ctx);
      assertNotAborted(signal);
      return tagGrepResult(nativeResult, input, ctx.cwd, signal, writable);
    },
    renderCall(args, theme) {
      const input = args as GrepParams;
      const details = [
        input.path ?? '.',
        input.glob,
        input.ignoreCase === true ? 'ignore case' : undefined,
        input.limit === undefined ? undefined : `${input.limit} matches`,
      ].filter((value): value is string => value !== undefined);
      return renderHashlineCall('grep', input.pattern, details, theme);
    },
    renderResult(result, options, theme, context) {
      return renderHashlineResult(result, options, theme, context, 'grep');
    },
  });
}

export async function tagGrepResult(
  nativeResult: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>['execute']>>,
  params: GrepParams,
  cwd: string,
  signal: AbortSignal | undefined,
  writable: WritableCheck = isWritableFile,
): Promise<typeof nativeResult> {
  const textPart = nativeResult.content.find((part) => part.type === 'text');
  if (!textPart || textPart.text === NO_MATCHES) return nativeResult;

  const noticeIndex = textPart.text.lastIndexOf('\n\n[');
  const rowsText = noticeIndex === -1 ? textPart.text : textPart.text.slice(0, noticeIndex);
  const notice = noticeIndex === -1 ? '' : textPart.text.slice(noticeIndex);
  const searchPath = resolveInputPath(params.path ?? '.', cwd);
  const searchStats = await stat(searchPath);
  assertNotAborted(signal);
  const rows = await parseValidatedGrepRows(rowsText, searchPath, searchStats.isDirectory(), signal);
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
    let bytes: Buffer;
    try {
      bytes = await readFile(group.absolutePath);
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
      const compact = truncateLine(line);
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
  const truncation = truncateHead(blocks.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER });
  const extraNotice = truncation.truncated ? `\n\n[${formatSize(DEFAULT_MAX_BYTES)} tagged output limit reached]` : '';
  const details: GrepToolDetails = {
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

export function parseGrepRow(value: string): GrepRow[] {
  return grepRowCandidates(value)
    .slice(0, 1)
    .map(({ line, match, path }) => ({ line, match, path }));
}

async function parseValidatedGrepRows(
  rowsText: string,
  searchPath: string,
  directory: boolean,
  signal: AbortSignal | undefined,
): Promise<GrepRow[]> {
  const pathCache = new Map<string, boolean>();
  const rows: GrepRow[] = [];
  for (const value of rowsText.split('\n')) {
    assertNotAborted(signal);
    let resolvedCandidate: GrepRow | undefined;
    for (const candidate of grepRowCandidates(value)) {
      if (!directory) {
        if (candidate.path === basename(searchPath)) {
          rows.push({ ...candidate, native: value });
          break;
        }
        continue;
      }
      const absolutePath = resolve(searchPath, candidate.path);
      let exists = pathCache.get(absolutePath);
      if (exists === undefined) {
        exists = await stat(absolutePath)
          .then((value) => value.isFile())
          .catch(() => false);
        assertNotAborted(signal);
        pathCache.set(absolutePath, exists);
      }
      if (exists) {
        // A delimiter can be part of a valid POSIX filename. Keep the longest
        // existing prefix so `foo:42: bar.txt` does not resolve to sibling `foo`.
        resolvedCandidate = { ...candidate, native: value };
      }
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
