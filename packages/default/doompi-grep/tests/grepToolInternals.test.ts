import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupGrepRows, parseGrepRow, tagGrepResult } from '../src/adapters/pi/grepTool.ts';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-grep-internals-'));
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('hashline grep internals', () => {
  it('parses the earliest native delimiter and preserves context rows', () => {
    expect(parseGrepRow('nested/a.ts:2: value :42: tail')).toEqual([{ path: 'nested/a.ts', line: 2, match: true }]);
    expect(parseGrepRow('nested/a.ts-3- value -42- tail')).toEqual([{ path: 'nested/a.ts', line: 3, match: false }]);
    expect(parseGrepRow('not a grep row')).toEqual([]);
  });

  it('groups file and directory rows while a match wins over duplicate context', () => {
    const rows = [
      { path: 'a.ts', line: 2, match: false },
      { path: 'a.ts', line: 2, match: true },
      { path: 'a.ts', line: 2, match: false },
    ];
    const directoryGroups = groupGrepRows(rows, directory, true, directory);
    expect([...directoryGroups.values()][0]?.rows.get(2)).toBe(true);
    expect([...directoryGroups.values()][0]?.nativeRows).toEqual([]);
    const file = join(directory, 'a.ts');
    const fileGroups = groupGrepRows(rows, file, false, directory);
    expect([...fileGroups.keys()]).toEqual([file]);
  });

  it('falls back to the native result for absent, malformed, and stale rows', async () => {
    const noText = { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], details: undefined };
    await expect(tagGrepResult(noText as never, { pattern: 'needle' }, directory, undefined)).resolves.toBe(noText);

    const malformed = { content: [{ type: 'text', text: 'unexpected output' }], details: undefined };
    await expect(tagGrepResult(malformed as never, { pattern: 'needle' }, directory, undefined)).resolves.toBe(
      malformed,
    );

    await writeFile(join(directory, 'short.ts'), 'one');
    const stale = { content: [{ type: 'text', text: 'short.ts:2: gone' }], details: undefined };
    await expect(tagGrepResult(stale as never, { pattern: 'needle' }, directory, undefined)).resolves.toBe(stale);
  });

  it('rejects invalid UTF-8 and observes cancellation', async () => {
    await writeFile(join(directory, 'binary.ts'), Buffer.from([0x80, 0x0a, 0x74, 0x77, 0x6f]));
    const binary = { content: [{ type: 'text', text: 'binary.ts:2: two' }], details: undefined };
    await expect(tagGrepResult(binary as never, { pattern: 'two' }, directory, undefined)).rejects.toThrow(
      'not valid UTF-8',
    );

    const controller = new AbortController();
    controller.abort();
    const native = { content: [{ type: 'text', text: 'binary.ts:2: two' }], details: undefined };
    await expect(tagGrepResult(native as never, { pattern: 'two' }, directory, controller.signal)).rejects.toThrow(
      'Operation aborted',
    );
  });

  it('bounds tagged output independently and preserves the native notice', async () => {
    const lines = Array.from({ length: 130 }, (_, index) => `needle ${index} ${'x'.repeat(490)}`);
    await writeFile(join(directory, 'large.ts'), lines.join('\n'));
    const rows = lines.map((line, index) => `large.ts:${index + 1}: ${line}`).join('\n');
    const native = { content: [{ type: 'text', text: `${rows}\n\n[native notice]` }], details: undefined };

    const result = await tagGrepResult(native as never, { pattern: 'needle' }, directory, undefined);
    const output = result.content[0];
    expect(output?.type).toBe('text');
    if (output?.type !== 'text') throw new Error('Expected text output');
    expect(output.text).toContain('tagged output limit reached');
    expect(output.text).toContain('[native notice]');
    expect(result.details?.truncation?.truncated).toBe(true);
  });
});
