import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grepServerFacet } from '../src/extensions/server';

const originalPath = process.env.PATH;
let directory: string;

beforeEach(async () => {
  process.env.PATH = `${dirname(rgPath)}${delimiter}${originalPath ?? ''}`;
  directory = await mkdtemp(join(tmpdir(), 'doompi-grep-headless-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function contextFor(host: DoomHeadlessHostService): Context {
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  return context;
}

function execution(): DoomHeadlessExecutionContext {
  return { cwd: directory } as unknown as DoomHeadlessExecutionContext;
}

describe('grep server facet', () => {
  it('registers the headless grep tool and returns a native match', async () => {
    const dispose = vi.fn();
    let tool: DoomHeadlessTool | undefined;
    const registerTool = vi.fn((registered: DoomHeadlessTool) => {
      tool = registered;
      return { dispose };
    });
    const host = { registerTool } as unknown as DoomHeadlessHostService;
    const cleanup = await grepServerFacet.apply(contextFor(host));

    expect(registerTool).toHaveBeenCalledOnce();
    expect(tool?.name).toBe('grep');
    if (!tool) throw new Error('Grep headless tool was not registered');

    const bytes = Buffer.from('before\nneedle here\nafter\n');
    await writeFile(join(directory, 'sample.txt'), bytes);
    const result = await tool.execute(
      'grep-1',
      { pattern: 'needle', path: 'sample.txt', literal: true },
      undefined,
      undefined,
      execution(),
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBe('sample.txt:2:needle here');
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('executes a headless search with no matches', async () => {
    const dispose = vi.fn();
    let tool: DoomHeadlessTool | undefined;
    const registerTool = vi.fn((registered: DoomHeadlessTool) => {
      tool = registered;
      return { dispose };
    });
    const cleanup = await grepServerFacet.apply(contextFor({ registerTool } as unknown as DoomHeadlessHostService));
    if (!tool) throw new Error('Grep headless tool was not registered');

    await writeFile(join(directory, 'sample.txt'), 'present\n');
    const result = await tool.execute(
      'grep-2',
      { pattern: 'missing', path: 'sample.txt' },
      undefined,
      undefined,
      execution(),
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toBe('No matches found');
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('forwards optional search controls and enforces the native match limit', async () => {
    const dispose = vi.fn();
    let tool: DoomHeadlessTool | undefined;
    const registerTool = vi.fn((registered: DoomHeadlessTool) => {
      tool = registered;
      return { dispose };
    });
    const cleanup = await grepServerFacet.apply(contextFor({ registerTool } as unknown as DoomHeadlessHostService));
    if (!tool) throw new Error('Grep headless tool was not registered');

    await writeFile(join(directory, 'sample.txt'), 'needle one\nother\nneedle two\n');
    const result = await tool.execute(
      'grep-3',
      {
        pattern: 'needle',
        path: '.',
        glob: '*.txt',
        ignoreCase: true,
        literal: true,
        context: 1,
        limit: 1,
      },
      undefined,
      undefined,
      execution(),
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('sample.txt:1:needle one');
    expect(text).toContain('sample.txt-2-other');
    expect(text).not.toContain('sample.txt:3:needle two');
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
