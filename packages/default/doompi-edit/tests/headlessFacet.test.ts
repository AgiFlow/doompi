import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLine } from '@agimon-ai/doompi-hashline';
import { computeFileTag } from '@agimon-ai/doompi-hashline/files';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editServerFacet } from '../src/extensions/server';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-edit-headless-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
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

describe('edit server facet', () => {
  it('registers the headless edit tool and applies an anchored edit', async () => {
    const dispose = vi.fn();
    let tool: DoomHeadlessTool | undefined;
    const registerTool = vi.fn((registered: DoomHeadlessTool) => {
      tool = registered;
      return { dispose };
    });
    const host = { registerTool } as unknown as DoomHeadlessHostService;
    const cleanup = await editServerFacet.apply(contextFor(host));

    expect(registerTool).toHaveBeenCalledOnce();
    expect(tool?.name).toBe('edit');
    if (!tool) throw new Error('Edit headless tool was not registered');

    const original = 'one\ntwo\n';
    await writeFile(join(directory, 'sample.txt'), original);
    const result = await tool.execute(
      'edit-1',
      {
        path: 'sample.txt',
        hash: computeFileTag(Buffer.from(original)),
        edits: [{ from: `2#${hashLine('two')}`, to: `2#${hashLine('two')}`, content: 'TWO' }],
      },
      undefined,
      undefined,
      execution(),
    );

    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Edited sample.txt') });
    expect(await readFile(join(directory, 'sample.txt'), 'utf8')).toBe('one\nTWO\n');
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
