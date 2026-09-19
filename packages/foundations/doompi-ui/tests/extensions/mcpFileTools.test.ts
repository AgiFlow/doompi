import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { createFindTool, createLsTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import find from '../../src/extensions/workspaces/sessions/(backend)/tool/find.mcp';
import ls from '../../src/extensions/workspaces/sessions/(backend)/tool/ls.mcp';
import write from '../../src/extensions/workspaces/sessions/(backend)/tool/write.mcp';

let cwd: string;
let context: DoomMcpPluginContext;
let lifetime: AbortController;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'doompi-mcp-files-'));
  lifetime = new AbortController();
  context = {
    execution: { cwd },
    services: {
      get: vi.fn(() => {
        throw new Error('No local registrations required');
      }),
    },
    signal: lifetime.signal,
  } as unknown as DoomMcpPluginContext;
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('explicit MCP file tools', () => {
  it.each([
    ['write', write, createWriteTool],
    ['find', find, createFindTool],
    ['ls', ls, createLsTool],
  ] as const)(
    'preserves native %s metadata without reading local registrations',
    (name, declaration, nativeFactory) => {
      if (typeof declaration !== 'function') throw new Error('Expected an MCP factory');
      const tool = declaration(context);
      const native = nativeFactory(cwd);
      expect(tool.name).toBe(name);
      expect(tool.parameters).toBe(native.parameters);
      expect(tool.description).toBe(native.description);
      expect(tool.executionMode).toBe(native.executionMode === 'sequential' ? 'serial' : native.executionMode);
      expect(context.services.get).not.toHaveBeenCalled();
      expect(tool).not.toHaveProperty('register');
      expect(tool).not.toHaveProperty('renderCall');
    },
  );

  it('writes and lists relative to the admitted session directory', async () => {
    if (typeof write !== 'function' || typeof ls !== 'function') throw new Error('Expected MCP factories');
    await write(context).execute(
      'write',
      { path: 'nested/file.txt', content: 'hello' },
      undefined,
      undefined,
      context.execution,
    );
    expect(await readFile(path.join(cwd, 'nested/file.txt'), 'utf8')).toBe('hello');
    const result = await ls(context).execute('ls', { path: 'nested' }, undefined, undefined, context.execution);
    expect(result.content).toEqual([{ type: 'text', text: 'file.txt' }]);
  });

  it('preserves native listing limits and errors', async () => {
    if (typeof ls !== 'function') throw new Error('Expected an MCP factory');
    await writeFile(path.join(cwd, 'a.txt'), 'a');
    await writeFile(path.join(cwd, 'b.txt'), 'b');
    const result = await ls(context).execute('ls', { limit: 1 }, undefined, undefined, context.execution);
    expect(result.details).toMatchObject({ entryLimitReached: 1 });
    await expect(
      ls(context).execute('ls', { path: 'missing' }, undefined, undefined, context.execution),
    ).rejects.toThrow();
  });

  it.each(['lifetime', 'request'] as const)('honors %s cancellation without writing', async (source) => {
    if (typeof write !== 'function') throw new Error('Expected an MCP factory');
    const request = new AbortController();
    (source === 'lifetime' ? lifetime : request).abort();
    await expect(
      write(context).execute(
        'write',
        { path: 'cancelled.txt', content: 'no' },
        request.signal,
        undefined,
        context.execution,
      ),
    ).rejects.toThrow(/abort/i);
    await expect(readFile(path.join(cwd, 'cancelled.txt'))).rejects.toThrow();
  });
});
