import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { McpToolMessage } from './_components/McpToolMessage';
import { matchMcpTool, mcpIdentityFromDetails } from './_lib/mcpToolMatch';
export default defineToolRenderer({
  tools: [],
  matches: (toolName, statuses, details) =>
    mcpIdentityFromDetails(details) !== null || matchMcpTool(toolName, statuses) !== null,
  message: McpToolMessage,
});
