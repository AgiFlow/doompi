import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { computeFileTag } from '@agimon-ai/doompi-hashline/files';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { rgPath } from '@vscode/ripgrep';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerHashlineGrepTool } from '../src/adapters/pi/grepTool.ts';

interface CapturedTool {
  readonly name: string;
  readonly renderShell?: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<AgentToolResult<unknown>>;
}

let directory = '';
let tool: CapturedTool | undefined;

const originalPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = `${dirname(rgPath)}${delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-grep-'));
  tool = undefined;
  registerHashlineGrepTool({
    registerTool(definition) {
      tool = definition as unknown as CapturedTool;
    },
  } as Pick<ExtensionAPI, 'registerTool'>);
});

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function execute(params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  if (!tool) throw new Error('grep was not registered');
  return tool.execute('call-1', params, undefined, undefined, { cwd: directory, model: undefined });
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

describe('hashline grep execution', () => {
  it('registers only grep with a self-rendered shell', () => {
    expect(tool?.name).toBe('grep');
    expect(tool?.renderShell).toBe('self');
  });

  it('delegates search semantics to Pi and tags matches and context lines', async () => {
    await mkdir(join(directory, 'src'));
    const bytes = Buffer.from('before\nNeedle here\nafter\n', 'utf8');
    await writeFile(join(directory, 'src', 'sample.ts'), bytes);

    const output = text(await execute({ pattern: 'needle', path: 'src', literal: true, ignoreCase: true, context: 1 }));

    expect(output).toContain(`@file src/sample.ts#${computeFileTag(bytes)}`);
    expect(output).toMatch(/^   1#[a-z]{3}\|before$/mu);
    expect(output).toMatch(/^>> 2#[a-z]{3}\|Needle here$/mu);
    expect(output).toMatch(/^   3#[a-z]{3}\|after$/mu);
  });

  it('matches Pi path normalization during hashline post-processing', async () => {
    await mkdir(join(directory, 'space name'));
    await writeFile(join(directory, 'space name', 'sample.txt'), 'needle');

    const atPrefixed = text(await execute({ pattern: 'needle', path: '@space name', literal: true }));
    const unicodeSpace = text(await execute({ pattern: 'needle', path: 'space\u00a0name', literal: true }));

    expect(atPrefixed).toMatch(/^@file space name\/sample\.txt#[A-Za-z0-9_-]{8}$/mu);
    expect(unicodeSpace).toMatch(/^@file space name\/sample\.txt#[A-Za-z0-9_-]{8}$/mu);
  });

  it('tags only writable files while preserving native output for other matches', async () => {
    await writeFile(join(directory, 'writable.txt'), 'needle writable');
    await writeFile(join(directory, 'readonly.txt'), 'needle readonly');
    registerHashlineGrepTool(
      {
        registerTool(definition) {
          tool = definition as unknown as CapturedTool;
        },
      } as Pick<ExtensionAPI, 'registerTool'>,
      async (path) => path.endsWith('writable.txt'),
    );

    const output = text(await execute({ pattern: 'needle', path: '.', literal: true }));
    expect(output).toMatch(/^@file writable\.txt#[A-Za-z0-9_-]{8}$/mu);
    expect(output).toMatch(/^>> 1#[a-z]{3}\|needle writable$/mu);
    expect(output).toContain('readonly.txt:1: needle readonly');
    expect(output).not.toMatch(/^@file readonly\.txt#/mu);
  });

  it('preserves Pi no-match behavior', async () => {
    await writeFile(join(directory, 'a.txt'), 'present');
    expect(text(await execute({ pattern: 'missing', path: '.', literal: true }))).toBe('No matches found');
  });

  it('resolves the longest existing filename when it contains a grep delimiter', async () => {
    await writeFile(join(directory, 'foo'), 'unrelated');
    const filename = 'foo:42: bar.txt';
    const bytes = Buffer.from('needle :42: content', 'utf8');
    await writeFile(join(directory, filename), bytes);

    const output = text(await execute({ pattern: 'needle', path: '.', literal: true }));

    expect(output).toContain(`@file ${filename}#${computeFileTag(bytes)}`);
    expect(output).toMatch(/^>> 1#[a-z]{3}\|needle :42: content$/mu);
    expect(output).not.toMatch(/^@file foo#/mu);
  });
});
