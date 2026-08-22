import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLine } from '@agimon-ai/doompi-hashline';
import { computeFileTag } from '@agimon-ai/doompi-hashline/files';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNotAborted,
  createTaggedReadResult,
  isImageRead,
  registerHashlineReadTool,
} from '../src/adapters/pi/readTool.ts';

interface CapturedTool {
  readonly name: string;
  readonly parameters: unknown;
  readonly renderShell?: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<AgentToolResult<unknown>>;
  renderCall?(
    args: Record<string, unknown>,
    theme: { fg(color: string, value: string): string; bold(value: string): string },
    context: Record<string, unknown>,
  ): { render(width: number): string[] };
}

let directory = '';
let tool: CapturedTool | undefined;
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

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-read-'));
  tool = undefined;
  registerHashlineReadTool({
    registerTool(registered) {
      tool = registered as unknown as CapturedTool;
    },
  } as Pick<ExtensionAPI, 'registerTool'>);
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
  if (!tool) throw new Error('Read tool was not registered');
  return tool.execute('call-1', params, signal, undefined, { cwd: directory, model: undefined });
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

describe('hashline read tool', () => {
  it('registers only read with Doom-owned rendering', () => {
    expect(tool?.name).toBe('read');
    expect(tool?.renderShell).toBe('self');
    expect(tool?.parameters).toBeDefined();
    expect(tool?.renderCall?.({ path: 'a.ts' }, theme, {}).render(80).join('\n')).toContain('READ  a.ts');
    expect(tool?.renderCall?.({ path: 'a.ts', offset: 4, limit: 8 }, theme, {}).render(80).join('\n')).toContain(
      'from 4 · 8 lines',
    );
  });

  it('reads exact-byte tagged text with a final empty anchor and continuation hint', async () => {
    const path = join(directory, 'sample.txt');
    const bytes = Buffer.from('\ufefffirst\r\nsecond\r\n', 'utf8');
    await writeFile(path, bytes);

    const output = text(await execute({ path: 'sample.txt', limit: 2 }));
    expect(output.match(/^@file /gmu)).toHaveLength(1);
    expect(output).toContain(`@file sample.txt#${computeFileTag(bytes)}`);
    expect(output).toMatch(/^1#[a-z]{3}\|first$/mu);
    expect(output).toMatch(/^2#[a-z]{3}\|second$/mu);
    expect(output).not.toContain('\r');
    expect(output).toContain('1 more lines in file. Use offset=3');

    expect(text(await execute({ path: 'sample.txt', offset: 3 }))).toMatch(/^3#zyb\|$/mu);
  });

  it('preserves the full-line anchor when compacting one oversized line', async () => {
    const source = 'x'.repeat(60 * 1024);
    await writeFile(join(directory, 'large.txt'), source);

    const output = text(await execute({ path: 'large.txt' }));
    expect(output).toMatch(/^@file large\.txt#[A-Za-z0-9_-]{8}$/mu);
    expect(output).toMatch(/^1#[a-z]{3}\|.*\[truncated\]$/mu);
    expect(output).toContain('shown compactly. Their anchors hash the full original lines');
    expect(output).not.toContain('Use offset=1');
    expect(/^1#([a-z]{3})\|/mu.exec(output)?.[1]).toBe(hashLine(source));
  });

  it('retains line-limit truncation details and rejects offsets past the end', () => {
    const manyLines = Array.from({ length: 2100 }, () => 'x').join('\n');
    const result = createTaggedReadResult(Buffer.from(manyLines), 'many.txt', { path: 'many.txt' });
    expect(result.details?.truncation?.truncatedBy).toBe('lines');
    expect(result.content[0].text).toContain('Use offset=');
    expect(() => createTaggedReadResult(Buffer.from('one'), 'a.ts', { path: 'a.ts', offset: 2 })).toThrow(
      'beyond end of file',
    );
  });

  it('retains native image read attachments', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(directory, 'pixel.png'), png);

    const result = await execute({ path: 'pixel.png' });
    expect(text(result)).toContain('Read image file');
    expect(result.content.some((part) => part.type === 'image')).toBe(true);
  });

  it('returns native Pi text without hashes when the file is not writable', async () => {
    await writeFile(join(directory, 'readonly.ts'), 'const answer = 42;\n');
    registerHashlineReadTool(
      {
        registerTool(registered) {
          tool = registered as unknown as CapturedTool;
        },
      } as Pick<ExtensionAPI, 'registerTool'>,
      async () => false,
    );

    const output = text(await execute({ path: 'readonly.ts' }));
    expect(output).toContain('const answer = 42;');
    expect(output).not.toContain('@file');
    expect(output).not.toMatch(/^\d+#[a-z]{3}\|/mu);
  });

  it('matches Pi path normalization for at-prefixed, literal-at, Unicode-space, and tilde paths', async () => {
    await mkdir(join(directory, '~'), { recursive: true });
    await mkdir(join(directory, 'space name'), { recursive: true });
    await writeFile(join(directory, 'note.txt'), 'normalized');
    await writeFile(join(directory, '@note.txt'), 'one');
    await writeFile(join(directory, 'space name', 'note.txt'), 'spaced');
    await writeFile(join(directory, '~', 'note.txt'), 'two');

    expect(text(await execute({ path: '@note.txt' }))).toMatch(/^@file note\.txt#[A-Za-z0-9_-]{8}$/mu);
    expect(text(await execute({ path: './@note.txt' }))).toMatch(/^@file @note\.txt#[A-Za-z0-9_-]{8}$/mu);
    expect(text(await execute({ path: 'space\u00a0name/note.txt' }))).toMatch(
      /^@file space name\/note\.txt#[A-Za-z0-9_-]{8}$/mu,
    );
    expect(text(await execute({ path: './~/note.txt' }))).toMatch(/^@file \.\/~\/note\.txt#[A-Za-z0-9_-]{8}$/mu);
  });

  it('fails closed on invalid UTF-8 and honors cancellation', async () => {
    await writeFile(join(directory, 'binary.txt'), Buffer.from([0x80, 0x0a, 0x74, 0x77, 0x6f]));
    await expect(execute({ path: 'binary.txt' })).rejects.toThrow('not valid UTF-8');

    const controller = new AbortController();
    controller.abort();
    expect(() => assertNotAborted(controller.signal)).toThrow('Operation aborted');
    expect(() => assertNotAborted(undefined)).not.toThrow();
    await expect(execute({ path: 'binary.txt' }, controller.signal)).rejects.toThrow('Operation aborted');
  });

  it('recognizes both native image result shapes', () => {
    expect(isImageRead([{ type: 'image' }])).toBe(true);
    expect(isImageRead([{ type: 'text', text: 'Read image file [image/png]' }])).toBe(true);
    expect(isImageRead([{ type: 'text', text: 'ordinary text' }])).toBe(false);
  });
});
