import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFileTag } from '@agimon-ai/doompi-hashline/files';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readServerFacet } from '../src/extensions/server';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'doompi-read-headless-'));
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

describe('read server facet', () => {
  it('registers the headless read tool and returns hashline metadata', async () => {
    const dispose = vi.fn();
    let tool: DoomHeadlessTool | undefined;
    const registerTool = vi.fn((registered: DoomHeadlessTool) => {
      tool = registered;
      return { dispose };
    });
    const host = { registerTool } as unknown as DoomHeadlessHostService;
    const cleanup = await readServerFacet.apply(contextFor(host));

    expect(registerTool).toHaveBeenCalledOnce();
    expect(tool?.name).toBe('read');
    if (!tool) throw new Error('Read headless tool was not registered');

    const bytes = Buffer.from('one\ntwo\n');
    await writeFile(join(directory, 'sample.txt'), bytes);
    const result = await tool.execute('read-1', { path: 'sample.txt' }, undefined, undefined, execution());

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain(`@file sample.txt#${computeFileTag(bytes)}`);
    expect(text).toMatch(/^1#[a-z]{3}\|one$/mu);
    expect(text).toMatch(/^2#[a-z]{3}\|two$/mu);
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
