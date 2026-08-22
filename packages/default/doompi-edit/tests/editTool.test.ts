import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLine } from '@agimon-ai/doompi-hashline';
import { computeFileTag } from '@agimon-ai/doompi-hashline/files';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeHashlineEdit, registerHashlineEditTool } from '../src/adapters/pi/editTool.ts';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-edit-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function anchor(line: number, content: string): string {
  return `${line}#${hashLine(content)}`;
}

describe('hashline edit execution', () => {
  it('registers only edit with the shared Doom tool chrome', () => {
    let tool:
      | {
          readonly name: string;
          readonly renderShell?: string;
          renderCall?(args: Record<string, unknown>, theme: unknown): { render(width: number): string[] };
        }
      | undefined;
    registerHashlineEditTool({
      registerTool(definition) {
        tool = definition as unknown as typeof tool;
      },
    } as Pick<ExtensionAPI, 'registerTool'>);
    const identity = (value: string): string => value;
    const theme = {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => value,
      bold: identity,
      dim: identity,
      inverse: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    };

    expect(tool?.name).toBe('edit');
    expect(tool?.renderShell).toBe('self');
    expect(
      tool?.renderCall?.({ path: 'a.ts', hash: 'abcdefgh', edits: [{ from: '1#abc', to: '1#abc' }] }, theme).render(80),
    ).toEqual(expect.arrayContaining([expect.stringContaining('EDIT  a.ts · 1 range')]));
  });

  it('preserves BOM, CRLF, and permissions while applying deduplicated snapshot ranges', async () => {
    const path = join(directory, 'mode.txt');
    const bytes = Buffer.from('\ufeffone\r\ntwo\r\nthree\r\n', 'utf8');
    await writeFile(path, bytes);
    await chmod(path, 0o640);

    const replacement = { from: anchor(2, 'two'), to: anchor(2, 'two'), content: 'TWO\n' };
    const result = await executeHashlineEdit(
      {
        path: 'mode.txt',
        hash: computeFileTag(bytes),
        edits: [replacement, { from: anchor(3, 'three'), to: anchor(3, 'three'), content: '' }, replacement],
      },
      directory,
      undefined,
    );

    expect(await readFile(path)).toEqual(Buffer.from('\ufeffone\r\nTWO\r\n', 'utf8'));
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(result.content[0].text).toContain('Edited mode.txt (2 ranges). Re-read before editing it again.');
    expect(result.details).toMatchObject({ diff: expect.any(String), patch: expect.any(String), firstChangedLine: 2 });
  });

  it('preserves mixed endings on untouched lines', async () => {
    const path = join(directory, 'mixed.txt');
    const bytes = Buffer.from('a\r\nb\nc\r\n');
    await writeFile(path, bytes);
    await executeHashlineEdit(
      {
        path: 'mixed.txt',
        hash: computeFileTag(bytes),
        edits: [{ from: anchor(3, 'c'), to: anchor(3, 'c'), content: 'C' }],
      },
      directory,
      undefined,
    );
    expect(await readFile(path, 'utf8')).toBe('a\r\nb\nC\r\n');
  });

  it.each([
    ['LF', 'one\ntwo\nthree'],
    ['CRLF', 'one\r\ntwo\r\nthree'],
  ])('deletes a terminal range without adding a newline to %s files', async (_name, original) => {
    const path = join(directory, 'terminal.txt');
    const bytes = Buffer.from(original);
    await writeFile(path, bytes);
    await executeHashlineEdit(
      {
        path: 'terminal.txt',
        hash: computeFileTag(bytes),
        edits: [{ from: anchor(2, 'two'), to: anchor(3, 'three') }],
      },
      directory,
      undefined,
    );
    expect(await readFile(path, 'utf8')).toBe('one');
  });

  it('rejects stale file tags, stale anchors, and overlapping edits without mutation', async () => {
    const path = join(directory, 'safe.txt');
    const original = 'one\ntwo\nthree';
    const bytes = Buffer.from(original);
    await writeFile(path, bytes);

    await expect(
      executeHashlineEdit(
        {
          path: 'safe.txt',
          hash: 'AAAAAAAA',
          edits: [{ from: anchor(1, 'one'), to: anchor(1, 'one'), content: 'ONE' }],
        },
        directory,
        undefined,
      ),
    ).rejects.toThrow('Stale file hash');
    await expect(
      executeHashlineEdit(
        {
          path: 'safe.txt',
          hash: computeFileTag(bytes),
          edits: [{ from: '2#aaa', to: '2#aaa', content: 'TWO' }],
        },
        directory,
        undefined,
      ),
    ).rejects.toThrow('Stale line anchor');
    await expect(
      executeHashlineEdit(
        {
          path: 'safe.txt',
          hash: computeFileTag(bytes),
          edits: [
            { from: anchor(1, 'one'), to: anchor(2, 'two'), content: 'first' },
            { from: anchor(2, 'two'), to: anchor(3, 'three'), content: 'second' },
          ],
        },
        directory,
        undefined,
      ),
    ).rejects.toThrow('Overlapping edit ranges');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('fails closed on invalid UTF-8', async () => {
    const path = join(directory, 'binary.txt');
    const bytes = Buffer.from([0x80, 0x0a, 0x74, 0x77, 0x6f]);
    await writeFile(path, bytes);
    await expect(
      executeHashlineEdit(
        {
          path: 'binary.txt',
          hash: computeFileTag(bytes),
          edits: [{ from: anchor(2, 'two'), to: anchor(2, 'two'), content: 'TWO' }],
        },
        directory,
        undefined,
      ),
    ).rejects.toThrow('not valid UTF-8');
    expect(await readFile(path)).toEqual(bytes);
  });

  it('serializes edits so one snapshot cannot be reused concurrently', async () => {
    const path = join(directory, 'queued.txt');
    const bytes = Buffer.from('before');
    await writeFile(path, bytes);
    const params = {
      path: 'queued.txt',
      hash: computeFileTag(bytes),
      edits: [{ from: anchor(1, 'before'), to: anchor(1, 'before'), content: 'after' }],
    };
    const results = await Promise.allSettled([
      executeHashlineEdit(params, directory, undefined),
      executeHashlineEdit(params, directory, undefined),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe('after');
  });
});
