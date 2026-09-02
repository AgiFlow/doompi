import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { McpRepositorySettingsPanel } from './McpRepositorySettingsPanel.tsx';
import { McpToolMessage } from './McpToolMessage.tsx';
import { matchMcpTool } from './mcpToolMatch.ts';

/**
 * This package's cockpit presence: timeline cards for MCP tool calls, the web
 * half of src/tui/mcpToolRender.ts. MCP tools are named `<server>_<tool>` at
 * runtime, so nothing is claimed by name; the session publishes its server
 * names as the 'doom-mcp' footer status and the matcher claims every call
 * carrying one of them as a prefix.
 */
export const webPlugin = defineWebPlugin({
  id: 'mcp',
  repositorySettingsPanel: {
    label: 'MCP servers',
    detail: 'inspect cached capabilities, discover live servers, and complete OAuth authorization.',
    order: 100,
    component: McpRepositorySettingsPanel,
  },
  toolRenderers: [
    {
      tools: [],
      matches: (toolName, statuses) => matchMcpTool(toolName, statuses) !== null,
      message: McpToolMessage,
    },
  ],
});
