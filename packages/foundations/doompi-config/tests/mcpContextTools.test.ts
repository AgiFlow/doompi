import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it, vi } from 'vitest';

import { createLoadContextTool, createRenameThreadTool } from '../src/services/mcpContextTools';

describe('createLoadContextTool', () => {
  it('serializes only the host-owned context snapshot', async () => {
    const snapshot = {
      session: { id: 'session', revision: 2 },
      repository: { root: '/repo', cwd: '/repo/app' },
      selection: { profile: 'ponytail', domains: ['development'], majorMode: 'copilot', activeLayers: ['team'] },
      instructions: [{ path: 'AGENTS.md', content: 'Keep it simple.' }],
      persona: 'Lazy senior developer.',
    };
    const context = { loadContext: () => snapshot } as unknown as DoomMcpPluginContext;

    const tool = createLoadContextTool(context);
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    await expect(tool.execute('call', {}, undefined, undefined, {} as never)).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify(snapshot) }],
      structuredContent: snapshot,
    });
  });
});

describe('createRenameThreadTool', () => {
  it('renames the bound session with a trimmed title', async () => {
    const setName = vi.fn(async () => undefined);
    const context = { execution: { session: { setName } } } as unknown as DoomMcpPluginContext;
    const tool = createRenameThreadTool(context);

    await expect(
      tool.execute('call', { title: ' Worktree sync fix ' }, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Renamed thread to "Worktree sync fix".' }],
    });
    expect(setName).toHaveBeenCalledWith('Worktree sync fix');
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it('refuses a whitespace-only title when called directly', async () => {
    const context = { execution: { session: { setName: vi.fn() } } } as unknown as DoomMcpPluginContext;
    const tool = createRenameThreadTool(context);

    await expect(tool.execute('call', { title: '   ' }, undefined, undefined, {} as never)).rejects.toThrow(
      'Thread title cannot be empty.',
    );
  });
});
