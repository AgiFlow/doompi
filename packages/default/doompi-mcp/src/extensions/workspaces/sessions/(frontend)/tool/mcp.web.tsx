import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { McpToolMessage } from './_components/McpToolMessage';
import { matchMcpTool } from './_lib/mcpToolMatch';
export default defineToolRenderer({
  tools: [],
  matches: (toolName, statuses) => matchMcpTool(toolName, statuses) !== null,
  message: McpToolMessage,
});
