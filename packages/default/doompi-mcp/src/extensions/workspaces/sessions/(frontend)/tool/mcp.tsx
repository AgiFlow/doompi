import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { McpToolMessage } from '../../../../../web/components/McpToolMessage';
import { matchMcpTool } from '../../../../../web/lib/mcpToolMatch';
export default defineToolRenderer({
  tools: [],
  matches: (toolName, statuses) => matchMcpTool(toolName, statuses) !== null,
  message: McpToolMessage,
});
