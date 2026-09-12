import { formatFileHeader, formatTaggedLine, splitLines } from '@agimon-ai/doompi-hashline';
import {
  computeFileTag,
  decodeUtf8,
  displayPath,
  isWritableFile,
  resolveReadInputPath,
} from '@agimon-ai/doompi-hashline/files';
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type ReadToolDetails,
} from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';
import { ReadParamsSchema, type ReadParams } from '../../schemas/readTool';
import {
  applyImageLimits,
  imageLimits,
  type ReadContentPart,
  type ReadImageResizeOperations,
  type ReadTextPart,
} from '../readImage';

const resizeOperations: ReadImageResizeOperations = {
  resize: resizeImage,
  formatDimensionNote: (result) => formatDimensionNote(result),
};

export interface ReadToolResult {
  content: ReadContentPart[];
  details?: ReadToolDetails;
}

interface ReadTextToolResult {
  content: ReadTextPart[];
  details?: ReadToolDetails;
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

export function isImagePath(filePath: string): string | undefined {
  const extension = filePath.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  if (!extension) return undefined;
  const mimeTypes: Record<string, string> = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return mimeTypes[extension];
}

export async function executeHeadlessRead(
  params: ReadParams,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ReadToolResult> {
  assertNotAborted(signal);
  const absolutePath = await resolveReadInputPath(params.path, cwd);
  const bytes = await readFile(absolutePath);
  assertNotAborted(signal);
  const mimeType = isImagePath(absolutePath);
  if (mimeType) {
    const content: ReadContentPart[] = [
      { type: 'text', text: `Read image file ${displayPath(absolutePath, cwd)} [${mimeType}]` },
      { type: 'image', data: bytes.toString('base64'), mimeType },
    ];
    return { content: await applyImageLimits(content, imageLimits(), resizeOperations) };
  }
  if (!(await isWritableFile(absolutePath))) {
    return { content: [{ type: 'text', text: decodeUtf8(bytes, displayPath(absolutePath, cwd)) }] };
  }
  return createTaggedReadResult(bytes, displayPath(absolutePath, cwd), params);
}

export function createTaggedReadResult(bytes: Buffer, path: string, params: ReadParams): ReadTextToolResult {
  const lines = splitLines(decodeUtf8(bytes, path));
  const startIndex = params.offset === undefined ? 0 : params.offset - 1;
  if (startIndex >= lines.length) {
    throw new Error(`Offset ${params.offset} is beyond end of file (${lines.length} lines total).`);
  }

  const endIndex = params.limit === undefined ? lines.length : Math.min(lines.length, startIndex + params.limit);
  const selected = lines.slice(startIndex, endIndex);
  const header = formatFileHeader(path, computeFileTag(bytes));
  const compactedLines: number[] = [];
  const headerBytes = Buffer.byteLength(header, 'utf8') + 1;
  const tagged = selected.map((line, index) => {
    const lineNumber = startIndex + index + 1;
    const full = formatTaggedLine(line, lineNumber);
    if (Buffer.byteLength(full, 'utf8') <= DEFAULT_MAX_BYTES - headerBytes) return full;
    compactedLines.push(lineNumber);
    return formatTaggedLine(truncateLine(line).text, lineNumber, '', line);
  });
  const truncation = truncateHead([header, ...tagged].join('\n'));
  let text = truncation.content;
  let details: ReadToolDetails | undefined;

  if (truncation.truncated) {
    const shownLines = Math.max(0, truncation.outputLines - 1);
    const nextOffset = startIndex + shownLines + 1;
    const reason = truncation.truncatedBy === 'bytes' ? `, ${formatSize(DEFAULT_MAX_BYTES)} limit` : '';
    text += `\n\n[Showing ${shownLines} anchored lines${reason}. Use offset=${nextOffset} to continue.]`;
    details = { truncation };
  } else {
    const notices: string[] = [];
    if (compactedLines.length > 0) {
      notices.push(`Lines ${compactedLines.join(', ')} shown compactly. Their anchors hash the full original lines`);
    }
    if (endIndex < lines.length) {
      notices.push(`${lines.length - endIndex} more lines in file. Use offset=${endIndex + 1} to continue`);
    }
    if (notices.length > 0) text += `\n\n[${notices.join('. ')}.]`;
  }

  return { content: [{ type: 'text', text }], details };
}

export function isImageRead(content: readonly { readonly type: string; readonly text?: string }[]): boolean {
  return content.some((part) => part.type === 'image' || part.text?.startsWith('Read image file') === true);
}

export function createHeadlessReadTool(): DoomHeadlessTool<typeof ReadParamsSchema> {
  return {
    name: 'read',
    label: 'read',
    description:
      'Read a writable text file with an exact-byte file tag and stable line anchors. Non-writable files and images return native-compatible content. Text is truncated to 50.0KB.',
    promptSnippet: 'Read file contents with snapshot-bound line anchors',
    promptGuidelines: [
      'Use read before edit. When hashline metadata is present, preserve the @file hash and anchors such as 5#abc exactly.',
      'Continue large reads with offset until the required anchored lines are visible.',
    ],
    parameters: ReadParamsSchema,
    executionMode: 'parallel',
    execute: async (
      _toolCallId: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
      context: DoomHeadlessExecutionContext,
    ) => executeHeadlessRead(params, context.cwd, signal),
  };
}
