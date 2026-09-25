import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it } from 'vitest';

import { mcp } from '../generated/mcp';

describe('Config MCP widget contributions', () => {
  it('binds each tool to its own package-owned component and leaves UI resource composition to sync', async () => {
    const scope = typeof mcp.session === 'function' ? await mcp.session({} as DoomMcpPluginContext) : mcp.session;
    expect(scope.tools?.map((tool) => [tool.name, tool._meta?.['doompi/widget']])).toEqual([
      ['load_context', '@agimon-ai/doompi-config/load_context'],
      ['show_session', '@agimon-ai/doompi-config/show_session'],
    ]);
    expect(scope.uiResources ?? []).toEqual([]);
    expect(scope.tools?.find((tool) => tool.name === 'show_session')?._meta?.ui?.visibility).toEqual(['model', 'app']);
    expect(scope.tools?.find((tool) => tool.name === 'load_context')?._meta?.ui).toBeUndefined();
  });
});
