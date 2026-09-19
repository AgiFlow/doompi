import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';

import { bindMcpTool } from '../../../../../services/mcpTools';

export default defineMcpTool((context: DoomMcpPluginContext) => bindMcpTool(context, 'computer_exec'));
