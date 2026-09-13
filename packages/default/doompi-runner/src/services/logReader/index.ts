import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { DEFAULT_LINES, READ_CHUNK_BYTES } from '../../constants/logReader';
import { type Excerpt, type LogSummary, type TruncatedOutput } from '../../types/bashResult';
import type { ILogReader, LogQuery, LogSlice } from '../../types/logReader';
import { boundExcerpt, composeExcerpt, countLines, createErrorScanner, formatSize } from '../bashResult';
import { getResultMaxBytes, getResultMaxLines, getResultMaxTokens } from '../runnerConfig';

interface IndexedLine {
  readonly index: number;
  readonly text: string;
}

interface ScannedLog {
  readonly text: string;
  readonly lineCount: number;
  readonly totalLines: number;
  readonly completeBytes: number;
  readonly lineNumbers?: number[];
}

export class LogReader implements ILogReader {
  read(logPath: string, query: LogQuery = {}): LogSlice {
    let handle: number | undefined;
    try {
      handle = fs.openSync(logPath, 'r');
      const scanned = scanLog(handle, query);
      return {
        ...scanned,
        fileSize: fs.fstatSync(handle).size,
        path: logPath,
        exists: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        text: '',
        lineCount: 0,
        totalLines: 0,
        fileSize: 0,
        completeBytes: 0,
        path: logPath,
        exists: false,
      };
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  }
}

function scanLog(handle: number, query: LogQuery): ScannedLog {
  const limit = Math.max(0, Math.floor(query.lines ?? DEFAULT_LINES));
  const needle = query.grep ? (query.ignoreCase ? query.grep.toLowerCase() : query.grep) : undefined;
  const contextLines = Math.max(0, Math.floor(query.contextLines ?? 0));
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const before: IndexedLine[] = [];
  const output: IndexedLine[] = [];
  let pending = '';
  let totalLines = 0;
  let afterThrough = -1;
  let lastEmitted = -1;
  let lastByte: number | undefined;
  let bytesSeen = 0;
  let completeBytes = 0;

  const retain = (line: IndexedLine): void => {
    if (limit === 0) return;
    output.push(line);
    if (output.length > limit) output.shift();
  };
  const emit = (line: IndexedLine): void => {
    if (line.index <= lastEmitted) return;
    lastEmitted = line.index;
    retain(line);
  };
  const consume = (text: string): void => {
    const line = { index: totalLines, text };
    totalLines += 1;
    if (!needle) {
      retain(line);
      return;
    }

    const haystack = query.ignoreCase ? text.toLowerCase() : text;
    if (haystack.includes(needle)) {
      for (const previous of before) emit(previous);
      emit(line);
      afterThrough = Math.max(afterThrough, line.index + contextLines);
    } else if (line.index <= afterThrough) {
      emit(line);
    }
    before.push(line);
    if (before.length > contextLines) before.shift();
  };

  for (;;) {
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    lastByte = buffer[bytesRead - 1];
    // A newline is a single byte in UTF-8 and never a continuation byte, so the
    // last one in this chunk ends the last complete line seen so far.
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline >= 0) completeBytes = bytesSeen + lastNewline + 1;
    bytesSeen += bytesRead;
    pending += decoder.write(buffer.subarray(0, bytesRead));
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.end();
  if (pending.length > 0) consume(pending);

  const trailingNewline = lastByte === 0x0a;
  const body = output.map((line) => line.text).join('\n');
  const text = `${body}${!needle && trailingNewline && output.length > 0 ? '\n' : ''}`;
  const scanned: ScannedLog = { text, lineCount: output.length, totalLines, completeBytes };
  if (!needle) return scanned;
  return { ...scanned, lineNumbers: output.map((line) => line.index + 1) };
}

/**
 * Grep with context, matching the `product-stack logs` semantics so the two
 * surfaces behave the same. Overlapping and adjacent context windows merge.
 */
export function filterLogText(text: string, query: Pick<LogQuery, 'grep' | 'ignoreCase' | 'contextLines'>): string {
  if (!query.grep) return text;
  const lines = text.split('\n');
  const needle = query.ignoreCase ? query.grep.toLowerCase() : query.grep;
  const contextLines = Math.max(0, query.contextLines ?? 0);
  const ranges: Array<{ start: number; end: number }> = [];

  lines.forEach((line, index) => {
    const haystack = query.ignoreCase ? line.toLowerCase() : line;
    if (!haystack.includes(needle)) return;
    ranges.push({
      start: Math.max(0, index - contextLines),
      end: Math.min(lines.length - 1, index + contextLines),
    });
  });

  if (ranges.length === 0) return '';
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.flatMap((range) => lines.slice(range.start, range.end + 1)).join('\n');
}

/** Reads a bounded head and tail plus exact metadata after the writer has flushed. */
export function summarizeLog(
  path: string,
  maxLines = getResultMaxLines(),
  maxBytes = getResultMaxBytes(),
  maxTokens = getResultMaxTokens(),
): LogSummary {
  let handle: number | undefined;
  try {
    const size = fs.statSync(path).size;
    handle = fs.openSync(path, 'r');
    const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
    // Both ends are captured at the full budget; the line trim decides the split.
    const endLimit = Math.max(1, maxBytes + 1);
    let headBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let tailBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let newlineCount = 0;
    let lastByte: number | undefined;
    const decoder = new StringDecoder('utf8');
    const scanned = createErrorScanner();
    let pending = '';
    for (;;) {
      const bytesRead = fs.readSync(handle, readBuffer, 0, readBuffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = readBuffer.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
      lastByte = chunk.at(-1);
      if (headBuffer.byteLength < endLimit) {
        headBuffer = Buffer.concat([headBuffer, chunk.subarray(0, endLimit - headBuffer.byteLength)]);
      }
      tailBuffer = appendBufferTail(tailBuffer, chunk, endLimit);
      pending += decoder.write(chunk);
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        scanned.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending.length > 0) scanned.push(pending);
    const lines = newlineCount + (size > 0 && lastByte !== 0x0a ? 1 : 0);
    // The tail capture holds the whole file only while the file fits inside one
    // buffer. Past that the start is already gone from it, so the two ends have
    // to be composed instead.
    const excerpt =
      size <= tailBuffer.byteLength
        ? boundExcerpt(utf8Tail(tailBuffer, tailBuffer.byteLength), maxLines, maxBytes, maxTokens)
        : composeExcerpt(
            headBuffer.toString('utf8'),
            utf8Tail(tailBuffer, tailBuffer.byteLength),
            lines,
            maxLines,
            maxBytes,
            scanned.entries(),
            maxTokens,
          );
    return { tail: excerpt.text, bytes: size, lines, tailLines: excerpt.lines };
  } catch {
    return { tail: '', bytes: 0, lines: 0, tailLines: 0 };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/**
 * Keeps both ends of an oversized result and points at the file holding the rest.
 *
 * The notice states the file's real size and line count so the model does not
 * guess at offsets when it goes on to read the file, which is the failure this
 * whole policy exists to prevent.
 */
export function truncateForResult(
  text: string,
  fullOutputPath: string,
  maxBytes = getResultMaxBytes(),
  maxLines = getResultMaxLines(),
): TruncatedOutput {
  const excerpt = boundExcerpt(text, maxLines, maxBytes);
  if (!excerpt.truncated) return { text, truncated: false, outputLines: excerpt.lines };

  return {
    text: `${excerpt.text}\n${truncationNotice(excerpt, fullOutputPath, text)}`,
    truncated: true,
    outputLines: excerpt.lines,
  };
}

function truncationNotice(excerpt: Excerpt, fullOutputPath: string, text: string): string {
  // Counted from the file, never from `text`. What the caller holds in memory
  // is itself capped, so using it here would understate the file by orders of
  // magnitude and send the reader looking past the end of a much longer file.
  const file = measureFile(fullOutputPath);
  const totalLines = file?.lines ?? countLines(text);
  const fileSize = file?.bytes ?? Buffer.byteLength(text, 'utf8');

  return [
    `[output truncated: showing ${excerpt.lines.toLocaleString('en-US')} of ${totalLines.toLocaleString('en-US')} lines,`,
    `${excerpt.elidedLines.toLocaleString('en-US')} elided from the middle.`,
    `Full output is at ${fullOutputPath} (${formatSize(fileSize)}, ${totalLines.toLocaleString('en-US')} lines).`,
    `Inspect it with doom-runner logs, or read the file with an offset near line ${totalLines.toLocaleString('en-US')}.]`,
  ].join(' ');
}

/** Real size and line count of the file the notice points at. */
function measureFile(path: string): { bytes: number; lines: number } | undefined {
  let handle: number | undefined;
  try {
    const bytes = fs.statSync(path).size;
    handle = fs.openSync(path, 'r');
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let newlineCount = 0;
    let lastByte: number | undefined;
    for (;;) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
      lastByte = chunk.at(-1);
    }
    return { bytes, lines: newlineCount + (bytes > 0 && lastByte !== 0x0a ? 1 : 0) };
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function utf8Tail(encoded: Buffer<ArrayBufferLike>, maxBytes: number): string {
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

function appendBufferTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): Buffer<ArrayBufferLike> {
  if (chunk.byteLength >= limit) return Buffer.from(chunk.subarray(chunk.byteLength - limit));
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength > limit ? Buffer.from(combined.subarray(combined.byteLength - limit)) : combined;
}
