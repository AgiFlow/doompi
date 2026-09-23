import { defineMcpTool, type DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';

import { bindMcpTool } from '../../../../../services/mcpTools';

export default defineMcpTool((context: DoomMcpPluginContext) => bindMcpTool(context, 'complete_plan'));
