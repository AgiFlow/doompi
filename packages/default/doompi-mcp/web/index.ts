import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { McpCall, McpResult } from './McpToolCard.tsx';
import { matchMcpTool, rememberMcpStatuses } from './mcpToolMatch.ts';

/**
 * This package's cockpit presence: timeline cards for MCP tool calls, the web
 * half of src/tui/mcpToolRender.ts. MCP tools are named `<server>_<tool>` at
 * runtime, so nothing is claimed by name; the session publishes its server
 * names as the 'doom-mcp' footer status and the matcher claims every call
 * carrying one of them as a prefix.
 */
export const webPlugin = defineWebPlugin({
  id: 'mcp',
  toolRenderers: [
    {
      tools: [],
      matches(toolName, statuses) {
        // Remembered for the card, which is rendered without the statuses.
        rememberMcpStatuses(statuses);
        return matchMcpTool(toolName, statuses) !== null;
      },
      call: McpCall,
      result: McpResult,
    },
  ],
});
