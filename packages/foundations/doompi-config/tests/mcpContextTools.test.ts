import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { describe, expect, it } from 'vitest';

import { createLoadContextTool } from '../src/services/mcpContextTools';

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
    await expect(tool.execute('call', {}, undefined, undefined, {} as never)).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify(snapshot) }],
    });
  });
});
