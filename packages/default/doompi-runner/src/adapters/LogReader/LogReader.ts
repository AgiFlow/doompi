import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ILogReader, LogQuery, LogSlice } from '../../types/logReader';

const DEFAULT_LINES = 200;
const READ_CHUNK_BYTES = 64 * 1024;

interface IndexedLine {
  readonly index: number;
  readonly text: string;
}

interface ScannedLog {
  readonly text: string;
  readonly lineCount: number;
  readonly totalLines: number;
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
      return { text: '', lineCount: 0, totalLines: 0, fileSize: 0, path: logPath, exists: false };
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
  const output: string[] = [];
  let pending = '';
  let totalLines = 0;
  let afterThrough = -1;
  let lastEmitted = -1;
  let lastByte: number | undefined;

  const retain = (line: string): void => {
    if (limit === 0) return;
    output.push(line);
    if (output.length > limit) output.shift();
  };
  const emit = (line: IndexedLine): void => {
    if (line.index <= lastEmitted) return;
    lastEmitted = line.index;
    retain(line.text);
  };
  const consume = (text: string): void => {
    const line = { index: totalLines, text };
    totalLines += 1;
    if (!needle) {
      retain(text);
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
  const text = `${output.join('\n')}${!needle && trailingNewline && output.length > 0 ? '\n' : ''}`;
  return { text, lineCount: output.length, totalLines };
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
