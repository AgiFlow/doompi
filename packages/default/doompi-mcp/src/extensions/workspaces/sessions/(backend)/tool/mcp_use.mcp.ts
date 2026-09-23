import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { bindMcpHeadlessTool } from '../../../../../services/mcpHeadlessTools';

export default defineMcpTool((context: DoomMcpPluginContext) => bindMcpHeadlessTool(context, 'mcp_use'));
