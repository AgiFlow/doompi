import type { DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';

import { loadContextParameters } from '../../schemas/mcpContextTools';

export function createLoadContextTool(context: DoomMcpPluginContext): DoomHeadlessTool<typeof loadContextParameters> {
  return {
    // web-plugin-tool-renderers: ignore load_context (remote MCP only)
    name: 'load_context',
    label: 'Load context',
    description:
      'Call at the beginning of a session, and after changing profile or modes, to load repository instructions and current session context.',
    parameters: loadContextParameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute() {
      const snapshot = context.loadContext();
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], structuredContent: { ...snapshot } };
    },
  };
}
