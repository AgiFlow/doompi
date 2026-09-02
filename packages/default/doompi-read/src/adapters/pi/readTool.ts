import { formatFileHeader, formatTaggedLine, splitLines } from '@agimon-ai/doompi-hashline';
import {
  computeFileTag,
  decodeUtf8,
  displayPath,
  isWritableFile,
  resolveReadInputPath,
} from '@agimon-ai/doompi-hashline/files';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import { readFile } from 'node:fs/promises';
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type ReadToolDetails,
} from '@earendil-works/pi-coding-agent';
import { ReadParamsSchema, type ReadParams } from '../../schemas/readTool.ts';
import { applyImageLimits, imageLimits } from './readImage.ts';

type WritableCheck = (path: string) => Promise<boolean>;

/** Register the snapshot-bound replacement for Pi's read tool. */
export function registerHashlineReadTool(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  writable: WritableCheck = isWritableFile,
): void {
  pi.registerTool({
    name: 'read',
    label: 'read',
    description: `Read a writable text file with an exact-byte file tag and stable line anchors. Non-writable files and images retain Pi's native behavior. Text is truncated to ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: 'Read file contents with snapshot-bound line anchors',
    promptGuidelines: [
      'Use read before edit. When hashline metadata is present, preserve the @file hash and anchors such as 5#abc exactly.',
      'Continue large reads with offset until the required anchored lines are visible.',
    ],
    parameters: ReadParamsSchema,
    executionMode: 'parallel',
    renderShell: 'self',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as ReadParams;
      assertNotAborted(signal);
      const absolutePath = await resolveReadInputPath(input.path, ctx.cwd);
      // Pi resizes at a cap it hardcodes, so it is told not to: the block comes
      // back converted but full size, and the machine's configured cap is
      // applied below. Everything else about the native read is kept.
      const nativeRead = createReadToolDefinition(ctx.cwd, { autoResizeImages: false });
      const nativeResult = await nativeRead.execute(
        toolCallId,
        { ...input, path: absolutePath },
        signal,
        onUpdate,
        ctx,
      );
      if (isImageRead(nativeResult.content)) {
        assertNotAborted(signal);
        return { ...nativeResult, content: await applyImageLimits(nativeResult.content, imageLimits()) };
      }

      assertNotAborted(signal);
      const canEdit = await writable(absolutePath);
      assertNotAborted(signal);
      if (!canEdit) return nativeResult;
      const bytes = await readFile(absolutePath);
      assertNotAborted(signal);
      return createTaggedReadResult(bytes, displayPath(absolutePath, ctx.cwd), input);
    },
    renderCall(args, theme) {
      const input = args as ReadParams;
      const details = [
        input.offset === undefined ? undefined : `from ${input.offset}`,
        input.limit === undefined ? undefined : `${input.limit} lines`,
      ].filter((value): value is string => value !== undefined);
      return renderHashlineCall('read', input.path, details, theme);
    },
    renderResult(result, options, theme, context) {
      return renderHashlineResult(result, options, theme, context, 'read');
    },
  });
}

export function createTaggedReadResult(
  bytes: Buffer,
  path: string,
  params: ReadParams,
): { content: [{ type: 'text'; text: string }]; details: ReadToolDetails | undefined } {
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

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
