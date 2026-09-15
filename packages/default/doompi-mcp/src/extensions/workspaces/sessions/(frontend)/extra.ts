import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { McpSessionAuthSection } from '../../../../web/components/McpSessionAuthSection';
import { McpToolMessage } from '../../../../web/components/McpToolMessage';
import { matchMcpTool } from '../../../../web/lib/mcpToolMatch';
export default {
  contextSections: [{ id: 'session-auth', component: McpSessionAuthSection }],
  toolRenderers: [
    { tools: [], matches: (toolName, statuses) => matchMcpTool(toolName, statuses) !== null, message: McpToolMessage },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
