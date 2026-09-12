import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DIR_ENV, LOG_MAX_BYTES_ENV } from '../../src/exports/config';
import { LogFile } from '../../src/services/logFile';
import { filterLogText, LogReader } from '../../src/services/logReader';
import { RunnerPaths } from '../../src/services/runnerPaths';

let directory: string;
let previousMaxBytes: string | undefined;

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-logs-')));
  process.env[LOG_DIR_ENV] = directory;
  previousMaxBytes = process.env[LOG_MAX_BYTES_ENV];
});

afterEach(() => {
  delete process.env[LOG_DIR_ENV];
  if (previousMaxBytes === undefined) delete process.env[LOG_MAX_BYTES_ENV];
  else process.env[LOG_MAX_BYTES_ENV] = previousMaxBytes;
  fs.rmSync(directory, { recursive: true, force: true });
});

function logFile(): LogFile {
  return new LogFile(new RunnerPaths());
}

describe('LogFile', () => {
  it('appends to the runner log and reports bytes written', () => {
    const writer = logFile().open('api');
    writer.append('one\n');
    writer.append('two\n');
    writer.close();

    expect(fs.readFileSync(writer.path, 'utf8')).toBe('one\ntwo\n');
    expect(writer.path).toBe(path.join(directory, 'api.log'));
  });

  it('counts bytes rather than characters', () => {
    const writer = logFile().open('api');
    writer.append('café\n');
    writer.close();
    expect(writer.size()).toBe(6);
  });

  it('truncates output left by a previous runner of the same name', () => {
    fs.writeFileSync(path.join(directory, 'api.log'), 'stale\n');
    const writer = logFile().open('api');
    writer.append('fresh\n');
    writer.close();

    expect(fs.readFileSync(writer.path, 'utf8')).toBe('fresh\n');
  });

  it('rotates at the configured ceiling instead of growing one file forever', () => {
    process.env[LOG_MAX_BYTES_ENV] = '8';
    const writer = logFile().open('api');
    writer.append('12345678');
    writer.append('complete\n');
    writer.close();

    // The advertised path holds the newest window and the one before it sits beside it.
    expect(fs.readFileSync(path.join(directory, 'api.log'), 'utf8')).toBe('complete\n');
    expect(fs.readFileSync(path.join(directory, 'api.log.1'), 'utf8')).toBe('12345678');
    expect(writer.size()).toBe(9);
  });

  it('bounds a long run to roughly twice the ceiling while the advertised counts stay honest', () => {
    const ceiling = 512;
    process.env[LOG_MAX_BYTES_ENV] = String(ceiling);
    const writer = logFile().open('api');
    const line = `${'x'.repeat(63)}\n`;
    for (let index = 0; index < 500; index += 1) writer.append(line);
    writer.close();

    const logPath = path.join(directory, 'api.log');
    const rotatedPath = path.join(directory, 'api.log.1');
    // 500 * 64 bytes of output, held to two windows on disk.
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(ceiling + line.length);
    expect(fs.statSync(logPath).size + fs.statSync(rotatedPath).size).toBeLessThanOrEqual(2 * (ceiling + line.length));

    // What a reader would advertise still describes the file it read.
    const text = fs.readFileSync(logPath, 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBe(writer.size());
    expect(text.split('\n').length - 1).toBe(writer.size() / line.length);
  });

  it('tolerates being closed twice', () => {
    const writer = logFile().open('api');
    writer.close();
    expect(() => writer.close()).not.toThrow();
  });

  it('creates the log directory when it is missing', () => {
    const nested = path.join(directory, 'nested');
    process.env[LOG_DIR_ENV] = nested;
    logFile().open('api').close();
    expect(fs.existsSync(path.join(nested, 'api.log'))).toBe(true);
  });
});

describe('LogReader', () => {
  const reader = new LogReader();

  function write(name: string, contents: string): string {
    const file = path.join(directory, name);
    fs.writeFileSync(file, contents);
    return file;
  }

  it('reports a missing log rather than throwing', () => {
    const slice = reader.read(path.join(directory, 'absent.log'));
    expect(slice).toMatchObject({ text: '', lineCount: 0, totalLines: 0, fileSize: 0, exists: false });
  });

  it('returns the whole file when it is shorter than the tail', () => {
    const file = write('api.log', 'one\ntwo\n');
    const slice = reader.read(file);
    expect(slice.text).toBe('one\ntwo\n');
    expect(slice.lineCount).toBe(2);
    expect(slice.totalLines).toBe(2);
    expect(slice.fileSize).toBe(8);
  });

  it('keeps the tail and still reports the full line count', () => {
    const file = write('api.log', Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n'));
    const slice = reader.read(file, { lines: 3 });

    expect(slice.text).toBe('line-7\nline-8\nline-9');
    expect(slice.lineCount).toBe(3);
    expect(slice.totalLines).toBe(10);
  });

  it('reports the whole file as complete when it ends on a newline', () => {
    const file = write('whole.log', 'one\ntwo\n');
    expect(reader.read(file).completeBytes).toBe(8);
  });

  it('stops completeBytes at the last newline when the runner is caught mid-line', () => {
    // A follower resumes here, so the fragment arrives as part of its whole
    // line rather than split across the slice and the first appended chunk.
    const file = write('partial.log', 'one\ntwo\nthr');
    const slice = reader.read(file);

    expect(slice.fileSize).toBe(11);
    expect(slice.completeBytes).toBe(8);
    // The fragment is still returned: a finished run whose last line never got
    // a newline would otherwise lose it entirely.
    expect(slice.text).toBe('one\ntwo\nthr');
  });

  it('counts completeBytes in bytes, not characters', () => {
    // A multi-byte line would put the resume offset in the wrong place if the
    // scan counted decoded characters.
    const file = write('utf8.log', 'héllo\n');
    expect(reader.read(file).completeBytes).toBe(7);
  });

  it('reports no line numbers for a plain tail, whose numbers run unbroken', () => {
    const file = write('plain.log', 'one\ntwo\n');
    expect(reader.read(file).lineNumbers).toBeUndefined();
  });

  it('numbers grep results, so a reader can tell where the gaps are', () => {
    const file = write('grep.log', 'alpha\nbeta\ngamma\nalpha\n');
    const slice = reader.read(file, { grep: 'alpha' });

    expect(slice.text).toBe('alpha\nalpha');
    expect(slice.lineNumbers).toEqual([1, 4]);
  });

  it('numbers context lines too, so a gap is a real gap and not a dropped context line', () => {
    const file = write('context.log', 'one\ntwo\nmatch\nfour\nfive\nsix\nmatch\n');
    const slice = reader.read(file, { grep: 'match', contextLines: 1 });

    expect(slice.lineNumbers).toEqual([2, 3, 4, 6, 7]);
  });

  it('scans a large append-only log without loading the complete file into memory', () => {
    const contents = `${Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join('\n')}\n`;
    const file = write('large.log', contents);
    const readFile = vi.spyOn(fs, 'readFileSync');

    try {
      const slice = reader.read(file, { lines: 3 });
      expect(slice.text).toBe('line-19997\nline-19998\nline-19999\n');
      expect(slice.totalLines).toBe(20_000);
      expect(slice.fileSize).toBe(Buffer.byteLength(contents));
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it('returns nothing when zero lines are requested', () => {
    const file = write('api.log', 'one\ntwo\n');
    expect(reader.read(file, { lines: 0 }).text).toBe('');
  });

  it('greps the whole file, not just the tail', () => {
    const lines = Array.from({ length: 500 }, (_, index) => (index === 0 ? 'boom happened' : `line-${index}`));
    const file = write('api.log', lines.join('\n'));

    const slice = reader.read(file, { grep: 'boom' });
    expect(slice.text).toBe('boom happened');
    expect(slice.totalLines).toBe(500);
  });

  it('matches case-insensitively when asked', () => {
    const file = write('api.log', 'Boom\nquiet\n');
    expect(reader.read(file, { grep: 'boom' }).text).toBe('');
    expect(reader.read(file, { grep: 'boom', ignoreCase: true }).text).toBe('Boom');
  });

  it('includes context lines around each match', () => {
    const file = write('api.log', 'a\nb\nmatch\nd\ne\n');
    expect(reader.read(file, { grep: 'match', contextLines: 1 }).text).toBe('b\nmatch\nd');
  });

  it('merges overlapping context windows instead of repeating lines', () => {
    const file = write('api.log', 'match\nb\nmatch\nd\n');
    expect(reader.read(file, { grep: 'match', contextLines: 1 }).text).toBe('match\nb\nmatch\nd');
  });

  it('returns an empty slice when nothing matches', () => {
    const file = write('api.log', 'one\ntwo\n');
    const slice = reader.read(file, { grep: 'absent' });
    expect(slice.text).toBe('');
    expect(slice.lineCount).toBe(0);
    expect(slice.exists).toBe(true);
  });
});

describe('filterLogText', () => {
  it('returns unfiltered text when no grep is requested', () => {
    expect(filterLogText('one\ntwo', {})).toBe('one\ntwo');
  });

  it('returns nothing when no line matches', () => {
    expect(filterLogText('one\ntwo', { grep: 'absent' })).toBe('');
  });

  it('matches without case sensitivity and merges adjacent context windows', () => {
    expect(filterLogText('A\nhit\nc\nd\nHIT', { grep: 'hit', ignoreCase: true, contextLines: 1 })).toBe(
      'A\nhit\nc\nd\nHIT',
    );
  });

  it('keeps separated matches without inventing context', () => {
    expect(filterLogText('hit\na\nb\nc\nhit', { grep: 'hit' })).toBe('hit\nhit');
  });
});
